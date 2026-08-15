import {
  INITIAL_PLAN_VERSION,
  parseExecutionPlan,
  type ExecutionPlan,
  type ExecutionPlanForHash,
  type PlanVersion,
} from "../domain/plan/execution-plan.js";
import {
  Sha256PlanHasher,
  type PlanHasher,
} from "../domain/plan/plan-hasher.js";
import type { PlanProposal } from "./proposal.js";
import type { PlanningContext } from "./context.js";
import type { DependencyGraphResult } from "./dependency-graph.js";
import type { PlanResourceAnalysis } from "./resource-analyzer.js";
import { compileAcceptanceCriterionVerificationBindings } from "./verification-bindings.js";

export interface PlanIdentityGenerator {
  nextPlanId(): string;
}

export class SequencePlanIdentityGenerator implements PlanIdentityGenerator {
  private counter = 0;
  nextPlanId(): string {
    this.counter += 1;
    return `plan_${this.counter}`;
  }
}

export interface PlanCompilerInput {
  proposal: PlanProposal;
  context: PlanningContext;
  graph: DependencyGraphResult;
  resources: PlanResourceAnalysis;
  /** Defaults to INITIAL_PLAN_VERSION (1). Phase 5 revisions increment numerically. */
  planVersion?: PlanVersion;
}

/**
 * Converts PlanProposal into authoritative ExecutionPlan.
 * Model cannot assign planId, planVersion, or planHash.
 * Model cannot invent criterion IDs — bindings are resolved from Objective.
 */
export class PlanCompiler {
  constructor(
    private readonly identities: PlanIdentityGenerator,
    private readonly hasher: PlanHasher = new Sha256PlanHasher(),
  ) {}

  compile(input: PlanCompilerInput): ExecutionPlan {
    const planId = this.identities.nextPlanId();
    const planVersion = input.planVersion ?? INITIAL_PLAN_VERSION;
    const steps = input.proposal.steps.map((step) => {
      const rollback: {
        strategy: "NONE" | "COMPENSATING_ACTION" | "MANUAL";
        compensatingStepIds?: string[];
        instructions?: string[];
      } = {
        strategy: step.rollbackStrategy,
      };
      if (step.compensatingStepIds !== undefined) {
        rollback.compensatingStepIds = [...step.compensatingStepIds];
      }
      if (step.rollbackInstructions !== undefined) {
        rollback.instructions = [...step.rollbackInstructions];
      }
      return {
        stepId: step.stepId,
        actionType: step.actionType,
        description: step.description,
        targetIds: [...step.targetIds],
        evidenceRefs: [...step.evidenceRefs],
        dependsOn: [...step.dependsOn],
        preconditions: [...step.preconditions],
        expectedPostconditions: [...step.expectedPostconditions],
        resourceEstimate: { ...step.resourceEstimate },
        risk: {
          level: step.risk.level,
          categories: [...step.risk.categories],
          ...(step.risk.notes !== undefined
            ? { notes: [...step.risk.notes] }
            : {}),
        },
        validation: {
          checks: [...step.validationChecks],
        },
        rollback,
        idempotencyKey: `${planId}:${step.stepId}`,
      };
    });

    const acceptanceCriterionVerificationBindings =
      compileAcceptanceCriterionVerificationBindings({
        objective: input.context.objective,
        proposal: input.proposal,
        steps: input.proposal.steps,
      });

    const forHash: ExecutionPlanForHash = {
      planId,
      planVersion,
      objectiveId: input.context.run.objectiveId,
      objectiveVersion: input.context.run.objectiveVersion,
      repositoryCommitSha: input.context.repository.commitSha,
      repositoryFingerprint: input.context.repository.repositoryFingerprint,
      policyBundleId: input.context.controlPlane.policyBundleId,
      policyBundleHash: input.context.controlPlane.policyBundleHash,
      schemaVersion: "1.0.0",
      assumptions: [
        ...input.proposal.assumptions,
        ...input.proposal.gapAnalysis.assumptions,
      ],
      unknowns: [
        ...input.proposal.unknowns,
        ...input.proposal.gapAnalysis.unknowns,
        ...input.context.knownUnknowns,
      ],
      successDefinition: [...input.proposal.successDefinition],
      resourceTotals: {
        durationMs: input.resources.estimatedDurationMinutes * 60_000,
        tokenEstimate: input.resources.estimatedLlmTokens,
        costEstimateUsd: input.resources.estimatedCost,
      },
      criticalPath: [...input.graph.criticalPath],
      workstreams: input.proposal.workstreams.map((ws) => ({
        workstreamId: ws.workstreamId,
        name: ws.name,
        stepIds: [...ws.stepIds],
      })),
      steps,
      approvalRequirements: [],
      failurePolicy: {
        onStepFailure: "BLOCK",
        maxRetries: 0,
      },
      acceptanceCriterionVerificationBindings,
    };

    const planHash = this.hasher.hash(forHash);
    return parseExecutionPlan({ ...forHash, planHash });
  }
}
