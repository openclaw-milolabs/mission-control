import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { exists, readFile, sanitizeRelPath, stat } from "@/lib/documents/fs";

export const dynamic = "force-dynamic";

const fail = (message: string, status = 400) =>
  NextResponse.json({ ok: false, error: message }, { status });

/**
 * GET /api/documents/content?path=<rel>
 * Returns file content as text. Binary detection is heuristic — if the file
 * is large or contains a NUL in the first 4KB we refuse and tell the caller
 * to download via the file-manager instead.
 */
export async function GET(request: Request) {
  try {
    const session = await getSession();
    if (!session?.email) return fail("Not authenticated", 401);

    const url = new URL(request.url);
    const path = url.searchParams.get("path");
    if (!path) return fail("path is required.");

    const rel = sanitizeRelPath(path);
    if (!exists(rel)) return fail("File not found.", 404);
    const st = await stat(rel);
    if (!st.isFile()) return fail("Target is not a file.");
    if (st.size > 4 * 1024 * 1024) {
      return fail("File is over 4 MB — open via the file-manager instead.", 413);
    }
    const content = await readFile(rel);
    // Cheap binary heuristic: NUL in first 4KB.
    if (content.slice(0, 4096).includes("\0")) {
      return fail("File appears to be binary.", 415);
    }
    return NextResponse.json({
      ok: true,
      path: rel,
      content,
      sizeBytes: st.size,
      modifiedAt: st.mtime.toISOString(),
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Failed to read document", 500);
  }
}
