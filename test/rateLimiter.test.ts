import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRateLimiter } from "../src/adapters/rateLimiter.js";

/** A fake clock whose sleeps advance time instead of waiting. */
function fakeClock(): {
  now: () => number;
  sleep: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
  sleeps: number[];
} {
  let t = 1_000_000;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms, signal) => {
      if (signal?.aborted) {
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      }
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
  };
}

describe("createRateLimiter", () => {
  it("allows a burst up to capacity, then paces at the refill rate", async () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ capacity: 5, refillPerSecond: 5, now: clock.now, sleep: clock.sleep });

    for (let i = 0; i < 5; i++) await limiter.acquire();
    assert.equal(clock.sleeps.length, 0, "the first five need no wait");
    assert.equal(limiter.available(), 0);

    const start = clock.now();
    for (let i = 0; i < 7; i++) await limiter.acquire();
    // Seven more tokens at 5/s is 1.4 s of refill; every wait is one token's worth.
    assert.equal(clock.sleeps.length, 7);
    for (const ms of clock.sleeps) assert.equal(ms, 200);
    assert.equal(clock.now() - start, 1400);
  });

  it("serves concurrent acquires in order without double-spending a token", async () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ capacity: 2, refillPerSecond: 10, now: clock.now, sleep: clock.sleep });
    const order: number[] = [];
    await Promise.all([1, 2, 3, 4].map((n) => limiter.acquire().then(() => order.push(n))));
    assert.deepEqual(order, [1, 2, 3, 4]);
    // Two came from the bucket, two waited 100 ms each.
    assert.deepEqual(clock.sleeps, [100, 100]);
  });

  it("rejects a waiter whose signal aborts, and keeps serving the next caller", async () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ capacity: 1, refillPerSecond: 1, now: clock.now, sleep: clock.sleep });
    await limiter.acquire();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(limiter.acquire(controller.signal), (error: Error) => error.name === "AbortError");
    await limiter.acquire();
    assert.equal(clock.sleeps.length, 1);
  });
});
