/**
 * Operational circuit. May stop dispatch. Must not approve/complete/promote.
 */
export class OperationalCircuit {
  private failures = 0;
  private openUntil = 0;

  constructor(
    private readonly threshold: number,
    private readonly cooldownMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get open(): boolean {
    return this.now() < this.openUntil;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.openUntil = 0;
  }

  recordFailure(): void {
    this.failures += 1;
    if (this.failures >= this.threshold) {
      this.openUntil = this.now() + this.cooldownMs;
    }
  }

  assertClosed(operation: string): void {
    if (this.open) {
      throw new Error(`operational circuit open for ${operation}`);
    }
  }
}
