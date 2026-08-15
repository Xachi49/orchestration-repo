import type { ExecutionPlan } from "../domain/plan/execution-plan.js";
import type { ValidationFinding } from "../domain/validation/index.js";
import type { ProjectControlContext } from "../control-plane/context.js";
import type { LockedRepositoryState } from "../ingestion/locked-state.js";
import type { VerifiedRepositoryContext } from "../ingestion/context.js";
import { ValidationFindingFactory } from "./finding-factory.js";

export interface PlanFreshnessValidatorInput {
  plan: ExecutionPlan;
  liveLock: LockedRepositoryState | null;
  repositoryContext: VerifiedRepositoryContext | null;
  control: ProjectControlContext;
}

/**
 * Verifies that the world the plan was built against is still the world we are
 * validating in.
 *
 * Staleness is never repairable by a semantic revision: a drifted commit,
 * invalidated lock, or rotated policy bundle invalidates the plan's grounding,
 * so the run must be blocked rather than patched.
 */
export class PlanFreshnessValidator {
  constructor(
    private readonly findings: ValidationFindingFactory = new ValidationFindingFactory(),
  ) {}

  validate(input: PlanFreshnessValidatorInput): ValidationFinding[] {
    const results: ValidationFinding[] = [];

    if (!input.repositoryContext) {
      results.push(
        this.findings.create({
          validatorType: "FRESHNESS",
          category: "repository-truth",
          severity: "CRITICAL",
          ruleId: "REPOSITORY_CONTEXT_MISSING",
          message: "No verified repository context exists for the run",
          repairable: false,
          approvalEligible: false,
          blocking: true,
        }),
      );
    }

    if (!input.liveLock) {
      results.push(
        this.findings.create({
          validatorType: "FRESHNESS",
          category: "repository-truth",
          severity: "CRITICAL",
          ruleId: "REPOSITORY_LOCK_MISSING",
          message: "No live locked repository state exists for the run",
          repairable: false,
          approvalEligible: false,
          blocking: true,
        }),
      );
      return results;
    }

    if (input.liveLock.status === "STALE") {
      results.push(
        this.findings.create({
          validatorType: "FRESHNESS",
          category: "repository-truth",
          severity: "CRITICAL",
          ruleId: "REPOSITORY_LOCK_STALE",
          message: "Live locked repository state is STALE (remote drifted)",
          repairable: false,
          approvalEligible: false,
          blocking: true,
          subject: { status: input.liveLock.status },
        }),
      );
    } else if (input.liveLock.status !== "VERIFIED") {
      results.push(
        this.findings.create({
          validatorType: "FRESHNESS",
          category: "repository-truth",
          severity: "CRITICAL",
          ruleId: "REPOSITORY_LOCK_NOT_VERIFIED",
          message: `Live locked repository state is ${input.liveLock.status}`,
          repairable: false,
          approvalEligible: false,
          blocking: true,
          subject: { status: input.liveLock.status },
        }),
      );
    }

    if (
      input.plan.repositoryCommitSha.toLowerCase() !==
      input.liveLock.commitSha.toLowerCase()
    ) {
      results.push(
        this.findings.create({
          validatorType: "FRESHNESS",
          category: "repository-truth",
          severity: "CRITICAL",
          ruleId: "PLAN_COMMIT_SHA_MISMATCH",
          message: "Plan commit SHA does not match the live locked commit SHA",
          repairable: false,
          approvalEligible: false,
          blocking: true,
          metadata: {
            planCommitSha: input.plan.repositoryCommitSha,
            lockedCommitSha: input.liveLock.commitSha,
          },
        }),
      );
    }

    if (
      input.repositoryContext &&
      input.plan.repositoryFingerprint !==
        input.repositoryContext.repositoryFingerprint
    ) {
      results.push(
        this.findings.create({
          validatorType: "FRESHNESS",
          category: "repository-truth",
          severity: "CRITICAL",
          ruleId: "PLAN_REPOSITORY_FINGERPRINT_MISMATCH",
          message:
            "Plan repository fingerprint does not match the verified context fingerprint",
          repairable: false,
          approvalEligible: false,
          blocking: true,
          metadata: {
            planRepositoryFingerprint: input.plan.repositoryFingerprint,
            contextRepositoryFingerprint:
              input.repositoryContext.repositoryFingerprint,
          },
        }),
      );
    }

    if (
      input.plan.policyBundleId !==
      input.control.activePolicyBundle.policyBundleId
    ) {
      results.push(
        this.findings.create({
          validatorType: "FRESHNESS",
          category: "policy-authority",
          severity: "CRITICAL",
          ruleId: "PLAN_POLICY_BUNDLE_MISMATCH",
          message:
            "Plan was built against a different policy bundle than the active one",
          repairable: false,
          approvalEligible: false,
          blocking: true,
          metadata: {
            planPolicyBundleId: input.plan.policyBundleId,
            activePolicyBundleId:
              input.control.activePolicyBundle.policyBundleId,
          },
        }),
      );
    } else if (
      input.plan.policyBundleHash !== input.control.activePolicyBundle.policyHash
    ) {
      results.push(
        this.findings.create({
          validatorType: "FRESHNESS",
          category: "policy-authority",
          severity: "CRITICAL",
          ruleId: "PLAN_POLICY_BUNDLE_HASH_MISMATCH",
          message: "Active policy bundle content changed after the plan was built",
          repairable: false,
          approvalEligible: false,
          blocking: true,
          metadata: {
            planPolicyBundleHash: input.plan.policyBundleHash,
            activePolicyBundleHash: input.control.activePolicyBundle.policyHash,
          },
        }),
      );
    }

    return results;
  }
}
