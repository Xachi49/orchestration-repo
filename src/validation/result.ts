import type {
  ValidationDecisionClass,
  ValidationFinding,
} from "../domain/validation/index.js";
import type { PlanVersion } from "../domain/plan/execution-plan.js";
import type { StoredPlanStatus } from "../planning/plan-repository.js";
import type { ValidationReasonCode } from "./decision-engine.js";
import type { PlanningException } from "./exception.js";

/**
 * Outcome of one `ValidationService.validate` call.
 *
 * `runState` is always VALIDATING. PASS is not approval: Phase 5 decides
 * whether a plan may be considered, never whether it may proceed.
 */
export interface ValidationResult {
  outcome: "VALIDATED";
  runId: string;
  planId: string;
  planVersion: PlanVersion;
  planHash: string;
  decision: ValidationDecisionClass;
  validationDecisionId: string;
  validationAttempt: number;
  reasonCodes: readonly ValidationReasonCode[];
  requiresHumanAction: boolean;
  findings: readonly ValidationFinding[];
  planStatus: StoredPlanStatus;
  runState: "VALIDATING";
  /** Revisions consumed across this plan lineage (v1→v2→v3). */
  revisionAttemptsUsed: number;
  supersededPlanIds: readonly string[];
  contextualAssessmentUsed: boolean;
  exception?: PlanningException;
}
