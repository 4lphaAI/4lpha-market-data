import type { SnapshotStore } from "./store.js";
import type { JobHealth, JobSpec } from "./types.js";

/** Public surface of the job scheduler. */
export interface Scheduler {
  register(spec: JobSpec): void;
  start(): void;
  stop(): Promise<void>;
  healthSnapshot(): JobHealth[];
}

/** Optional seams, primarily so tests can pin time and jitter. */
export interface SchedulerOptions {
  /** Time source used for health timestamps and latency. */
  now?: () => number;
  /** Returns a value in [0, 1); used to spread jitter. */
  random?: () => number;
}

const MAX_ERROR_CHARS = 300;

class JobTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`timed out after ${timeoutMs}ms`);
    this.name = "JobTimeoutError";
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message !== "") return error.message;
  if (typeof error === "string" && error !== "") return error;
  return "unknown error";
}

interface JobState {
  spec: JobSpec;
  health: JobHealth;
  timer: NodeJS.Timeout | null;
  inFlight: Promise<void> | null;
}

/**
 * Runs each registered job on its own timer. A job is fully isolated: its
 * failures, timeouts and overruns never affect another job or the process.
 */
export function createScheduler(store: SnapshotStore, options: SchedulerOptions = {}): Scheduler {
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const jobs = new Map<string, JobState>();
  let running = false;

  function jitterMs(spec: JobSpec): number {
    const bound = spec.jitterMs ?? 0;
    return bound > 0 ? Math.floor(random() * bound) : 0;
  }

  async function persist(health: JobHealth): Promise<void> {
    try {
      await store.putJobHealth({ ...health });
    } catch (error) {
      // Health persistence is best-effort: losing it must not fail the job.
      console.error(`[scheduler] job=${health.job} health_persist_failed: ${describeError(error)}`);
    }
  }

  async function runWithTimeout(spec: JobSpec): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new JobTimeoutError(spec.timeoutMs));
      }, spec.timeoutMs);
    });
    try {
      // `Promise.race` attaches a rejection handler to the job promise, so a
      // late failure after a timeout cannot become an unhandled rejection.
      await Promise.race([spec.run(), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async function execute(state: JobState): Promise<void> {
    const startedAt = now();
    try {
      await runWithTimeout(state.spec);
      state.health.lastOkAt = now();
      state.health.lastLatencyMs = now() - startedAt;
      state.health.consecutiveFailures = 0;
    } catch (error) {
      state.health.lastErrorAt = now();
      state.health.lastLatencyMs = now() - startedAt;
      state.health.lastError = describeError(error).slice(0, MAX_ERROR_CHARS);
      state.health.consecutiveFailures += 1;
      console.error(`[scheduler] job=${state.spec.name} failed: ${state.health.lastError}`);
    }
    await persist(state.health);
  }

  function schedule(state: JobState, delayMs: number): void {
    if (!running) return;
    const timer = setTimeout(() => {
      tick(state);
    }, delayMs);
    // Timers must not by themselves keep the process alive; the HTTP server does.
    timer.unref();
    state.timer = timer;
  }

  function tick(state: JobState): void {
    state.timer = null;
    // The next tick is armed up front so a slow run cannot stall the cadence.
    schedule(state, state.spec.intervalMs + jitterMs(state.spec));
    if (state.inFlight !== null) {
      console.warn(`[scheduler] job=${state.spec.name} skipped: previous run still in flight`);
      return;
    }
    state.inFlight = execute(state).finally(() => {
      state.inFlight = null;
    });
  }

  return {
    register(spec: JobSpec): void {
      if (jobs.has(spec.name)) {
        throw new Error(`job already registered: ${spec.name}`);
      }
      if (spec.intervalMs <= 0) {
        throw new Error(`job ${spec.name}: intervalMs must be > 0`);
      }
      if (spec.timeoutMs <= 0) {
        throw new Error(`job ${spec.name}: timeoutMs must be > 0`);
      }
      const state: JobState = {
        spec,
        health: {
          job: spec.name,
          lastOkAt: null,
          lastErrorAt: null,
          lastError: null,
          lastLatencyMs: null,
          consecutiveFailures: 0,
        },
        timer: null,
        inFlight: null,
      };
      jobs.set(spec.name, state);
      // Jobs registered after start() join the rotation immediately.
      if (running) schedule(state, jitterMs(spec));
    },

    start(): void {
      if (running) return;
      running = true;
      for (const state of jobs.values()) {
        // The first run happens promptly (jitter only) so status is useful early.
        schedule(state, jitterMs(state.spec));
      }
    },

    async stop(): Promise<void> {
      running = false;
      for (const state of jobs.values()) {
        if (state.timer !== null) {
          clearTimeout(state.timer);
          state.timer = null;
        }
      }
      await Promise.all([...jobs.values()].map((state) => state.inFlight ?? Promise.resolve()));
    },

    healthSnapshot(): JobHealth[] {
      return [...jobs.values()]
        .map((state) => ({ ...state.health }))
        .sort((a, b) => a.job.localeCompare(b.job));
    },
  };
}
