import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";

/**
 * GET /api/files?path=<absolute path>
 *
 * Serves files from a narrow set of approved roots for ticket-attachment
 * downloads. The roots used to be the whole openclaw home, which included
 * secrets and tokens — now restricted to the project's `documents/`,
 * `runtime-artifacts/`, and `storage/` directories. `/tmp` is kept so the
 * agenda/file-manager-staged downloads still work but is hardened by an
 * extension deny-list.
 */

const PROJECT_ROOT = process.cwd();

// Restrict reachable directories. /home/clawdbot/.openclaw (the parent of
// secrets/, agents/sessions/, etc.) is intentionally NOT here anymore.
const ALLOWED_ROOTS = [
  path.resolve(PROJECT_ROOT, "documents"),
  path.resolve(PROJECT_ROOT, "runtime-artifacts"),
  path.resolve(PROJECT_ROOT, "storage"),
  "/tmp",
];

// Names that should NEVER be served, even from an otherwise-allowed root.
// Most are credential/configuration files that don't belong in attachments.
const DENY_FILE_NAMES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  ".env.development",
  ".env.production.local",
  "secrets.env",
  "openclaw-token",
  "session.json",
  "id_rsa",
  "id_ed25519",
]);

const DENY_PATH_FRAGMENTS = [
  "/.openclaw/secrets/",
  "/.openclaw/agents/",
  "/.ssh/",
  "/.aws/",
  "/.config/openclaw/secrets",
];

const MIME_MAP: Record<string, string> = {
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".json": "application/json",
  ".csv": "text/csv",
  ".html": "text/html",
  ".htm": "text/html",
  ".xml": "application/xml",
  ".yaml": "application/x-yaml",
  ".yml": "application/x-yaml",
  ".toml": "application/toml",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".zip": "application/zip",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
  ".log": "text/plain",
  ".sh": "text/x-shellscript",
  ".ts": "text/typescript",
  ".tsx": "text/typescript",
  ".js": "text/javascript",
  ".jsx": "text/javascript",
  ".css": "text/css",
  ".py": "text/x-python",
  ".rs": "text/x-rust",
  ".go": "text/x-go",
  ".sql": "application/sql",
  ".env": "text/plain",
};

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_MAP[ext] || "application/octet-stream";
}

export function isAllowedAttachmentPath(filePath: string): boolean {
  if (typeof filePath !== "string" || !filePath) return false;
  const resolved = path.resolve(filePath);
  if (resolved.includes("\0")) return false;
  // Reject any segment-based deny match before doing the root check.
  for (const frag of DENY_PATH_FRAGMENTS) {
    if (resolved.includes(frag)) return false;
  }
  const base = path.basename(resolved);
  if (DENY_FILE_NAMES.has(base) || base.toLowerCase().endsWith(".env")) return false;
  return ALLOWED_ROOTS.some((root) => resolved === root || resolved.startsWith(root + path.sep));
}

function isAllowed(filePath: string): boolean {
  return isAllowedAttachmentPath(filePath);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const filePath = request.nextUrl.searchParams.get("path");
  if (!filePath) {
    return NextResponse.json({ ok: false, error: "Missing path parameter" }, { status: 400 });
  }

  const resolved = path.resolve(filePath);

  if (!isAllowed(resolved)) {
    return NextResponse.json({ ok: false, error: "Access denied" }, { status: 403 });
  }

  try {
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) {
      return NextResponse.json({ ok: false, error: "Not a file" }, { status: 400 });
    }

    const buffer = fs.readFileSync(resolved);
    const mimeType = getMimeType(resolved);
    const fileName = path.basename(resolved);
    const forceDownload = request.nextUrl.searchParams.get("download") === "1";

    // Inline rendering only for safe types — never HTML or SVG (script vectors)
    // and never text/javascript / text/css (mime confusion).
    const SAFE_INLINE_TYPES = [
      "image/png", "image/jpeg", "image/gif", "image/webp", "image/x-icon",
      "application/pdf",
      "text/plain", "text/markdown", "text/csv",
    ];
    const safeInline = SAFE_INLINE_TYPES.includes(mimeType);
    const isInline = !forceDownload && safeInline;
    const disposition = isInline
      ? `inline; filename="${fileName}"`
      : `attachment; filename="${fileName}"`;

    return new NextResponse(buffer, {
      status: 200,
      headers: {
        "Content-Type": mimeType,
        "Content-Disposition": disposition,
        "Content-Length": String(buffer.length),
        "Cache-Control": "private, max-age=60",
        // Defense-in-depth: block MIME sniffing and forbid this response from
        // being framed, which neutralises clickjacking on PDF/text previews.
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
        "Referrer-Policy": "no-referrer",
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "File not found";
    if (message.includes("ENOENT")) {
      return NextResponse.json({ ok: false, error: "File not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
