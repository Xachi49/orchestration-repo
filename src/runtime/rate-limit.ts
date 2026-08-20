export class SlidingWindowRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  allow(key: string): boolean {
    const now = this.now();
    const windowStart = now - this.windowMs;
    const prior = (this.hits.get(key) ?? []).filter((ts) => ts > windowStart);
    if (prior.length >= this.limit) {
      this.hits.set(key, prior);
      return false;
    }
    prior.push(now);
    this.hits.set(key, prior);
    return true;
  }
}
