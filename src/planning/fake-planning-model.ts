import type {
  PlanningModel,
  PlanningModelOutput,
  PlanningModelTokenUsage,
} from "./model.js";
import { PlanningPreDispatchError } from "./model.js";
import type { PlanningContext } from "./context.js";
import {
  parsePlanProposal,
  type GapAnalysis,
  type PlanProposal,
} from "./proposal.js";

/**
 * Deterministic fake model for tests and default local stack.
 * Never contacts OpenAI.
 */
export class FakePlanningModel implements PlanningModel {
  readonly provider = "fake";
  readonly modelId = "fake-planning-v1";
  readonly toolsEnabled = false as const;

  private proposalOverride: PlanProposal | null = null;
  private failNext: Error | null = null;
  private failBeforeDispatchNext: Error | null = null;
  private omitUsageNext = false;
  private tokenUsage: PlanningModelTokenUsage | undefined = {
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
  };
  callCount = 0;

  setProposal(proposal: PlanProposal): void {
    this.proposalOverride = parsePlanProposal(proposal);
  }

  failNextCall(error: Error): void {
    this.failNext = error;
  }

  /** Fail before callCount increments — demonstrable pre-dispatch failure. */
  failBeforeDispatch(
    error: Error = new PlanningPreDispatchError("pre-dispatch"),
  ): void {
    this.failBeforeDispatchNext = error;
  }

  setTokenUsagePerCall(usage: PlanningModelTokenUsage | undefined): void {
    this.tokenUsage = usage === undefined ? undefined : { ...usage };
  }

  omitUsageOnNextCall(): void {
    this.omitUsageNext = true;
  }

