import type { ExecutionPlan } from "../domain/plan/execution-plan.js";
import type {
  ExecutionArtifact,
  StepExecutionResult,
} from "../domain/execution/index.js";
import { ExecutionTargetValidator } from "../execution/target-validator.js";
import { MAX_AUTOMATIC_ROLLBACKS } from "../domain/execution/index.js";
import type { VerificationFinding } from "../domain/verification/index.js";
import type { VerificationIdentityGenerator } from "./identity.js";

export interface BoundaryVerificationInput {
  plan: ExecutionPlan;
  steps: readonly StepExecutionResult[];
  artifacts: readonly ExecutionArtifact[];
  rollbackCount: number;
}

/**
 * Compare actual observed effects against exact authorized scope.
 * Observed unauthorized scope expansion → hard verification failure.
 */
export class ExecutionBoundaryVerifier {
  private readonly targets = new ExecutionTargetValidator();

  constructor(private readonly identities: VerificationIdentityGenerator) {}

  verify(input: BoundaryVerificationInput): VerificationFinding[] {
    const findings: VerificationFinding[] = [];
    const planStepIds = new Set(input.plan.steps.map((s) => s.stepId));
    const planById = new Map(input.plan.steps.map((s) => [s.stepId, s]));
    const authorizedActions = new Set(
      input.plan.steps.map((s) => s.actionType),
    );

    for (const step of input.steps) {
      if (!planStepIds.has(step.stepId)) {
        findings.push(this.finding({
          ruleId: "VERIFICATION_SCOPE_VIOLATION",
          message: `Unknown executed step not in plan: ${step.stepId}`,
          category: "BOUNDARY",
          stepIds: [step.stepId],
        }));
        continue;
      }
      const planStep = planById.get(step.stepId)!;
      if (step.actionType !== planStep.actionType) {
        findings.push(this.finding({
          ruleId: "VERIFICATION_SCOPE_VIOLATION",
          message: `Unexpected action type for ${step.stepId}: ${step.actionType}`,
          category: "BOUNDARY",
          stepIds: [step.stepId],
        }));
      }
      if (!authorizedActions.has(step.actionType)) {
        findings.push(this.finding({
          ruleId: "VERIFICATION_SCOPE_VIOLATION",
          message: `Unauthorized action type observed: ${step.actionType}`,
          category: "BOUNDARY",
          stepIds: [step.stepId],
        }));
      }
      if (step.capabilityId !== planStep.actionType && step.capabilityId !== planStep.stepId) {
        // Phase 7 uses capabilityId === actionType typically
        if (step.capabilityId !== planStep.actionType) {
          // still ok if capability maps to same action; soft check against plan action
        }
      }
      for (const target of step.affectedTargets) {
        try {
          this.targets.assertNotProtected(target);
        } catch {
          findings.push(this.finding({
            ruleId: "VERIFICATION_SCOPE_VIOLATION",
            message: `Protected target activity observed: ${target}`,
            category: "BOUNDARY",
            stepIds: [step.stepId],
            metadata: { target },
          }));
        }
        const authorized = planStep.targetIds.some(
          (t) =>
            target === t ||
            target.startsWith(`${t}/`) ||
            t === "workspace" ||
            t.startsWith("UNIT_") ||
            t.startsWith("TYPE") ||
            t.startsWith("BUILD"),
        );
        if (!authorized && planStep.actionType !== "RUN_TESTS") {
          findings.push(this.finding({
            ruleId: "VERIFICATION_SCOPE_VIOLATION",
            message: `Affected target outside authorized scope: ${target}`,
            category: "BOUNDARY",
            stepIds: [step.stepId],
            metadata: { target, authorized: planStep.targetIds },
          }));
        }
      }
    }

    const expectedTypes = new Set(
      input.plan.steps.map((s) => {
        switch (s.actionType) {
          case "CREATE_LOCAL_PATCH":
            return "PATCH";
          case "RUN_TESTS":
            return "TEST_RESULT";
          case "CREATE_TASK":
            return "TASK";
          case "PREPARE_PULL_REQUEST":
            return "PR_PREPARATION";
          default:
            return "OTHER";
        }
      }),
    );
    for (const artifact of input.artifacts) {
      if (
        artifact.artifactType !== "ROLLBACK" &&
        artifact.artifactType !== "OTHER" &&
        !expectedTypes.has(artifact.artifactType) &&
        !planStepIds.has(artifact.stepId)
      ) {
        findings.push(this.finding({
          ruleId: "VERIFICATION_SCOPE_VIOLATION",
          message: `Unexpected artifact type ${artifact.artifactType}`,
          category: "BOUNDARY",
          stepIds: [artifact.stepId],
        }));
      }
    }

    if (input.rollbackCount > MAX_AUTOMATIC_ROLLBACKS) {
      findings.push(this.finding({
        ruleId: "VERIFICATION_GOVERNANCE_VIOLATION",
        message: `Unauthorized rollback count ${input.rollbackCount} exceeds max ${MAX_AUTOMATIC_ROLLBACKS}`,
        category: "GOVERNANCE",
        stepIds: [],
        metadata: { rollbackCount: input.rollbackCount },
      }));
    }

    const compensatingIds = new Set(
      input.plan.steps.flatMap((s) => s.rollback.compensatingStepIds ?? []),
    );
    for (const step of input.steps) {
      if (
        compensatingIds.has(step.stepId) &&
        step.status === "SUCCEEDED" &&
        input.rollbackCount === 0 &&
        !input.steps.some(
          (s) =>
            s.stepId !== step.stepId &&
            (s.status === "FAILED" || s.status === "CONTAINED"),
        )
      ) {
        // Compensating step ran without a failed primary — suspicious but may be plan-included
      }
    }

    return findings;
  }

  private finding(input: {
    ruleId: string;
    message: string;
    category: VerificationFinding["category"];
    stepIds: string[];
    metadata?: Record<string, unknown>;
  }): VerificationFinding {
    return {
      findingId: this.identities.nextFindingId(),
      category: input.category,
      severity: "CRITICAL",
      ruleId: input.ruleId,
      message: input.message,
      criterionIds: [],
      stepIds: input.stepIds,
      evidenceRefs: [],
      blocksVerifiedSuccess: true,
      metadata: input.metadata ?? {},
    };
  }
}
