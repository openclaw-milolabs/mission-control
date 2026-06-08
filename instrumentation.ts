/**
 * Next.js instrumentation hook — runs once per server process on startup.
 *
 * The actual crash handlers live in ./instrumentation-node and are imported
 * dynamically ONLY in the Node.js runtime. Keeping process.on/process.exit out
 * of this file stops Turbopack from trying to bundle them into the Edge runtime
 * (which doesn't support those APIs).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation-node");
  }
}
