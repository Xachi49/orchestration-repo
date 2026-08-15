import type {
  ExecutionAuthoritySnapshot,
  ExecutionResult,
  StepExecutionResult,
} from "../domain/execution/index.js";
import type { AuthorizationRecord } from "../domain/authorization/authorization-record.js";
import { MAX_AUTOMATIC_ROLLBACKS } from "../domain/execution/index.js";
import type { VerificationFinding } from "../domain/verification/index.js";
import type { VerificationIdentityGenerator } from "./identity.js";

export interface GovernanceVerificationInput {
  authorization: AuthorizationRecord;
  snapshot: ExecutionAuthoritySnapshot;
  result: ExecutionResult;
  steps: readonly StepExecutionResult[];
  rollbackCount: number;
  /** True when step store shows RUNNING was recorded before terminal success. */
  runningBeforeSideEffectOk: boolean;
}

/**
 * Independently verify Phase 7 followed its own governance constraints.
 * Governance failure prevents VERIFIED_SUCCESS.
 */
export class ExecutionGovernanceVerifier {
  constructor(private readonly identities: VerificationIdentityGenerator) {}

  verify(input: GovernanceVerificationInput): VerificationFinding[] {
    const findings: VerificationFinding[] = [];

    if (
      input.snapshot.authorizedCapabilitySetFingerprint !==
        input.authorization.capabilitySetFingerprint ||
      input.snapshot.liveCapabilitySetFingerprint !==
        input.authorization.capabilitySetFingerprint ||
      input.snapshot.capabilitySetFingerprint !==
        input.authorization.capabilitySetFingerprint
    ) {
      findings.push(this.finding({
        ruleId: "VERIFICATION_AUTHORITY_MISMATCH",
        message:
          "Historical authority fingerprints do not match AuthorizationRecord",
        category: "AUTHORITY",
      }));
    }

    if (
      input.snapshot.authorizationRecordId !==
      input.authorization.authorizationRecordId
    ) {
      findings.push(this.finding({
        ruleId: "VERIFICATION_AUTHORITY_MISMATCH",
        message: "Authority snapshot authorizationRecordId mismatch",
        category: "AUTHORITY",
      }));
    }

    if (!input.runningBeforeSideEffectOk) {
      findings.push(this.finding({
        ruleId: "VERIFICATION_GOVERNANCE_VIOLATION",
        message:
          "Missing RUNNING-before-side-effect evidence for actuated steps",
        category: "GOVERNANCE",
      }));
    }

    for (const step of input.steps) {
      if (!step.idempotencyKey) {
        findings.push(this.finding({
          ruleId: "VERIFICATION_GOVERNANCE_VIOLATION",
          message: `Step ${step.stepId} missing idempotency identity`,
          category: "GOVERNANCE",
          stepIds: [step.stepId],
        }));
      }
    }

    if (input.rollbackCount > MAX_AUTOMATIC_ROLLBACKS) {
      findings.push(this.finding({
        ruleId: "VERIFICATION_GOVERNANCE_VIOLATION",
        message: `Rollback count ${input.rollbackCount} exceeds maximum`,
        category: "GOVERNANCE",
        metadata: { rollbackCount: input.rollbackCount },
      }));
    }

    if (
      input.result.containmentRequired &&
      input.result.status !== "EXECUTION_CONTAINED" &&
      !input.steps.some((s) => s.status === "CONTAINED")
    ) {
      findings.push(this.finding({
        ruleId: "VERIFICATION_GOVERNANCE_VIOLATION",
        message: "Containment required but not reflected in result status",
        category: "CONTAINMENT",
      }));
    }

    const forbidden = input.steps.filter((s) =>
      ["SHELL", "DEPLOY", "HTTP_REQUEST", "GITHUB_WRITE"].includes(s.actionType),
    );
    for (const step of forbidden) {
      findings.push(this.finding({
        ruleId: "VERIFICATION_GOVERNANCE_VIOLATION",
        message: `Forbidden action audit evidence: ${step.actionType}`,
        category: "GOVERNANCE",
        stepIds: [step.stepId],
      }));
    }

    return findings;
  }

  private finding(input: {
    ruleId: string;
    message: string;
    category: VerificationFinding["category"];
    stepIds?: string[];
    metadata?: Record<string, unknown>;
  }): VerificationFinding {
    return {
      findingId: this.identities.nextFindingId(),
      category: input.category,
      severity: "CRITICAL",
      ruleId: input.ruleId,
      message: input.message,
      criterionIds: [],
      stepIds: input.stepIds ?? [],
      evidenceRefs: [],
      blocksVerifiedSuccess: true,
      metadata: input.metadata ?? {},
    };
  }
}