  async analyzeGaps(input: {
    context: PlanningContext;
    promptVersion: string;
  }): Promise<PlanningModelOutput<GapAnalysis>> {
    if (this.failBeforeDispatchNext) {
      const error = this.failBeforeDispatchNext;
      this.failBeforeDispatchNext = null;
      throw error;
    }
    this.callCount += 1;
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = null;
      throw error;
    }
    const output: PlanningModelOutput<GapAnalysis> = {
      value: {
        existingCapabilities: input.context.controlPlane.availableCapabilities
          .filter((cap) => cap.enabled)
          .map((cap) => cap.capabilityId),
        missingCapabilities: [],
        brokenOrInsufficientCapabilities: [],
        requiredDependencies: [
          ...input.context.repository.indexSummary.dependencyManifests,
        ],
        constraints: [...input.context.objective.constraints],
        unknowns: [...input.context.knownUnknowns],
        assumptions: ["Fake model assumes local patch-only workflow"],
        contradictions: [],
        blockedPrerequisites: [],
        evidenceRefs: input.context.contextMetadata.selectedEvidenceIds.slice(
          0,
          3,
        ),
        acceptanceCriteriaCoverage:
          input.context.objective.acceptanceCriteria.map((criterion) => ({
            criterion,
            covered: true,
            notes: "Covered by fake proposal steps",
          })),
      },
    };
    if (!this.omitUsageNext && this.tokenUsage) {
      output.usage = { ...this.tokenUsage };
    }
    this.omitUsageNext = false;
    return output;
  }

  async proposePlan(input: {
    context: PlanningContext;
    gapAnalysis: GapAnalysis;
    promptVersion: string;
  }): Promise<PlanningModelOutput<PlanProposal>> {
    if (this.failBeforeDispatchNext) {
      const error = this.failBeforeDispatchNext;
      this.failBeforeDispatchNext = null;
      throw error;
    }
    this.callCount += 1;
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = null;
      throw error;
    }
    if (this.proposalOverride) {
      const output: PlanningModelOutput<PlanProposal> = {
        value: this.proposalOverride,
      };
      if (!this.omitUsageNext && this.tokenUsage) {
        output.usage = { ...this.tokenUsage };
      }
      this.omitUsageNext = false;
      return output;
    }

    const evidenceRefs =
      input.context.contextMetadata.selectedEvidenceIds.slice(0, 2);
    const allowedAction =
      input.context.controlPlane.availableCapabilities.find(
        (cap) => cap.enabled && cap.allowedActions.includes("READ_FILE"),
      )?.allowedActions[0] ?? "READ_FILE";
    const patchAction =
      input.context.controlPlane.availableCapabilities.find(
        (cap) =>
          cap.enabled && cap.allowedActions.includes("CREATE_LOCAL_PATCH"),
      )?.allowedActions[0] ?? "CREATE_LOCAL_PATCH";
    const testAction =
      input.context.controlPlane.availableCapabilities.find(
        (cap) => cap.enabled && cap.allowedActions.includes("RUN_TESTS"),
      )?.allowedActions[0] ?? "RUN_TESTS";

    const output: PlanningModelOutput<PlanProposal> = {
      value: parsePlanProposal({
        gapAnalysis: input.gapAnalysis,
        workstreams: [
          {
            workstreamId: "ws_main",
            name: "Primary delivery",
            stepIds: ["step_read", "step_patch", "step_test"],
          },
        ],
        steps: [
          {
            stepId: "step_read",
            actionType: allowedAction,
            description: "Inspect verified repository evidence",
            targetIds: ["workspace"],
            evidenceRefs,
            dependsOn: [],
            preconditions: ["Verified repository context available"],
            expectedPostconditions: ["Relevant files reviewed"],
            resourceEstimate: {
              durationMs: 60_000,
              tokenEstimate: 1_000,
              costEstimateUsd: 0.01,
            },
            risk: { level: "LOW", categories: ["read-only"] },
            validationChecks: ["Confirm evidence hashes match registry"],
            rollbackStrategy: "NONE",
          },
          {
            stepId: "step_patch",
            actionType: patchAction,
            description: "Prepare a local patch addressing the objective",
            targetIds: ["workspace"],
            evidenceRefs,
            dependsOn: ["step_read"],
            preconditions: ["Read step complete"],
            expectedPostconditions: ["Local patch artifact prepared"],
            resourceEstimate: {
              durationMs: 180_000,
              tokenEstimate: 2_000,
              costEstimateUsd: 0.05,
            },
            risk: { level: "MEDIUM", categories: ["local-mutation"] },
            validationChecks: ["Patch applies cleanly in workspace"],
            rollbackStrategy: "MANUAL",
            rollbackInstructions: ["Discard local patch artifact"],
          },
          {
            stepId: "step_test",
            actionType: testAction,
            description: "Run permitted local tests",
            targetIds: ["workspace"],
            evidenceRefs,
            dependsOn: ["step_patch"],
            preconditions: ["Patch prepared"],
            expectedPostconditions: ["Tests executed"],
            resourceEstimate: {
              durationMs: 300_000,
              tokenEstimate: 500,
              costEstimateUsd: 0.02,
            },
            risk: { level: "LOW", categories: ["verification"] },
            validationChecks: ["Test command exits successfully"],
            rollbackStrategy: "NONE",
          },
        ],
        successDefinition: [...input.context.objective.acceptanceCriteria],
        assumptions: [...input.gapAnalysis.assumptions],
        unknowns: [...input.gapAnalysis.unknowns],
        proposedRisks: ["Local patch may require human review before merge"],
        proposedVerificationChecks: ["Run tests", "Review patch diff"],
        proposedRollbackApproach:
          "Discard local patch and restore workspace checkout",
        proposedResourceTotals: {
          estimatedDurationMinutes: 15,
          estimatedLlmTokens: 4_000,
          estimatedApiCalls: 3,
          estimatedHumanMinutes: 10,
          estimatedCost: 0.1,
          maximumParallelWorkstreams: 1,
          estimatedLlmCalls: 2,
        },
        conciseRationale:
          "Fake deterministic proposal grounded in verified context and available capabilities.",
      }),
    };
    if (!this.omitUsageNext && this.tokenUsage) {
      output.usage = { ...this.tokenUsage };
    }
    this.omitUsageNext = false;
    return output;
  }
}
