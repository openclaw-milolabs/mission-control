import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import AdmZip from "adm-zip";

const ROOT = "/home/clawdbot/.openclaw";

// ─── Ownership helpers ───────────────────────────────────────────────────────

const PROCESS_UID = process.getuid?.() ?? 0;
const PROCESS_GID = process.getgid?.() ?? 0;

/** Cache uid/gid → name lookups */
const uidNameCache = new Map<number, string>();
const gidNameCache = new Map<number, string>();

function getUidName(uid: number): string {
  // Defensive: uid comes from fs.statSync so it's a number, but resolve via
  // execFileSync's argv (never a shell template) to make string-injection
  // impossible if a future caller passes anything else.
  const cached = uidNameCache.get(uid);
  if (cached !== undefined) return cached;
  try {
    const name = execFileSync("id", ["-nu", String(uid)], { timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    uidNameCache.set(uid, name);
    return name;
  } catch {
    const fallback = String(uid);
    uidNameCache.set(uid, fallback);
    return fallback;
  }
}

function getGidName(gid: number): string {
  const cached = gidNameCache.get(gid);
  if (cached !== undefined) return cached;
  try {
    const entry = execFileSync("getent", ["group", String(gid)], { timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    const name = entry.split(":")[0] || String(gid);
    gidNameCache.set(gid, name);
    return name;
  } catch {
    const fallback = String(gid);
    gidNameCache.set(gid, fallback);
    return fallback;
  }
}

/** Fix ownership to match the running process user if it doesn't match */
function ensureOwnership(filePath: string): void {
  try {
    const stat = fs.statSync(filePath);
    if (stat.uid !== PROCESS_UID || stat.gid !== PROCESS_GID) {
      fs.chownSync(filePath, PROCESS_UID, PROCESS_GID);
    }
  } catch {
    // best effort — may lack permission to chown
  }
}

/** Recursively fix ownership for directories (e.g. after cpSync) */
function ensureOwnershipRecursive(dirPath: string): void {
  ensureOwnership(dirPath);
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        ensureOwnershipRecursive(entryPath);
      } else {
        ensureOwnership(entryPath);
      }
    }
  } catch {
    // best effort
  }
}
const MAX_PREVIEW_BYTES = 100 * 1024; // 100 KB
const MAX_SAVE_BYTES = 1 * 1024 * 1024; // 1 MB
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB per file

type RouteContext = { params: Promise<{ path?: string[] | undefined }> };

// ─── Safety ──────────────────────────────────────────────────────────────────

function resolveSafe(id: string): string {
  if (id === "/" || id === "") return ROOT;
  const cleaned = id.startsWith("/") ? id.slice(1) : id;
  const resolved = path.resolve(ROOT, cleaned);
  if (resolved !== ROOT && !resolved.startsWith(ROOT + path.sep)) {
    throw new Error("Access denied");
  }
  return resolved;
}

/** Reject names that could cause path traversal or filesystem issues */
function validateName(name: string): string | null {
  if (!name || name.length > 255) return "Invalid name length";
  if (name === "." || name === "..") return "Reserved name";
  if (/[\x00/\\]/.test(name)) return "Name contains invalid characters";
  return null;
}

/** Paths that should never be deleted/renamed/moved */
const PROTECTED_PATHS = new Set([
  "/",
  "/openclaw.json",
  "/workspace",
  "/agents",
  "/credentials",
]);

function isProtected(id: string): boolean {
  return PROTECTED_PATHS.has(id);
}

// ─── File item ───────────────────────────────────────────────────────────────

type FileItem = {
  id: string;
  name: string;
  type: "file" | "folder";
  size: number;
  modified: string;
  created: string;
  accessed: string;
  permissions: string;
  owner: string;
  group: string;
  ownerMismatch: boolean;
};

function toItem(filePath: string, id: string): FileItem | null {
  try {
    const stat = fs.statSync(filePath);
    const isDir = stat.isDirectory();
    const effectiveMtime = isDir
      ? getEffectiveMtime(filePath, 0, { n: 0 })
      : stat.mtime;
    return {
      id,
      name: path.basename(filePath),
      type: isDir ? "folder" : "file",
      size: stat.isFile() ? stat.size : 0,
      modified: effectiveMtime.toISOString(),
      created: stat.birthtime.toISOString(),
      accessed: stat.atime.toISOString(),
      permissions: "0" + (stat.mode & 0o777).toString(8),
      owner: getUidName(stat.uid),
      group: getGidName(stat.gid),
      ownerMismatch: stat.uid !== PROCESS_UID || stat.gid !== PROCESS_GID,
    };
  } catch {
    try {
      const lstat = fs.lstatSync(filePath);
      return {
        id,
        name: path.basename(filePath),
        type: lstat.isDirectory() ? "folder" : "file",
        size: 0,
        modified: lstat.mtime.toISOString(),
        created: lstat.birthtime.toISOString(),
        accessed: lstat.atime.toISOString(),
        permissions: "0" + (lstat.mode & 0o777).toString(8),
        owner: getUidName(lstat.uid),
        group: getGidName(lstat.gid),
        ownerMismatch: lstat.uid !== PROCESS_UID || lstat.gid !== PROCESS_GID,
      };
    } catch {
      return null;
    }
  }
}

const MAX_SEARCH_RESULTS = 200;
const MAX_SEARCH_DEPTH = 12;

function searchRecursive(
  dir: string,
  dirId: string,
  query: string,
  results: FileItem[],
  depth: number,
): void {
  if (depth > MAX_SEARCH_DEPTH || results.length >= MAX_SEARCH_RESULTS) return;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (results.length >= MAX_SEARCH_RESULTS) return;

    const entryId = (dirId === "/" ? "" : dirId) + "/" + entry.name;
    const entryPath = path.join(dir, entry.name);

    if (entry.name.toLowerCase().includes(query)) {
      const item = toItem(entryPath, entryId);
      if (item) results.push(item);
    }

    if (entry.isDirectory()) {
      searchRecursive(entryPath, entryId, query, results, depth + 1);
    }
  }
}

