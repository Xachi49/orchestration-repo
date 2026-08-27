import { createHash } from "node:crypto";
import { z } from "zod";
import type { CausalQuestion } from "./question.js";
import type { CausalEdge, CausalGraph } from "./graph.js";
import { CausalVariableSchema } from "./variables.js";

export interface CausalGraphProposal {
  nodes: z.infer<typeof CausalVariableSchema>[];
  edges: Array<{
    fromVariableId: string;
    toVariableId: string;
    edgeType: CausalEdge["edgeType"];
    provenance: CausalEdge["provenance"];
    note?: string;
  }>;
  candidateIdentificationStrategies: Array<
    "RANDOMIZED_TREATMENT" | "BACKDOOR_ADJUSTMENT" | "UNIDENTIFIED"
  >;
  /** Untrusted — service must ignore for authority. */
  untrustedSuggestedIdentified?: boolean;
}

export interface CausalGraphProposalModel {
  readonly modelId: string;
  readonly modelVersion: string;
  propose(input: { question: CausalQuestion }): Promise<CausalGraphProposal>;
}

/**
 * Deterministic fake proposer. Output is DATA only.
 * MODEL_PROPOSED edges are never treated as verified causation.
 */
export class FakeCausalGraphProposalModel implements CausalGraphProposalModel {
  readonly modelId = "fake_causal_graph_v1";
  readonly modelVersion = "1.0.0";

  async propose(input: {
    question: CausalQuestion;
  }): Promise<CausalGraphProposal> {
    const q = input.question;
    const interventionId = `var_int_${q.causalQuestionId}`;
    const outcomeId = `var_out_${q.causalQuestionId}`;
    const confounderId = `var_conf_${q.causalQuestionId}`;
    const nodes = [
      CausalVariableSchema.parse({
        variableId: interventionId,
        name: "intervention",
        description: q.intervention,
        unit: q.interventionUnit,
        variableClass: "INTERVENTION",
        source: "causal_question",
        measurementDefinition: q.intervention,
        populationScope: q.targetPopulation,
        environmentScope: q.targetEnvironment,
      }),
      CausalVariableSchema.parse({
        variableId: outcomeId,
        name: "outcome",
        description: q.outcome,
        unit: q.outcomeUnit,
        variableClass: "OUTCOME",
        source: "causal_question",
        measurementDefinition: q.outcome,
        populationScope: q.targetPopulation,
        environmentScope: q.targetEnvironment,
      }),
      CausalVariableSchema.parse({
        variableId: confounderId,
        name: "candidate_confounder",
        description: q.candidateConfounders[0] ?? "unmeasured_or_candidate",
        unit: "DIMENSIONLESS",
        variableClass: "CONFOUNDER",
        source: "model_proposal",
        measurementDefinition: q.candidateConfounders[0] ?? "unknown",
        populationScope: q.targetPopulation,
        environmentScope: q.targetEnvironment,
      }),
    ];
    const edges: CausalGraphProposal["edges"] = [
      {
        fromVariableId: interventionId,
        toVariableId: outcomeId,
        edgeType: "CAUSES",
        provenance: "MODEL_PROPOSED",
        note: "Model-proposed causal edge — not verified",
      },
      {
        fromVariableId: confounderId,
        toVariableId: interventionId,
        edgeType: "CONFOUNDS",
        provenance: "MODEL_PROPOSED",
      },
      {
        fromVariableId: confounderId,
        toVariableId: outcomeId,
        edgeType: "CONFOUNDS",
        provenance: "MODEL_PROPOSED",
      },
    ];
    const hasExperiment = q.sourceExperimentIds.length > 0;
    return {
      nodes,
      edges,
      candidateIdentificationStrategies: hasExperiment
        ? ["RANDOMIZED_TREATMENT", "UNIDENTIFIED"]
        : ["BACKDOOR_ADJUSTMENT", "UNIDENTIFIED"],
      untrustedSuggestedIdentified: true,
    };
  }
}

export function mintEdgeId(input: {
  fromVariableId: string;
  toVariableId: string;
  edgeType: string;
  provenance: string;
}): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex")
    .slice(0, 12);
  return `edge_${digest}`;
}

export type { CausalGraph };
