import type { ExecutionPlan } from "../domain/plan/execution-plan.js";
import type { PlanningContext } from "../planning/context.js";
import type { PlanningModel } from "../planning/model.js";
import {
  parsePlanProposal,
  type GapAnalysis,
  type PlanProposal,
} from "../planning/proposal.js";
import type { ValidationModelOutput } from "./model.js";
import type { RevisionEnvelope } from "./revision-envelope.js";

export interface PlanRevisionModelInput {
  envelope: RevisionEnvelope;
  plan: ExecutionPlan;
  context: PlanningContext;
  promptVersion: string;
}

/**
 * Bounded plan repair port.
 *
 * Returns a `PlanProposal`, never an `ExecutionPlan`: the reviser proposes, and
 * `PlanCompiler` remains the only thing that may assign a plan id, version, or
 * hash. Kept separate from `ValidationModel` so repair and adjudication cannot
 * collapse into the same opinion.
 */
export interface PlanRevisionModel {
  readonly provider: string;
  readonly modelId: string;
  readonly toolsEnabled: false;

  revisePlan(
    input: PlanRevisionModelInput,
  ): Promise<ValidationModelOutput<PlanProposal>>;
}

/** Deterministic gap analysis derived from the envelope, not from a model. */
export function gapAnalysisFromEnvelope(
  input: PlanRevisionModelInput,
): GapAnalysis {
  return {
    existingCapabilities: [...input.envelope.lockedConstraints.allowedActionTypes],
    missingCapabilities: [],
    brokenOrInsufficientCapabilities: [],
    requiredDependencies: [],
    constraints: [...input.envelope.lockedConstraints.immutableStatements],
    unknowns: [...input.plan.unknowns],
    assumptions: [...input.plan.assumptions],
    contradictions: input.envelope.repairableFindings.map(
      (finding) => `${finding.ruleId}: ${finding.message}`,
    ),
    blockedPrerequisites: input.envelope.repairableFindings
      .filter((finding) => finding.affectedStepIds.length > 0)
      .flatMap((finding) => finding.affectedStepIds),
    evidenceRefs: [...input.context.contextMetadata.selectedEvidenceIds],
    // The success definition is locked, so a bounded repair inherits the
    // coverage the validated plan already established.
    acceptanceCriteriaCoverage: input.context.objective.acceptanceCriteria.map(
      (criterion) => ({
        criterion,
        covered: true,
        notes: "Coverage inherited from the locked success definition",
      }),
    ),
  };
}

/**
 * Adapts an existing `PlanningModel` into the revision port.
 *
 * Reusing the planner for repair is acceptable because the planner never
 * adjudicates its own output: the deterministic ladder re-runs against every
 * revised version, and a repeated violation escalates to a human.
 */
export class PlanningModelRevisionAdapter implements PlanRevisionModel {
  readonly toolsEnabled = false as const;

  constructor(private readonly planningModel: PlanningModel) {}

  get provider(): string {
    return this.planningModel.provider;
  }

  get modelId(): string {
    return this.planningModel.modelId;
  }

  async revisePlan(
    input: PlanRevisionModelInput,
  ): Promise<ValidationModelOutput<PlanProposal>> {
    const result = await this.planningModel.proposePlan({
      context: input.context,
      gapAnalysis: gapAnalysisFromEnvelope(input),
      promptVersion: input.promptVersion,
    });
    const output: ValidationModelOutput<PlanProposal> = {
      value: parsePlanProposal(result.value),
    };
    if (result.usage) {
      output.usage = { ...result.usage };
    }
    return output;
  }
}

/**
 * Deterministic fake reviser for tests.
 * Returns queued proposals, then the standing proposal, then fails closed.
 */
export class FakePlanRevisionModel implements PlanRevisionModel {
  readonly provider = "fake";
  readonly modelId = "fake-revision-v1";
  readonly toolsEnabled = false as const;

  private readonly queue: PlanProposal[] = [];
  private standing: PlanProposal | null = null;
  private failNext: Error | null = null;
  callCount = 0;
  lastInput: PlanRevisionModelInput | null = null;

  setProposal(proposal: PlanProposal): void {
    this.standing = parsePlanProposal(proposal);
  }

  queueProposals(proposals: readonly PlanProposal[]): void {
    for (const proposal of proposals) {
      this.queue.push(parsePlanProposal(proposal));
    }
  }

  failNextCall(error: Error): void {
    this.failNext = error;
  }

  async revisePlan(
    input: PlanRevisionModelInput,
  ): Promise<ValidationModelOutput<PlanProposal>> {
    this.callCount += 1;
    this.lastInput = input;
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = null;
      throw error;
    }
    const value = this.queue.shift() ?? this.standing;
    if (!value) {
      throw new Error("FakePlanRevisionModel has no configured proposal");
    }
    return {
      value,
      usage: { inputTokens: 100, outputTokens: 80, totalTokens: 180 },
    };
  }
}
