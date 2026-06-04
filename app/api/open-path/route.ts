import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { getSession } from "@/lib/auth/session";

/**
 * Opens a local file or folder in the host's File Explorer.
 *
 * This only does anything useful when the Next.js server runs on the same
 * Windows machine as the person clicking — which is the single-user, local
 * deployment Mission Control is built for. Browsers refuse to navigate to
 * `file://` from an http(s) origin, so the only way to make a path link
 * "just open" is to have the server shell out to explorer.exe.
 *
 * Safety: we never go through a shell. `execFile` passes the path as a single
 * argv entry, so there's no command-injection surface from the stored value.
 */

const ok = () => NextResponse.json({ ok: true });
const fail = (message: string, status = 400) =>
  NextResponse.json({ ok: false, error: message }, { status });

export async function POST(request: Request) {
  // Require a logged-in session — this is a privileged "touch the host OS" action.
  const session = await getSession().catch(() => null);
  if (!session) return fail("Not authenticated.", 401);

  if (process.platform !== "win32") {
    return fail("Opening in Explorer only works when Mission Control runs on Windows.", 501);
  }

  let body: { path?: unknown };
  try {
    body = await request.json();
  } catch {
    return fail("Invalid request body.");
  }

  const target = String(body.path || "").trim();
  if (!target) return fail("Path is required.");

  // Reject anything that isn't an absolute Windows / UNC / POSIX path.
  const looksLikePath =
    /^[a-zA-Z]:[\\/]/.test(target) || target.startsWith("\\\\") || target.startsWith("/");
  if (!looksLikePath) return fail("Not a valid absolute path.");

  // Check existence so we can give a friendly message instead of an Explorer error dialog.
  let isDirectory: boolean;
  try {
    const st = await stat(target);
    isDirectory = st.isDirectory();
  } catch {
    return fail(`Path not found: ${target} — is the drive connected?`, 404);
  }

  // Folder → open it. File → open its folder with the file selected.
  // explorer's /select wants the path joined into a single argv token
  // ("/select,C:\…"), and explorer.exe exits non-zero even on success, so a
  // non-zero code here is not a failure — reaching this point means the path
  // exists and was handed off.
  const args = isDirectory ? [target] : [`/select,${target}`];
  try {
    await new Promise<void>((resolve) => {
      execFile("explorer.exe", args, () => resolve());
    });
  } catch {
    return fail("Failed to launch File Explorer.", 500);
  }

  return ok();
}
