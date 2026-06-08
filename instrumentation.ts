/**
 * Next.js instrumentation hook — runs once per server process on startup.
 *
 * Goal: make crashes VISIBLE and SURVIVABLE.
 *
 *  - Unhandled promise rejections are the most likely cause of "Next.js crashes
 *    during the mobile-apps sync": one store/API call rejecting with no handler
 *    would otherwise terminate the whole Node process. By attaching a listener we
 *    (a) log it with a timestamp + stack to stderr → .runtime/logs/nextjs.log, and
 *    (b) stop Node from hard-crashing on it — the server keeps serving instead of
 *    dying mid-sync. The underlying bug is still surfaced loudly so it can be fixed.
 *
 *  - Uncaught exceptions leave the process in an unknown state, so we log and exit;
 *    the mc-services watchdog restarts a clean Next.js within ~30s.
 *
 * Caveat: an OOM kill (SIGKILL) can't be caught here. If the log shows
 * "JavaScript heap out of memory", raise NODE_OPTIONS=--max-old-space-size=… or
 * lighten the sync (the all-years Play Console CSV scan is the heavy part).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const stamp = (kind: string, payload: unknown) => {
    const ts = new Date().toISOString();
    const body = payload instanceof Error ? payload.stack ?? payload.message : String(payload);
    // stderr is captured into .runtime/logs/nextjs.log by mc-services.sh.
    console.error(`\n[mc:fatal] ${kind} @ ${ts}\n${body}\n`);
  };

  process.on("unhandledRejection", (reason) => {
    // Log loudly but keep serving — a background rejection mid-sync should not
    // take the whole dashboard down.
    stamp("unhandledRejection", reason);
  });

  process.on("uncaughtException", (err) => {
    stamp("uncaughtException", err);
    // Unsafe to continue in an unknown state — exit cleanly; the watchdog restarts.
    process.exit(1);
  });
}
