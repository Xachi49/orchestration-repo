/**
 * Observability boundary — structured telemetry hooks.
 * Phase 0: no-op interfaces only.
 */
export interface ObservabilityPort {
  recordEvent(name: string, attributes?: Record<string, string>): void;
}

export class NoopObservability implements ObservabilityPort {
  recordEvent(_name: string, _attributes?: Record<string, string>): void {
    // intentionally no side effects in Phase 0
  }
}
