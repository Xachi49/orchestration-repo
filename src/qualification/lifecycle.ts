import { z } from "zod";
import { QualificationError } from "./errors.js";

/**
 * Deterministic runtime lifecycle for the reference runtime.
 * READY ≠ accepting business authority — only traffic readiness.
 */
export const RUNTIME_LIFECYCLE_STATES = [
  "CREATED",
  "CONFIG_VALIDATED",
  "DB_CONNECTED",
  "SCHEMA_VERIFIED",
  "REPOSITORIES_READY",
  "MANIFEST_RESOLVED",
  "RECOVERY_COMPLETE",
  "SERVICES_INITIALIZED",
  "WORKERS_INITIALIZED",
  "API_INITIALIZED",
  "READINESS_CHECKED",
  "READY",
  "DRAINING",
  "STOPPED",
] as const;

export type RuntimeLifecycleState = (typeof RUNTIME_LIFECYCLE_STATES)[number];

const STARTUP_ORDER: readonly RuntimeLifecycleState[] = [
  "CREATED",
  "CONFIG_VALIDATED",
  "DB_CONNECTED",
  "SCHEMA_VERIFIED",
  "REPOSITORIES_READY",
  "MANIFEST_RESOLVED",
  "RECOVERY_COMPLETE",
  "SERVICES_INITIALIZED",
  "WORKERS_INITIALIZED",
  "API_INITIALIZED",
  "READINESS_CHECKED",
  "READY",
] as const;

export const RuntimeLifecycleSchema = z
  .object({
    state: z.enum(RUNTIME_LIFECYCLE_STATES),
    acceptingTraffic: z.boolean(),
    acquiringLeases: z.boolean(),
  })
  .strict();

export type RuntimeLifecycle = z.infer<typeof RuntimeLifecycleSchema>;

export function createRuntimeLifecycle(): RuntimeLifecycle {
  return { state: "CREATED", acceptingTraffic: false, acquiringLeases: false };
}

export function advanceStartup(
  current: RuntimeLifecycle,
  next: RuntimeLifecycleState,
): RuntimeLifecycle {
  const fromIdx = STARTUP_ORDER.indexOf(current.state as (typeof STARTUP_ORDER)[number]);
  const toIdx = STARTUP_ORDER.indexOf(next as (typeof STARTUP_ORDER)[number]);
  if (fromIdx < 0 || toIdx !== fromIdx + 1) {
    throw new QualificationError(
      "RUNTIME_RECOVERY_FAILED",
      `Invalid startup transition ${current.state} → ${next}`,
    );
  }
  const ready = next === "READY";
  return {
    state: next,
    acceptingTraffic: ready,
    acquiringLeases: ready,
  };
}

export function beginDrain(current: RuntimeLifecycle): RuntimeLifecycle {
  if (current.state !== "READY") {
    throw new QualificationError(
      "RUNTIME_DRAIN_FAILED",
      `Cannot drain from ${current.state}`,
    );
  }
  return {
    state: "DRAINING",
    acceptingTraffic: false,
    acquiringLeases: false,
  };
}

export function completeStop(current: RuntimeLifecycle): RuntimeLifecycle {
  if (current.state !== "DRAINING" && current.state !== "READY") {
    throw new QualificationError(
      "RUNTIME_DRAIN_FAILED",
      `Cannot stop from ${current.state}`,
    );
  }
  return {
    state: "STOPPED",
    acceptingTraffic: false,
    acquiringLeases: false,
  };
}

export const STARTUP_ORDER_DOCUMENTED = STARTUP_ORDER;
