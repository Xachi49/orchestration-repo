/**
 * Phase 12 operational metrics. Observational only.
 * METRICS != POLICY. They must not mutate authority.
 */
export class OperationalMetrics {
  private readonly counters = new Map<string, number>();
  private readonly observations = new Map<string, number[]>();

  increment(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  observe(name: string, value: number): void {
    const list = this.observations.get(name) ?? [];
    list.push(value);
    this.observations.set(name, list);
  }

  get(name: string): number {
    return this.counters.get(name) ?? 0;
  }

  snapshot(): {
    counters: Record<string, number>;
    observations: Record<string, { count: number; last: number | null }>;
  } {
    const counters: Record<string, number> = {};
    for (const [key, value] of this.counters) {
      counters[key] = value;
    }
    const observations: Record<string, { count: number; last: number | null }> =
      {};
    for (const [key, values] of this.observations) {
      observations[key] = {
        count: values.length,
        last: values[values.length - 1] ?? null,
      };
    }
    return { counters, observations };
  }
}
