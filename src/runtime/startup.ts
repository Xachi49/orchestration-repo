export const STARTUP_STATES = [
  "CREATED",
  "CONFIG_VALIDATED",
  "DATABASE_CONNECTED",
  "SCHEMA_VERIFIED",
  "RECOVERY_RUNNING",
  "RECOVERY_COMPLETE",
  "SERVICES_READY",
  "ACCEPTING_TRAFFIC",
  "STARTUP_FAILED",
] as const;
export type StartupState = (typeof STARTUP_STATES)[number];

const ALLOWED: Record<StartupState, readonly StartupState[]> = {
  CREATED: ["CONFIG_VALIDATED", "STARTUP_FAILED"],
  CONFIG_VALIDATED: ["DATABASE_CONNECTED", "SERVICES_READY", "STARTUP_FAILED"],
  DATABASE_CONNECTED: ["SCHEMA_VERIFIED", "STARTUP_FAILED"],
  SCHEMA_VERIFIED: ["RECOVERY_RUNNING", "STARTUP_FAILED"],
  RECOVERY_RUNNING: ["RECOVERY_COMPLETE", "STARTUP_FAILED"],
  RECOVERY_COMPLETE: ["SERVICES_READY", "STARTUP_FAILED"],
  SERVICES_READY: ["ACCEPTING_TRAFFIC", "STARTUP_FAILED"],
  ACCEPTING_TRAFFIC: [],
  STARTUP_FAILED: [],
};

export class StartupLifecycle {
  private state: StartupState = "CREATED";
  private readonly history: StartupState[] = ["CREATED"];
  private failedReason: string | undefined;

  current(): StartupState {
    return this.state;
  }

  trail(): readonly StartupState[] {
    return this.history;
  }

  failureReason(): string | undefined {
    return this.failedReason;
  }

  isReady(): boolean {
    return this.state === "ACCEPTING_TRAFFIC";
  }

  advance(next: StartupState): void {
    const allowed = ALLOWED[this.state];
    if (!allowed.includes(next)) {
      this.fail(`illegal startup transition ${this.state} → ${next}`);
      return;
    }
    this.state = next;
    this.history.push(next);
  }

  fail(reason: string): void {
    this.failedReason = reason;
    this.state = "STARTUP_FAILED";
    this.history.push("STARTUP_FAILED");
  }
}

export const RUNTIME_RUN_STATES = ["RUNNING", "DRAINING", "STOPPED"] as const;
export type RuntimeRunState = (typeof RUNTIME_RUN_STATES)[number];

export class DrainController {
  private state: RuntimeRunState = "RUNNING";

  current(): RuntimeRunState {
    return this.state;
  }

  isAcceptingWork(): boolean {
    return this.state === "RUNNING";
  }

  beginDrain(): void {
    if (this.state === "RUNNING") {
      this.state = "DRAINING";
    }
  }

  stop(): void {
    this.state = "STOPPED";
  }
}
