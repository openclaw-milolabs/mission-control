import { resolve, dirname, join, relative, sep, basename, extname } from "node:path";
import {
  promises as fsp,
  existsSync,
  statSync,
} from "node:fs";

// Project-root relative, parallel to runtime-artifacts.
export const DOCUMENTS_ROOT = resolve(process.cwd(), "documents");

export type SafeRel = string & { readonly __safeRel: unique symbol };

/**
 * Normalise + validate a user-supplied relative path. Rejects:
 *  - empty strings (caller decides if root is allowed)
 *  - absolute paths
 *  - any `..` segment
 *  - any path that escapes DOCUMENTS_ROOT after resolution
 *  - NULs and control chars
 * Returns a forward-slash-normalised relative path on success.
 */
export function sanitizeRelPath(input: unknown, { allowEmpty = false } = {}): SafeRel {
  if (typeof input !== "string") throw new Error("Path must be a string.");
  let raw = input.replace(/\\/g, "/").trim();
  // Strip leading slashes — we always treat it as relative.
  while (raw.startsWith("/")) raw = raw.slice(1);
  if (!raw) {
    if (allowEmpty) return "" as SafeRel;
    throw new Error("Path is required.");
  }
  if (/[\x00-\x1f]/.test(raw)) throw new Error("Path contains control characters.");
  const parts = raw.split("/").filter(Boolean);
  for (const p of parts) {
    if (p === "..") throw new Error("Path traversal segment '..' is not allowed.");
    if (p === ".") throw new Error("Path segment '.' is not allowed.");
    if (p.includes("\0")) throw new Error("Path contains NUL.");
    if (p.length > 200) throw new Error("Path segment exceeds 200 chars.");
  }
  const normalised = parts.join("/");
  // Resolve against root and re-verify containment.
  const abs = resolve(DOCUMENTS_ROOT, normalised);
  const rel = relative(DOCUMENTS_ROOT, abs);
  if (rel.startsWith("..") || rel.startsWith(sep + "..")) {
    throw new Error("Path escapes documents root.");
  }
  return normalised as SafeRel;
}

export function absFor(rel: SafeRel): string {
  return resolve(DOCUMENTS_ROOT, rel);
}

export async function ensureRoot(): Promise<void> {
  await fsp.mkdir(DOCUMENTS_ROOT, { recursive: true });
}

export function exists(rel: SafeRel): boolean {
  return existsSync(absFor(rel));
}

export async function stat(rel: SafeRel) {
  return fsp.stat(absFor(rel));
}

export async function mkdirRecursive(rel: SafeRel): Promise<void> {
  await fsp.mkdir(absFor(rel), { recursive: true });
}

export async function writeFile(rel: SafeRel, content: string): Promise<void> {
  await fsp.mkdir(dirname(absFor(rel)), { recursive: true });
  await fsp.writeFile(absFor(rel), content, "utf8");
}

export async function readFile(rel: SafeRel): Promise<string> {
  return fsp.readFile(absFor(rel), "utf8");
}

export async function rename(fromRel: SafeRel, toRel: SafeRel): Promise<void> {
  const fromAbs = absFor(fromRel);
  const toAbs = absFor(toRel);
  await fsp.mkdir(dirname(toAbs), { recursive: true });
  await fsp.rename(fromAbs, toAbs);
}

export async function remove(rel: SafeRel): Promise<void> {
  await fsp.rm(absFor(rel), { recursive: true, force: true });
}

export type DirEntry = {
  name: string;
  relativePath: string;
  kind: "file" | "folder";
  sizeBytes: number;
  extension: string | null;
  modifiedAt: string;
};

export async function listDir(rel: SafeRel): Promise<DirEntry[]> {
  const abs = absFor(rel);
  if (!existsSync(abs)) return [];
  const entries = await fsp.readdir(abs, { withFileTypes: true });
  const out: DirEntry[] = [];
  for (const ent of entries) {
    if (ent.name.startsWith(".")) continue; // hide dotfiles
    const childRel = (rel ? `${rel}/${ent.name}` : ent.name);
    const st = statSync(join(abs, ent.name));
    out.push({
      name: ent.name,
      relativePath: childRel,
      kind: ent.isDirectory() ? "folder" : "file",
      sizeBytes: ent.isDirectory() ? 0 : st.size,
      extension: ent.isDirectory() ? null : (extname(ent.name).toLowerCase() || null),
      modifiedAt: st.mtime.toISOString(),
    });
  }
  // Folders first, then files; both alphabetical.
  out.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
  return out;
}

/**
 * Walk the documents root and return every file + folder as a flat list.
 * Used for the sidebar tree and recent-files grid.
 */
export async function walkAll(): Promise<DirEntry[]> {
  await ensureRoot();
  const out: DirEntry[] = [];
  const stack: string[] = [""];
  while (stack.length > 0) {
    const rel = stack.shift()!;
    const children = await listDir(rel as SafeRel);
    for (const child of children) {
      out.push(child);
      if (child.kind === "folder") stack.push(child.relativePath);
    }
  }
  return out;
}

export function baseName(rel: SafeRel): string {
  return basename(rel);
}

export function parentOf(rel: SafeRel): SafeRel {
  const parts = rel.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/") as SafeRel;
}

export function getExtension(rel: SafeRel): string | null {
  return extname(rel).toLowerCase() || null;
}
