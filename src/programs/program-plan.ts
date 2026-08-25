import { createHash } from "node:crypto";
import { z } from "zod";
import { BudgetResourceEstimateSchema } from "../control-plane/budgets/budget.js";
import { ObjectivePrioritySchema } from "../domain/objective/objective.js";

export const INITIAL_PROGRAM_PLAN_VERSION = 1;

export const ProgramNodeRequirementSchema = z.enum(["REQUIRED", "OPTIONAL"]);
export type ProgramNodeRequirement = z.infer<
  typeof ProgramNodeRequirementSchema
>;

export const ProgramNodeDispositionSchema = z.enum([
  "NEW",
  "RETAINED",
  "SUPERSEDED",
]);
export type ProgramNodeDisposition = z.infer<
  typeof ProgramNodeDispositionSchema
>;

/**
 * Explicit binding from a child node's verified completion to a root criterion.
 * Semantic relevance alone is never enough.
 */
export const ProgramCriterionContributionBindingSchema = z
  .object({
    rootCriterionIndex: z.number().int().nonnegative(),
    /** Child acceptance-criterion index that must be proven by CompletionRecord. */
    childCriterionIndex: z.number().int().nonnegative(),
    contributionKind: z.enum([
      "SATISFIES",
      "PARTIAL_EVIDENCE",
      "PREREQUISITE_ONLY",
    ]),
    evidenceRequirement: z.enum([
      "COMPLETION_RECORD",
      "COMPLETION_AND_VERIFICATION",
    ]),
  })
  .strict();

export type ProgramCriterionContributionBinding = z.infer<
  typeof ProgramCriterionContributionBindingSchema
>;

export const ChildProgramNodeSchema = z
  .object({
    nodeId: z.string().min(1),
    title: z.string().min(1),
    requestedOutcome: z.string().min(1),
    acceptanceCriteria: z.array(z.string().min(1)).min(1),
    nonGoals: z.array(z.string()),
    constraints: z.array(z.string()),
    priority: ObjectivePrioritySchema,
    requirement: ProgramNodeRequirementSchema,
    requestedProjectId: z.string().min(1),
    requestedEnvironment: z.string().min(1),
    requestedCapabilityIds: z.array(z.string().min(1)),
    requestedRepositoryIdentities: z.array(z.string().min(1)),
    requestedBudget: BudgetResourceEstimateSchema,
    criterionBindings: z
      .array(ProgramCriterionContributionBindingSchema)
      .min(1),
    parentNodeId: z.string().min(1).optional(),
    depth: z.number().int().nonnegative(),
    disposition: ProgramNodeDispositionSchema.default("NEW"),
    retainedFromPlanVersion: z.number().int().positive().optional(),
  })
  .strict();

export type ChildProgramNode = z.infer<typeof ChildProgramNodeSchema>;

export const ProgramDependencyMilestoneSchema = z.enum([
  "REPOSITORY_VERIFIED",
  "PLAN_VALIDATED",
  "APPROVED",
  "COMPLETED",
]);

export const ProgramPlanEdgeSchema = z
  .object({
    edgeId: z.string().min(1),
    fromNodeId: z.string().min(1),
    toNodeId: z.string().min(1),
    requiredMilestone: ProgramDependencyMilestoneSchema,
  })
  .strict();

export type ProgramPlanEdge = z.infer<typeof ProgramPlanEdgeSchema>;

export const ProgramPlanSchema = z
  .object({
    programId: z.string().min(1),
    programPlanVersion: z.number().int().positive(),
    programPlanHash: z.string().min(1),
    nodes: z.array(ChildProgramNodeSchema).min(1),
    edges: z.array(ProgramPlanEdgeSchema),
    requiredNodeIds: z.array(z.string().min(1)),
    optionalNodeIds: z.array(z.string().min(1)),
    decompositionProposalHash: z.string().min(1),
    compilerVersion: z.string().min(1),
    modelProviderId: z.string().min(1).optional(),
    inputContextFingerprint: z.string().min(1),
    revisionAttempt: z.number().int().nonnegative(),
    createdAt: z.string().datetime(),
  })
  .strict();

export type ProgramPlan = z.infer<typeof ProgramPlanSchema>;

export function parseProgramPlan(input: unknown): ProgramPlan {
  return ProgramPlanSchema.parse(input);
}

/** Deterministic node identity within a plan (not array position). */
export function programNodeId(input: {
  programId: string;
  programPlanVersion: number;
  title: string;
  requestedOutcome: string;
  parentNodeId?: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        outcome: input.requestedOutcome,
        parentNodeId: input.parentNodeId ?? null,
        planVersion: input.programPlanVersion,
        programId: input.programId,
        title: input.title,
      }),
      "utf8",
    )
    .digest("hex")
    .slice(0, 24);
}

export function canonicalizeProgramPlanBody(input: {
  programId: string;
  programPlanVersion: number;
  nodes: readonly ChildProgramNode[];
  edges: readonly ProgramPlanEdge[];
}): string {
  const nodes = [...input.nodes]
    .map((n) => ({
      ...n,
      acceptanceCriteria: [...n.acceptanceCriteria],
      constraints: [...n.constraints],
      criterionBindings: [...n.criterionBindings].sort(
        (a, b) => a.rootCriterionIndex - b.rootCriterionIndex,
      ),
      nonGoals: [...n.nonGoals],
      requestedCapabilityIds: [...n.requestedCapabilityIds].sort(),
      requestedRepositoryIdentities: [
        ...n.requestedRepositoryIdentities,
      ].sort(),
    }))
    .sort((a, b) => a.nodeId.localeCompare(b.nodeId));
  const edges = [...input.edges].sort((a, b) =>
    a.edgeId.localeCompare(b.edgeId),
  );
  return JSON.stringify({
    edges,
    nodes,
    programId: input.programId,
    programPlanVersion: input.programPlanVersion,
  });
}

export function programPlanHash(input: {
  programId: string;
  programPlanVersion: number;
  nodes: readonly ChildProgramNode[];
  edges: readonly ProgramPlanEdge[];
}): string {
  return createHash("sha256")
    .update(canonicalizeProgramPlanBody(input), "utf8")
    .digest("hex");
}

export const PROGRAM_PLAN_COMPILER_VERSION = "program-plan-compiler/1";