// ─── Dir size calculation ────────────────────────────────────────────────────

const MAX_DIRSIZE_DEPTH = 10;
const MAX_DIRSIZE_FILES = 10000;

type DirSizeResult = {
  size: number;
  fileCount: number;
  folderCount: number;
  scanned: number;
};

function calcDirSize(dir: string, depth: number, result: DirSizeResult): void {
  if (depth > MAX_DIRSIZE_DEPTH || result.scanned >= MAX_DIRSIZE_FILES) return;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (result.scanned >= MAX_DIRSIZE_FILES) return;
    result.scanned++;

    const entryPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      result.folderCount++;
      calcDirSize(entryPath, depth + 1, result);
    } else {
      try {
        const stat = fs.statSync(entryPath);
        result.size += stat.size;
        result.fileCount++;
      } catch {
        result.fileCount++;
      }
    }
  }
}

// ─── Effective mtime (Windows-style bubble-up) ───────────────────────────────

const EFFECTIVE_MTIME_MAX_DEPTH = 6;
const EFFECTIVE_MTIME_MAX_ENTRIES = 800;

/**
 * Returns the newest mtime found anywhere inside a directory tree (up to depth/
 * entry limits). Mirrors Windows Explorer behaviour where a folder's "Date
 * modified" reflects the most-recently-changed file inside it rather than the
 * raw directory mtime.
 */
function getEffectiveMtime(dirPath: string, depth: number, counter: { n: number }): Date {
  let newest: Date;
  try {
    newest = fs.statSync(dirPath).mtime;
  } catch {
    return new Date(0);
  }

  if (depth >= EFFECTIVE_MTIME_MAX_DEPTH || counter.n >= EFFECTIVE_MTIME_MAX_ENTRIES) {
    return newest;
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return newest;
  }

  for (const entry of entries) {
    if (counter.n >= EFFECTIVE_MTIME_MAX_ENTRIES) break;
    counter.n++;
    const entryPath = path.join(dirPath, entry.name);
    try {
      const stat = fs.statSync(entryPath);
      if (stat.mtime > newest) newest = stat.mtime;
      if (entry.isDirectory()) {
        const sub = getEffectiveMtime(entryPath, depth + 1, counter);
        if (sub > newest) newest = sub;
      }
    } catch {
      // inaccessible entry — skip
    }
  }
  return newest;
}

