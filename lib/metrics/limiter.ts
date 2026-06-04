/**
 * Tiny FIFO concurrency limiter. Pure JS — safe to import on both the server
 * (to cap concurrent external MySQL queries) and the client (to load metric
 * cards in waves instead of all at once).
 *
 * Usage:
 *   const gate = makeLimiter(3);
 *   const result = await gate(() => doExpensiveThing());
 *
 * At most `maxConcurrent` wrapped functions run at a time; the rest queue in
 * arrival order and start as slots free up.
 */
export function makeLimiter(maxConcurrent: number) {
  const max = Math.max(1, maxConcurrent);
  let active = 0;
  const waiters: Array<() => void> = [];

  function acquire(): Promise<void> {
    if (active < max) {
      active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      waiters.push(() => {
        active++;
        resolve();
      });
    });
  }

  function release() {
    active = Math.max(0, active - 1);
    const next = waiters.shift();
    if (next) next();
  }

  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    await acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  };
}
