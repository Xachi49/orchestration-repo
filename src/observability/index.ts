/** Phase 10 — observational system intelligence. No authority mutation. */
export { ObservabilityError, isObservabilityError } from "./errors.js";
export type { ObservabilityErrorCode } from "./errors.js";
export * from "./hasher.js";
export * from "./identity.js";
export * from "./repositories.js";
export * from "./sources.js";
export * from "./window.js";
export type { BuildWindowRequest } from "./window.js";
export * from "./normalization.js";
export * from "./integrity.js";
export * from "./metrics-calculator.js";
export * from "./resource-attribution.js";
export * from "./failure-services.js";
export * from "./slo-services.js";
export * from "./anomaly-services.js";
export * from "./intelligence.js";
export * from "./trace-funnel.js";
export { ObservabilityService } from "./service.js";
export type { ObservabilityServiceDeps } from "./service.js";

/** Legacy Phase 0 port — superseded by ObservabilityService for Phase 10+. */
export interface ObservabilityPort {
  recordEvent(name: string, attributes?: Record<string, string>): void;
}

export class NoopObservability implements ObservabilityPort {
  recordEvent(_name: string, _attributes?: Record<string, string>): void {
    // intentionally no side effects
  }
}