function sortItems(items: FileItem[]): FileItem[] {
  return items.sort((a, b) => {
    if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function dedupName(dir: string, name: string): string {
  const target = path.join(dir, name);
  if (!fs.existsSync(target)) return name;

  const ext = path.extname(name);
  const base = ext ? name.slice(0, -ext.length) : name;

  const firstTry = `${base} (copy)${ext}`;
  if (!fs.existsSync(path.join(dir, firstTry))) return firstTry;

  for (let i = 2; i < 100; i++) {
    const candidate = `${base} (copy ${i})${ext}`;
    if (!fs.existsSync(path.join(dir, candidate))) return candidate;
  }
  return `${base} (copy ${Date.now()})${ext}`;
}

// ─── Response helpers ────────────────────────────────────────────────────────

function ok(data: Record<string, unknown> = {}): NextResponse {
  return NextResponse.json({ ok: true, ...data });
}

function err(message: string, status = 400): NextResponse {
  return NextResponse.json({ ok: false, error: message }, { status });
}

/** RFC 5987 encode for Content-Disposition filenames */
function encodeFilename(name: string): string {
  const ascii = /^[\x20-\x7E]+$/.test(name);
  if (ascii && !name.includes('"')) {
    return `filename="${name}"`;
  }
  const encoded = encodeURIComponent(name).replace(/'/g, "%27");
  return `filename="download"; filename*=UTF-8''${encoded}`;
}

// ─── MIME map ────────────────────────────────────────────────────────────────

const MIME_MAP: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".ico": "image/x-icon", ".bmp": "image/bmp",
  ".pdf": "application/pdf",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg",
  ".mp4": "video/mp4", ".webm": "video/webm",
};

// ─── GET ─────────────────────────────────────────────────────────────────────

export async function GET(
  request: NextRequest,
  { params }: RouteContext,
): Promise<NextResponse> {
  try {
    const { searchParams } = request.nextUrl;

    // Download file
    if (searchParams.get("download") === "true") {
      const id = searchParams.get("id");
      if (!id) return err("Missing id");
      const resolved = resolveSafe(id);
      if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
        return err("Not a file", 404);
      }
      const buf = fs.readFileSync(resolved);
      return new NextResponse(buf, {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; ${encodeFilename(path.basename(resolved))}`,
          "Content-Length": String(buf.length),
        },
      });
    }

    // Serve file inline (images, pdf, etc.)
    if (searchParams.get("serve") === "true") {
      const id = searchParams.get("id");
      if (!id) return err("Missing id");
      const resolved = resolveSafe(id);
      if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
        return err("Not a file", 404);
      }
      const ext = path.extname(resolved).toLowerCase();
      const mime = MIME_MAP[ext] ?? "application/octet-stream";
      const buf = fs.readFileSync(resolved);
      return new NextResponse(buf, {
        headers: {
          "Content-Type": mime,
          "Content-Length": String(buf.length),
          "Cache-Control": "private, max-age=60",
        },
      });
    }

    // Preview text file content
    if (searchParams.get("preview") === "true") {
      const id = searchParams.get("id");
      if (!id) return err("Missing id");
      const resolved = resolveSafe(id);
      if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
        return err("Not a file", 404);
      }
      const stat = fs.statSync(resolved);
      const size = Math.min(stat.size, MAX_PREVIEW_BYTES);
      let content: string;
      let fd: number | null = null;
      try {
        fd = fs.openSync(resolved, "r");
        const buf = Buffer.alloc(size);
        fs.readSync(fd, buf, 0, size, 0);
        content = buf.toString("utf-8");
        if (stat.size > MAX_PREVIEW_BYTES) {
          content += "\n\n--- truncated at 100 KB ---";
        }
      } finally {
        if (fd !== null) fs.closeSync(fd);
      }
      return ok({ content });
    }

    // Directory size calculation
    if (searchParams.get("dirsize") === "true") {
      const id = searchParams.get("id");
      if (!id) return err("Missing id");
      const resolved = resolveSafe(id);
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
        return err("Not a directory", 400);
      }
      const result: DirSizeResult = { size: 0, fileCount: 0, folderCount: 0, scanned: 0 };
      calcDirSize(resolved, 0, result);
      return ok({ size: result.size, fileCount: result.fileCount, folderCount: result.folderCount });
    }

    // Global search
    if (searchParams.get("search")) {
      const query = (searchParams.get("search") ?? "").toLowerCase().trim();
      if (!query) return ok({ items: [] });
      const results: FileItem[] = [];
      searchRecursive(ROOT, "/", query, results, 0);
      return ok({ items: sortItems(results) });
    }

    // List directory
    const { path: segments } = await params;
    let dirId = "/";
    if (segments && segments.length > 0) {
      dirId = "/" + segments.join("/");
    }

    const resolved = resolveSafe(dirId);
    if (!fs.existsSync(resolved)) return err("Not found", 404);
    if (!fs.statSync(resolved).isDirectory()) return err("Not a directory", 400);

    const entries = fs.readdirSync(resolved, { withFileTypes: true });
    const items: FileItem[] = [];
    for (const entry of entries) {
      const entryId = (dirId === "/" ? "" : dirId) + "/" + entry.name;
      const item = toItem(path.join(resolved, entry.name), entryId);
      if (item) items.push(item);
    }

    return ok({ items: sortItems(items) });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    if (msg.includes("Access denied")) return err(msg, 403);
    if (msg.includes("ENOENT")) return err("Not found", 404);
    return err(msg, 500);
  }
}

// ─── POST (create + upload) ─────────────────────────────────────────────────

export async function POST(
  request: NextRequest,
): Promise<NextResponse> {
  try {
    const { guardAdmin } = await import("@/lib/auth/roles");
    const guard = await guardAdmin();
    if ("error" in guard) return guard.error;
    const contentType = request.headers.get("content-type") ?? "";

    // Multipart upload (and zip extraction)
    if (contentType.includes("multipart/form-data")) {
      const formData = await request.formData();
      const parentId = (formData.get("parentId") as string) || "/";
      const mode = (formData.get("mode") as string) || "upload";
      const onConflict = (formData.get("onConflict") as string) || "";
      const files = formData.getAll("files");

      // ── Zip extraction mode ─────────────────────────────────────────────────
      if (mode === "extract") {
        const parentPath = resolveSafe(parentId);
        if (!fs.existsSync(parentPath) || !fs.statSync(parentPath).isDirectory()) {
          return err("Parent is not a directory");
        }

        let extractedCount = 0;
        for (const file of files) {
          if (!(file instanceof globalThis.File)) continue;
          if (!file.name.toLowerCase().endsWith(".zip")) continue;
          if (file.size > MAX_UPLOAD_BYTES) return err("Zip file too large (max 50 MB)");

          const buf = Buffer.from(await file.arrayBuffer());
          const zip = new AdmZip(buf);
          const entries = zip.getEntries();

          for (const entry of entries) {
            // Sanitise: resolve against parentPath and reject traversal
            const entryName = entry.entryName.replace(/\\/g, "/");
            const destPath = path.resolve(parentPath, entryName);
            if (!destPath.startsWith(parentPath + path.sep) && destPath !== parentPath) continue;
            if (!destPath.startsWith(ROOT)) continue;

            if (entry.isDirectory) {
              fs.mkdirSync(destPath, { recursive: true });
              ensureOwnership(destPath);
            } else {
              fs.mkdirSync(path.dirname(destPath), { recursive: true });
              fs.writeFileSync(destPath, entry.getData());
              ensureOwnership(destPath);
              extractedCount++;
            }
          }
        }

        return ok({ extracted: extractedCount });
      }

      if (files.length === 0) return err("No files provided");

      const parentPath = resolveSafe(parentId);
      if (!fs.existsSync(parentPath) || !fs.statSync(parentPath).isDirectory()) {
        return err("Parent is not a directory");
      }

      // Check for conflicts first (if no resolution provided)
      if (!onConflict) {
        const conflicts: string[] = [];
        for (const file of files) {
          if (!(file instanceof globalThis.File)) continue;
          const dest = path.join(parentPath, file.name);
          if (fs.existsSync(dest)) conflicts.push(file.name);
        }
        if (conflicts.length > 0) {
          return NextResponse.json({ ok: false, conflicts, error: "Name conflict" }, { status: 409 });
        }
      }

      const uploaded: FileItem[] = [];
      for (const file of files) {
        if (!(file instanceof globalThis.File)) continue;
        const nameErr = validateName(file.name);
        if (nameErr) continue;
        if (file.size > MAX_UPLOAD_BYTES) continue;

        let fileName = file.name;
        const destCheck = path.join(parentPath, fileName);
        const destExists = fs.existsSync(destCheck);

        if (destExists) {
          if (onConflict === "skip") continue;
          if (onConflict === "keep-both") {
            fileName = dedupName(parentPath, fileName);
          }
          // "replace" → overwrite in place
        }

        const filePath = path.join(parentPath, fileName);
        if (!filePath.startsWith(ROOT)) continue;

        const buf = Buffer.from(await file.arrayBuffer());
        fs.writeFileSync(filePath, buf);
        ensureOwnership(filePath);

        const newId = (parentId === "/" ? "" : parentId) + "/" + fileName;
        const item = toItem(filePath, newId);
        if (item) uploaded.push(item);
      }

      return ok({ items: uploaded });
    }

    // JSON actions
    const body = await request.json();
    const { action } = body as { action?: string };

    if (action === "create") {
      const { parentId, name, type } = body as {
        parentId?: string;
        name?: string;
        type?: "file" | "folder";
      };
      if (!name) return err("Missing name");
      if (!parentId) return err("Missing parentId");

      const nameErr = validateName(name);
      if (nameErr) return err(nameErr);

      const parentPath = resolveSafe(parentId);
      if (!fs.existsSync(parentPath) || !fs.statSync(parentPath).isDirectory()) {
        return err("Parent is not a directory");
      }

      const newId = (parentId === "/" ? "" : parentId) + "/" + name;
      const newPath = resolveSafe(newId);

      if (fs.existsSync(newPath)) return err("Already exists");

      if (type === "folder") {
        fs.mkdirSync(newPath, { recursive: true });
      } else {
        fs.writeFileSync(newPath, "");
      }
      ensureOwnership(newPath);

      const item = toItem(newPath, newId);
      return ok({ item });
    }

    return err("Unknown action");
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    if (msg.includes("Access denied")) return err(msg, 403);
    return err(msg, 500);
  }
}

// ─── PUT (rename, move, copy, save) ──────────────────────────────────────────

export async function PUT(
  request: NextRequest,
): Promise<NextResponse> {
  try {
    const { guardAdmin } = await import("@/lib/auth/roles");
    const guard = await guardAdmin();
    if ("error" in guard) return guard.error;
    const body = await request.json();
    const { action, id, newName, ids, targetId, content } = body as {
      action?: string;
      id?: string;
      newName?: string;
      ids?: string[];
      targetId?: string;
      content?: string;
    };

    if (action === "save" && id && typeof content === "string") {
      if (content.length > MAX_SAVE_BYTES) return err("Content too large (max 1MB)");
      const resolved = resolveSafe(id);
      if (!fs.existsSync(resolved)) return err("Not found", 404);
      if (fs.statSync(resolved).isDirectory()) return err("Cannot save to a directory");
      if (!resolved.startsWith(ROOT + path.sep)) return err("Access denied", 403);
      fs.writeFileSync(resolved, content, "utf-8");
      ensureOwnership(resolved);
      return ok({});
    }

    if (action === "rename" && id && newName) {
      if (isProtected(id)) return err("Cannot rename protected path", 403);
      const nameErr = validateName(newName);
      if (nameErr) return err(nameErr);

      const oldPath = resolveSafe(id);
      if (!fs.existsSync(oldPath)) return err("Not found", 404);
      const parentDir = path.dirname(oldPath);
      const dest = path.join(parentDir, newName);
      if (!dest.startsWith(ROOT)) return err("Access denied", 403);
      if (fs.existsSync(dest)) return err("A file with that name already exists");
      fs.renameSync(oldPath, dest);
      ensureOwnership(dest);
      const renamedId = "/" + path.relative(ROOT, dest).replace(/\\/g, "/");
      const item = toItem(dest, renamedId);
      return ok({ item });
    }

    if ((action === "move" || action === "copy") && ids && targetId) {
      const { onConflict } = body as { onConflict?: "replace" | "keep-both" | "skip" };
      const targetPath = resolveSafe(targetId);
      if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isDirectory()) {
        return err("Target is not a directory");
      }

      if (action === "move") {
        const blocked = ids.find((i) => isProtected(i));
        if (blocked) return err(`Cannot move protected path: ${blocked}`, 403);
      }

      // Detect conflicts
      const conflicts: string[] = [];
      for (const fileId of ids) {
        const src = resolveSafe(fileId);
        if (!fs.existsSync(src)) continue;
        const rawName = path.basename(src);
        const dest = path.join(targetPath, rawName);
        if (fs.existsSync(dest) && dest !== src) {
          conflicts.push(rawName);
        }
      }

      // If conflicts exist and no resolution provided, return the conflict list
      if (conflicts.length > 0 && !onConflict) {
        return NextResponse.json({ ok: false, conflicts, error: "Name conflict" }, { status: 409 });
      }

      const results: FileItem[] = [];
      for (const fileId of ids) {
        const src = resolveSafe(fileId);
        if (!fs.existsSync(src)) continue;

        if (fs.statSync(src).isDirectory()) {
          const targetAbs = resolveSafe(targetId);
          if (targetAbs === src || targetAbs.startsWith(src + path.sep)) {
            continue;
          }
        }

        const rawName = path.basename(src);
        const dest = path.join(targetPath, rawName);
        if (!dest.startsWith(ROOT)) continue;

        const destExists = fs.existsSync(dest) && dest !== src;

        // Resolve conflict
        let finalDest = dest;
        if (destExists) {
          if (onConflict === "skip") continue;
          if (onConflict === "keep-both") {
            const dedupedName = dedupName(targetPath, rawName);
            finalDest = path.join(targetPath, dedupedName);
          }
          // "replace" → overwrite in place (finalDest stays as dest)
        }

        if (action === "copy") {
          // Remove existing target if replacing
          if (onConflict === "replace" && destExists && fs.existsSync(finalDest)) {
            const destStat = fs.statSync(finalDest);
            if (destStat.isDirectory()) fs.rmSync(finalDest, { recursive: true });
            else fs.unlinkSync(finalDest);
          }
          if (fs.statSync(src).isDirectory()) {
            fs.cpSync(src, finalDest, { recursive: true });
            ensureOwnershipRecursive(finalDest);
          } else {
            fs.copyFileSync(src, finalDest);
            ensureOwnership(finalDest);
          }
        } else {
          // Move
          if (onConflict === "replace" && destExists && fs.existsSync(finalDest)) {
            const destStat = fs.statSync(finalDest);
            if (destStat.isDirectory()) fs.rmSync(finalDest, { recursive: true });
            else fs.unlinkSync(finalDest);
          }
          if (fs.existsSync(finalDest) && finalDest !== src && onConflict !== "replace") continue;
          fs.renameSync(src, finalDest);
          if (fs.statSync(finalDest).isDirectory()) {
            ensureOwnershipRecursive(finalDest);
          } else {
            ensureOwnership(finalDest);
          }
        }
        const newId = "/" + path.relative(ROOT, finalDest).replace(/\\/g, "/");
        const item = toItem(finalDest, newId);
        if (item) results.push(item);
      }
      return ok({ items: results });
    }

    return err("Unknown action");
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    if (msg.includes("Access denied")) return err(msg, 403);
    return err(msg, 500);
  }
}

// ─── DELETE ──────────────────────────────────────────────────────────────────

export async function DELETE(
  request: NextRequest,
): Promise<NextResponse> {
  try {
    const { guardAdmin } = await import("@/lib/auth/roles");
    const guard = await guardAdmin();
    if ("error" in guard) return guard.error;
    const body = await request.json();
    const { ids } = body as { ids?: string[] };

    if (!ids || ids.length === 0) return err("Missing ids");

    const blocked = ids.find((i) => isProtected(i));
    if (blocked) return err(`Cannot delete protected path: ${blocked}`, 403);

    const deleted: string[] = [];
    for (const id of ids) {
      const p = resolveSafe(id);
      if (!fs.existsSync(p)) continue;
      if (p === ROOT) continue;
      const stat = fs.statSync(p);
      if (stat.isDirectory()) {
        fs.rmSync(p, { recursive: true });
      } else {
        fs.unlinkSync(p);
      }
      deleted.push(id);
    }
    return ok({ deleted });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    if (msg.includes("Access denied")) return err(msg, 403);
    return err(msg, 500);
  }
}
