import { createHash } from "node:crypto";
import { z } from "zod";
import { DecisionPolicyError } from "./errors.js";
import type { DecisionRecommendation } from "./shadow-recommendation.js";
import {
  ExecutionPathSchema,
  type DecisionActionDefinition,
} from "./variables-actions.js";

/**
 * Recommendation materialization compiles into downstream governed phases.
 * submission != authorization. No direct actuation.
 *
 * ACTIVE POLICY != AUTOMATIC PROPOSAL SUBMISSION.
 * Persist-only is the default. Explicit materialize requires canonical ports
 * and fails closed if a required adapter is missing.
 */
export interface ObjectiveAdmissionPort {
  admitFromRecommendation(input: {
    recommendation: DecisionRecommendation;
    action: DecisionActionDefinition;
    downstreamLogicalIdentity: string;
  }): Promise<{ objectiveAdmissionId: string; runId?: string }>;
}

export interface ProgramProposalPort {
  proposeFromRecommendation(input: {
    recommendation: DecisionRecommendation;
    action: DecisionActionDefinition;
    downstreamLogicalIdentity: string;
  }): Promise<{ programProposalId: string }>;
}

export interface PortfolioProposalPort {
  proposeFromRecommendation(input: {
    recommendation: DecisionRecommendation;
    action: DecisionActionDefinition;
    downstreamLogicalIdentity: string;
  }): Promise<{ portfolioProposalId: string }>;
}

export interface ExperimentProposalPort {
  proposeFromRecommendation(input: {
    recommendation: DecisionRecommendation;
    action: DecisionActionDefinition;
    downstreamLogicalIdentity: string;
  }): Promise<{ experimentProposalId: string }>;
}

export interface DecisionRecommendationCompilerDeps {
  /**
   * When false (Phase 19 default), recommend() persists only.
   * Materialize requires an explicit call AND this flag or equivalent grant.
   */
  allowMaterialization?: boolean;
  objectiveAdmission?: ObjectiveAdmissionPort;
  programProposal?: ProgramProposalPort;
  portfolioProposal?: PortfolioProposalPort;
  experimentProposal?: ExperimentProposalPort;
}

export type MaterializationResult =
  | { kind: "PERSISTED_ONLY"; recommendationId: string }
  | {
      kind: "OBJECTIVE_PROPOSAL";
      recommendationId: string;
      objectiveAdmissionId: string;
      runId?: string;
      downstreamLogicalIdentity: string;
    }
  | {
      kind: "PROGRAM_PROPOSAL";
      recommendationId: string;
      programProposalId: string;
      downstreamLogicalIdentity: string;
    }
  | {
      kind: "PORTFOLIO_PROPOSAL";
      recommendationId: string;
      portfolioProposalId: string;
      downstreamLogicalIdentity: string;
    }
  | {
      kind: "EXPERIMENT_PROPOSAL";
      recommendationId: string;
      experimentProposalId: string;
      downstreamLogicalIdentity: string;
    }
  | { kind: "NO_ACTION"; recommendationId: string };

export const DecisionRecommendationMaterializationLineageSchema = z
  .object({
    materializationLineageId: z.string().min(1),
    recommendationId: z.string().min(1),
    recommendationHash: z.string().min(1),
    decisionPolicyId: z.string().min(1),
    decisionPolicyVersion: z.number().int().positive(),
    policyHash: z.string().min(1),
    activationId: z.string().min(1),
    activationHash: z.string().min(1),
    stateSnapshotHash: z.string().min(1),
    actionId: z.string().min(1),
    executionPath: ExecutionPathSchema,
    downstreamLogicalIdentity: z.string().min(1),
    downstreamObjectId: z.string().min(1),
    materializationStatus: z.enum(["ADMITTED_DOWNSTREAM", "SETTLED", "FAILED"]),
    createdAt: z.string().datetime(),
    lineageHash: z.string().min(1),
  })
  .strict();

export type DecisionRecommendationMaterializationLineage = z.infer<
  typeof DecisionRecommendationMaterializationLineageSchema
>;

export function mintDownstreamLogicalIdentity(input: {
  recommendationHash: string;
  actionId: string;
  executionPath: string;
}): string {
  return createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex");
}

export function mintMaterializationLineageId(
  recommendationHash: string,
): string {
  return `dmlin_${recommendationHash.slice(0, 24)}`;
}

export function computeLineageHash(
  input: Omit<
    DecisionRecommendationMaterializationLineage,
    "lineageHash"
  >,
): string {
  return createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex");
}

export interface DecisionRecommendationMaterializationLineageRepository {
  save(
    lineage: DecisionRecommendationMaterializationLineage,
  ): Promise<DecisionRecommendationMaterializationLineage>;
  getById(
    materializationLineageId: string,
  ): Promise<DecisionRecommendationMaterializationLineage | null>;
  getByRecommendationHash(
    recommendationHash: string,
  ): Promise<DecisionRecommendationMaterializationLineage | null>;
}

export class InMemoryDecisionRecommendationMaterializationLineageRepository
  implements DecisionRecommendationMaterializationLineageRepository
{
  private readonly byId = new Map<
    string,
    DecisionRecommendationMaterializationLineage
  >();
  private readonly byRecHash = new Map<string, string>();

  async save(lineage: DecisionRecommendationMaterializationLineage) {
    const parsed =
      DecisionRecommendationMaterializationLineageSchema.parse(lineage);
    const existing = this.byId.get(parsed.materializationLineageId);
    if (existing) {
      return existing;
    }
    this.byId.set(parsed.materializationLineageId, parsed);
    this.byRecHash.set(
      parsed.recommendationHash,
      parsed.materializationLineageId,
    );
    return parsed;
  }

  async getById(id: string) {
    return this.byId.get(id) ?? null;
  }

  async getByRecommendationHash(recommendationHash: string) {
    const id = this.byRecHash.get(recommendationHash);
    return id ? (this.byId.get(id) ?? null) : null;
  }
}

