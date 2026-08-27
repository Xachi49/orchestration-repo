import { DecisionPolicyError } from "./errors.js";
import type { DecisionContext } from "./context.js";
import type { DecisionPolicyCandidate } from "./policy.js";
import type { DecisionPolicyShadowEvaluation } from "./shadow-recommendation.js";
import type { CausalEvidenceBinding } from "./causal-evidence.js";

export interface ActivationReadinessInput {
  policy: DecisionPolicyCandidate;
  context: DecisionContext;
  shadowEvaluation: DecisionPolicyShadowEvaluation | null;
  causalBindingsStillValid: boolean;
  governanceCurrent: boolean;
  capabilitiesCurrent: boolean;
  nowIso: string;
}

export interface ActivationReadinessResult {
  ready: boolean;
  issues: string[];
}

/**
 * ACTIVATOR AUTHORITY != ABILITY TO OVERRIDE DETERMINISTIC SAFETY READINESS.
 * Human activation may proceed only after this check passes.
 */
export function assessDecisionPolicyActivationReadiness(
  input: ActivationReadinessInput,
): ActivationReadinessResult {
  const issues: string[] = [];
  const { policy, shadowEvaluation } = input;

  if (
    policy.status !== "AWAITING_ACTIVATION" &&
    policy.status !== "APPROVED_FOR_SHADOW" &&
    policy.status !== "SHADOW_RUNNING"
  ) {
    issues.push(
      `Policy status ${policy.status} is not eligible for activation`,
    );
  }

  if (policy.evaluationRequirements.requireShadowEvidence) {
    if (!shadowEvaluation) {
      issues.push("Persisted shadow evaluation required");
    } else {
      if (shadowEvaluation.policyHash !== policy.policyHash) {
        issues.push("Shadow evaluation policyHash does not match policy");
      }
      if (
        shadowEvaluation.shadowRecordCount <
        policy.evaluationRequirements.minimumShadowRecords
      ) {
        issues.push(
          `Shadow sample ${shadowEvaluation.shadowRecordCount} below minimum ${policy.evaluationRequirements.minimumShadowRecords}`,
        );
      }
      if (
        shadowEvaluation.coverage <
        policy.evaluationRequirements.minimumCoverage
      ) {
        issues.push(
          `Shadow coverage ${shadowEvaluation.coverage} below minimum ${policy.evaluationRequirements.minimumCoverage}`,
        );
      }
      if (
        shadowEvaluation.unsupportedStateRate >
        policy.riskConstraints.maxUnsupportedStateRate
      ) {
        issues.push(
          `Unsupported-state rate ${shadowEvaluation.unsupportedStateRate} exceeds max ${policy.riskConstraints.maxUnsupportedStateRate}`,
        );
      }
      if (shadowEvaluation.constraintFailures > 0) {
        issues.push(
          `Shadow evaluation has ${shadowEvaluation.constraintFailures} blocking constraint violations`,
        );
      }
      const qualityRank = (q: string): number => {
        switch (q) {
          case "VALIDATED":
            return 3;
          case "PARTIAL":
            return 2;
          case "DEGRADED":
            return 1;
          default:
            return 0;
        }
      };
      if (
        qualityRank(shadowEvaluation.evidenceQuality) <
        qualityRank(policy.evaluationRequirements.minimumEvidenceQuality)
      ) {
        issues.push(
          `Shadow evidence quality ${shadowEvaluation.evidenceQuality} below ${policy.evaluationRequirements.minimumEvidenceQuality}`,
        );
      }
    }
  }

  if (!input.causalBindingsStillValid) {
    issues.push("Causal source evidence is stale, superseded, or out of scope");
  }
  if (!input.governanceCurrent) {
    issues.push("Governance policy fingerprint drift");
  }
  if (!input.capabilitiesCurrent) {
    issues.push("Capability set fingerprint drift");
  }

  const envOk = policy.sourceCausalBindings
    ? true
    : input.context.environmentScope.length > 0;
  void envOk;

  return { ready: issues.length === 0, issues };
}

export function assertActivationReady(
  result: ActivationReadinessResult,
): void {
  if (!result.ready) {
    throw new DecisionPolicyError(
      "ACTIVATION_NOT_READY",
      result.issues.join("; ") || "Activation readiness failed",
      { issues: result.issues },
    );
  }
}

export function causalBindingsStillMatch(
  stored: readonly CausalEvidenceBinding[],
  live: readonly CausalEvidenceBinding[],
): boolean {
  if (stored.length !== live.length) return false;
  const byId = new Map(live.map((b) => [b.promotedCausalClaimId, b]));
  for (const s of stored) {
    const n = byId.get(s.promotedCausalClaimId);
    if (!n) return false;
    if (n.promotedClaimHash !== s.promotedClaimHash) return false;
    if (n.sourceClaimHash !== s.sourceClaimHash) return false;
    if (n.scopeAssessment === "NOT_SUPPORTED") return false;
    if (n.scopeAssessment === "EXTRAPOLATED") return false;
  }
  return true;
}
