/**
 * Node.js-only crash handlers, registered on import (see instrumentation.ts).
 *
 * Goal: make crashes VISIBLE and SURVIVABLE.
 *
 *  - Unhandled promise rejections are the most likely cause of "Next.js crashes
 *    during the mobile-apps sync": one store/API call rejecting with no handler
 *    would otherwise terminate the whole Node process. Attaching a listener (a)
 *    logs it with a timestamp + stack to stderr → .runtime/logs/nextjs.log, and
 *    (b) stops Node from hard-crashing on it — the server keeps serving.
 *
 *  - Uncaught exceptions leave the process in an unknown state, so we log and exit;
 *    the mc-services watchdog restarts a clean Next.js within ~30s.
 *
 * Caveat: an OOM kill (SIGKILL / "Aborted (core dumped)") can't be caught here.
 * If the log shows "JavaScript heap out of memory", lower the report lookback /
 * per-file cap, or raise NODE_OPTIONS=--max-old-space-size.
 *
 * This module is only imported in the Node.js runtime, so the Edge bundle never
 * statically includes process.on/process.exit.
 */
const stamp = (kind: string, payload: unknown) => {
  const ts = new Date().toISOString();
  const body = payload instanceof Error ? payload.stack ?? payload.message : String(payload);
  console.error(`\n[mc:fatal] ${kind} @ ${ts}\n${body}\n`);
};

process.on("unhandledRejection", (reason) => {
  // Log loudly but keep serving — a background rejection mid-sync should not take
  // the whole dashboard down.
  stamp("unhandledRejection", reason);
});

process.on("uncaughtException", (err) => {
  stamp("uncaughtException", err);
  // Unsafe to continue in an unknown state — exit cleanly; the watchdog restarts.
  process.exit(1);
});

// Side-effect-only module; this marks it as a module (so it can be dynamically imported).
export {};