export class DecisionRecommendationCompiler {
  constructor(private readonly deps: DecisionRecommendationCompilerDeps) {}

  persistOnly(recommendation: DecisionRecommendation): MaterializationResult {
    if (
      recommendation.executionPath === "NO_ACTION" ||
      recommendation.recommendedActionId === "action_no_action"
    ) {
      return {
        kind: "NO_ACTION",
        recommendationId: recommendation.decisionRecommendationId,
      };
    }
    return {
      kind: "PERSISTED_ONLY",
      recommendationId: recommendation.decisionRecommendationId,
    };
  }

  async materialize(input: {
    recommendation: DecisionRecommendation;
    action: DecisionActionDefinition;
  }): Promise<MaterializationResult> {
    const { recommendation, action } = input;
    if (action.executionPath === "NO_ACTION") {
      return {
        kind: "NO_ACTION",
        recommendationId: recommendation.decisionRecommendationId,
      };
    }
    if (!this.deps.allowMaterialization) {
      throw new DecisionPolicyError(
        "DECISION_MATERIALIZATION_NOT_PERMITTED",
        "ACTIVE policy does not grant automatic proposal submission",
      );
    }
    const downstreamLogicalIdentity = mintDownstreamLogicalIdentity({
      recommendationHash: recommendation.recommendationHash,
      actionId: action.actionId,
      executionPath: action.executionPath,
    });
    switch (action.executionPath) {
      case "OBJECTIVE": {
        if (!this.deps.objectiveAdmission) {
          throw new DecisionPolicyError(
            "DECISION_DOWNSTREAM_PORT_UNAVAILABLE",
            "OBJECTIVE materialization requires canonical Phase 2 admission adapter",
          );
        }
        const result = await this.deps.objectiveAdmission.admitFromRecommendation({
          recommendation,
          action,
          downstreamLogicalIdentity,
        });
        return {
          kind: "OBJECTIVE_PROPOSAL",
          recommendationId: recommendation.decisionRecommendationId,
          objectiveAdmissionId: result.objectiveAdmissionId,
          ...(result.runId ? { runId: result.runId } : {}),
          downstreamLogicalIdentity,
        };
      }
      case "PROGRAM": {
        if (!this.deps.programProposal) {
          throw new DecisionPolicyError(
            "DECISION_DOWNSTREAM_PORT_UNAVAILABLE",
            "PROGRAM materialization requires canonical Phase 14 adapter",
          );
        }
        const result = await this.deps.programProposal.proposeFromRecommendation({
          recommendation,
          action,
          downstreamLogicalIdentity,
        });
        return {
          kind: "PROGRAM_PROPOSAL",
          recommendationId: recommendation.decisionRecommendationId,
          programProposalId: result.programProposalId,
          downstreamLogicalIdentity,
        };
      }
      case "PORTFOLIO_PROPOSAL": {
        if (!this.deps.portfolioProposal) {
          throw new DecisionPolicyError(
            "DECISION_DOWNSTREAM_PORT_UNAVAILABLE",
            "PORTFOLIO_PROPOSAL materialization requires canonical Phase 15 adapter",
          );
        }
        const result =
          await this.deps.portfolioProposal.proposeFromRecommendation({
            recommendation,
            action,
            downstreamLogicalIdentity,
          });
        return {
          kind: "PORTFOLIO_PROPOSAL",
          recommendationId: recommendation.decisionRecommendationId,
          portfolioProposalId: result.portfolioProposalId,
          downstreamLogicalIdentity,
        };
      }
      case "EXPERIMENT_PROPOSAL": {
        if (!this.deps.experimentProposal) {
          throw new DecisionPolicyError(
            "DECISION_DOWNSTREAM_PORT_UNAVAILABLE",
            "EXPERIMENT_PROPOSAL materialization requires canonical Phase 17 adapter",
          );
        }
        const result =
          await this.deps.experimentProposal.proposeFromRecommendation({
            recommendation,
            action,
            downstreamLogicalIdentity,
          });
        return {
          kind: "EXPERIMENT_PROPOSAL",
          recommendationId: recommendation.decisionRecommendationId,
          experimentProposalId: result.experimentProposalId,
          downstreamLogicalIdentity,
        };
      }
      default: {
        const _exhaustive: never = action.executionPath;
        return _exhaustive;
      }
    }
  }
}

/** Test double — idempotent by downstreamLogicalIdentity; not a real Run. */
export class RecordingObjectiveAdmissionPort implements ObjectiveAdmissionPort {
  readonly submissions: DecisionRecommendation[] = [];
  readonly byIdentity = new Map<
    string,
    { objectiveAdmissionId: string; runId?: string }
  >();
  admitCalls = 0;

  async admitFromRecommendation(input: {
    recommendation: DecisionRecommendation;
    action: DecisionActionDefinition;
    downstreamLogicalIdentity: string;
  }): Promise<{ objectiveAdmissionId: string; runId?: string }> {
    const existing = this.byIdentity.get(input.downstreamLogicalIdentity);
    if (existing) {
      return existing;
    }
    this.admitCalls += 1;
    this.submissions.push(input.recommendation);
    const created = {
      objectiveAdmissionId: `obj_from_${input.downstreamLogicalIdentity.slice(0, 16)}`,
    };
    this.byIdentity.set(input.downstreamLogicalIdentity, created);
    return created;
  }
}
