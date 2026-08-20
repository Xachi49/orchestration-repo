export interface WorkerJob {
  name: string;
  run: () => Promise<void>;
}

export interface BoundedWorkerLoopOptions {
  concurrency: number;
  pollIntervalMs: number;
  jitterMs: number;
  isAccepting: () => boolean;
  jobs: readonly WorkerJob[];
  onConflict?: () => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Bounded work acquisition. Roles do not alter domain authority.
 */
export class BoundedWorkerLoop {
  private running = false;
  private inFlight = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  claims = 0;
  skippedBackpressure = 0;

  constructor(private readonly options: BoundedWorkerLoopOptions) {}

  start(): void {
    this.running = true;
    this.schedule(0);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
    }
  }

  get active(): number {
    return this.inFlight;
  }

  async waitIdle(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.inFlight > 0 && Date.now() < deadline) {
      await (this.options.sleep ?? sleep)(10);
    }
  }

  private schedule(delay: number): void {
    this.timer = setTimeout(() => {
      void this.tick();
    }, delay);
  }

  private async tick(): Promise<void> {
    if (!this.running) {
      return;
    }
    if (!this.options.isAccepting()) {
      this.schedule(this.options.pollIntervalMs);
      return;
    }
    let spawned = 0;
    while (
      this.running &&
      this.options.isAccepting() &&
      this.inFlight < this.options.concurrency
    ) {
      this.spawnClaim();
      spawned += 1;
    }
    if (spawned === 0 && this.inFlight >= this.options.concurrency) {
      this.skippedBackpressure += 1;
    }
    const jitter = Math.floor(Math.random() * (this.options.jitterMs + 1));
    this.schedule(this.options.pollIntervalMs + jitter);
  }

  private spawnClaim(): void {
    this.inFlight += 1;
    this.claims += 1;
    void (async () => {
      try {
        for (const job of this.options.jobs) {
          await job.run();
        }
      } catch {
        this.options.onConflict?.();
      } finally {
        this.inFlight -= 1;
      }
    })();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
