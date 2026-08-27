import { createHash } from "node:crypto";
import { z } from "zod";
import { CausalVariableSchema } from "./variables.js";

export const INITIAL_CAUSAL_GRAPH_VERSION = 1;

export const CAUSAL_EDGE_TYPES = [
  "CAUSES",
  "POSSIBLY_CAUSES",
  "MEDIATES",
  "CONFOUNDS",
  "MODERATES",
] as const;

export const CausalEdgeTypeSchema = z.enum(CAUSAL_EDGE_TYPES);
export type CausalEdgeType = z.infer<typeof CausalEdgeTypeSchema>;

export const CAUSAL_EDGE_PROVENANCE = [
  "MODEL_PROPOSED",
  "HUMAN_PROVIDED",
  "EXPERIMENT_SUPPORTED",
  "OBSERVATIONAL_ASSOCIATION",
  "GOVERNED_PRECEDENT",
  "DOMAIN_CONSTRAINT",
] as const;

export const CausalEdgeProvenanceSchema = z.enum(CAUSAL_EDGE_PROVENANCE);
export type CausalEdgeProvenance = z.infer<typeof CausalEdgeProvenanceSchema>;

export const CausalEdgeSchema = z
  .object({
    edgeId: z.string().min(1),
    fromVariableId: z.string().min(1),
    toVariableId: z.string().min(1),
    edgeType: CausalEdgeTypeSchema,
    provenance: CausalEdgeProvenanceSchema,
    note: z.string().max(2000).optional(),
  })
  .strict();

export type CausalEdge = z.infer<typeof CausalEdgeSchema>;

export const CausalGraphSchema = z
  .object({
    causalGraphId: z.string().min(1),
    causalGraphVersion: z.number().int().positive(),
    causalQuestionId: z.string().min(1),
    causalQuestionVersion: z.number().int().positive(),
    nodes: z.array(CausalVariableSchema).min(2),
    edges: z.array(CausalEdgeSchema).default([]),
    graphHash: z.string().min(1),
    createdAt: z.string().datetime(),
    createdBy: z.string().min(1),
    /** MODEL_PROPOSED edges are DATA, never verified causal truth. */
    containsModelProposedEdges: z.boolean(),
  })
  .strict();

export type CausalGraph = z.infer<typeof CausalGraphSchema>;

export function computeCausalGraphHash(input: {
  causalQuestionId: string;
  causalQuestionVersion: number;
  nodes: CausalGraph["nodes"];
  edges: CausalGraph["edges"];
}): string {
  const nodes = [...input.nodes]
    .map((n) => ({ ...n }))
    .sort((a, b) => a.variableId.localeCompare(b.variableId));
  const edges = [...input.edges]
    .map((e) => ({ ...e }))
    .sort((a, b) => a.edgeId.localeCompare(b.edgeId));
  return createHash("sha256")
    .update(
      JSON.stringify({
        causalQuestionId: input.causalQuestionId,
        causalQuestionVersion: input.causalQuestionVersion,
        nodes,
        edges,
      }),
      "utf8",
    )
    .digest("hex");
}

export function withCausalGraphHash(
  graph: Omit<CausalGraph, "graphHash" | "containsModelProposedEdges"> & {
    graphHash?: string;
    containsModelProposedEdges?: boolean;
  },
): CausalGraph {
  const containsModelProposedEdges = graph.edges.some(
    (e) => e.provenance === "MODEL_PROPOSED",
  );
  const graphHash = computeCausalGraphHash(graph);
  return CausalGraphSchema.parse({
    ...graph,
    containsModelProposedEdges,
    graphHash,
  });
}

export function mintCausalGraphId(input: {
  causalQuestionId: string;
  causalGraphVersion: number;
}): string {
  return `cg_${input.causalQuestionId}_v${input.causalGraphVersion}`;
}

/** MODEL_PROPOSED != verified causal edge. */
export function isVerifiedCausalEdge(edge: CausalEdge): boolean {
  return (
    edge.provenance === "EXPERIMENT_SUPPORTED" ||
    edge.provenance === "HUMAN_PROVIDED" ||
    edge.provenance === "DOMAIN_CONSTRAINT" ||
    edge.provenance === "GOVERNED_PRECEDENT"
  );
}
