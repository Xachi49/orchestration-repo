import type { EventEnvelope } from "../domain/run/event-envelope.js";
import type { RunState } from "../domain/run/run-state.js";
import type { AdmissionErrorCode } from "./errors.js";

export const ADMISSION_OUTCOMES = [
  "ADMITTED",
  "ACTIVE_DUPLICATE",
  "COMPLETED_DUPLICATE",
  "REJECTED",
  "CONFLICT",
] as const;

export type AdmissionOutcome = (typeof ADMISSION_OUTCOMES)[number];

export interface ControlContextReference {
  projectId: string;
  environment: string;
  policyBundleId: string;
  budgetProfileId: string;
  resolvedAt: string;
}

export interface AdmittedResult {
  outcome: "ADMITTED";
  runId: string;
  state: "ADMITTED";
  eventEnvelope: EventEnvelope;
  controlContextReference: ControlContextReference;
  idempotencyKey: string;
  correlationId: string;
  traceId: string;
}

export interface DuplicateAdmissionResult {
  outcome: "ACTIVE_DUPLICATE" | "COMPLETED_DUPLICATE";
  runId: string;
  state: RunState;
  idempotencyKey: string;
}

export interface RejectedAdmissionResult {
  outcome: "REJECTED";
  reasonCode: AdmissionErrorCode | string;
  message: string;
}

export interface ConflictAdmissionResult {
  outcome: "CONFLICT";
  reasonCode: AdmissionErrorCode | string;
  message: string;
}

export type AdmissionResult =
  | AdmittedResult
  | DuplicateAdmissionResult
  | RejectedAdmissionResult
  | ConflictAdmissionResult;
