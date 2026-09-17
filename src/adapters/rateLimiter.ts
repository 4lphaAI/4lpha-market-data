/**
 * Token-bucket rate limiter for upstreams that enforce a per-key request rate.
 *
 * Built for the Binance Web3 API, whose 5 rps ceiling is per key and shared by
 * every endpoint (measured 2026-09-16: two endpoints at 5 rps each got 20 of 40
 * through). One bucket per process is therefore the only shape that matches
 * what the server counts. `acquire` resolves when a token is available and
 * rejects if the caller's signal aborts first, so a timed-out job does not
 * leave waiters queued against the next run.
 *
 * The clock and sleep are injectable so tests can drive the bucket without
 * real time passing.
 */

export interface RateLimiterOptions {
  /** Tokens the bucket holds when full, and the burst it allows. */
  capacity: number;
  /** Tokens added per second. */
  refillPerSecond: number;
  /** Overrides for tests. */
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
}

export interface RateLimiter {
  /** Waits for one token. Rejects with `AbortError` when `signal` aborts first. */
  acquire(signal?: AbortSignal | undefined): Promise<void>;
  /** Tokens currently available, for diagnostics and tests. */
  available(): number;
}

function defaultSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(abortError());
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(): Error {
  const error = new Error("rate limiter wait aborted");
  error.name = "AbortError";
  return error;
}

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  if (!(options.capacity >= 1) || !(options.refillPerSecond > 0)) {
    throw new RangeError("rate limiter needs capacity >= 1 and refillPerSecond > 0");
  }
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? defaultSleep;
  const capacity = options.capacity;
  const refillPerMs = options.refillPerSecond / 1000;

  let tokens = capacity;
  let lastRefill = now();
  // Waiters are served in arrival order; without the chain two concurrent
  // acquires could both see one token and both take it.
  let queue: Promise<void> = Promise.resolve();

  function refill(): void {
    const current = now();
    const elapsed = Math.max(0, current - lastRefill);
    lastRefill = current;
    tokens = Math.min(capacity, tokens + elapsed * refillPerMs);
  }

  async function take(signal: AbortSignal | undefined): Promise<void> {
    for (;;) {
      if (signal?.aborted) throw abortError();
      refill();
      if (tokens >= 1) {
        tokens -= 1;
        return;
      }
      const waitMs = Math.ceil((1 - tokens) / refillPerMs);
      await sleep(waitMs, signal);
    }
  }

  return {
    acquire(signal) {
      const turn = queue.then(() => take(signal));
      // A rejected turn (abort) must not poison the chain for the next caller.
      queue = turn.catch(() => undefined);
      return turn;
    },
    available() {
      refill();
      return Math.floor(tokens);
    },
  };
}
