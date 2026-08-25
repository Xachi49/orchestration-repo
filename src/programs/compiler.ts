import {
  PROGRAM_PLAN_COMPILER_VERSION,
  programNodeId,
  programPlanHash,
  type ChildProgramNode,
  type ProgramPlan,
  type ProgramPlanEdge,
} from "./program-plan.js";
import type { Program } from "./program.js";
import {
  decompositionProposalHash,
  programInputContextFingerprint,
  type DecompositionProposal,
} from "./decomposition-model.js";
import { emptyBudgetEstimate } from "./budget.js";

/**
 * Compiles untrusted decomposition proposals into a deterministic ProgramPlan body.
 * Does not validate authority — validator owns that.
 */
export function compileProgramPlan(input: {
  program: Program;
  proposal: DecompositionProposal;
  programPlanVersion: number;
  revisionAttempt: number;
  createdAt: string;
}): Omit<ProgramPlan, "programPlanHash"> & { programPlanHash: string } {
  const { program, proposal } = input;
  const titleToId = new Map<string, string>();
  const nodes: ChildProgramNode[] = [];

  for (const child of proposal.children) {
    const depth = child.parentTitle
      ? (nodes.find((n) => n.title === child.parentTitle)?.depth ?? 0) + 1
      : 0;
    const parentNodeId = child.parentTitle
      ? titleToId.get(child.parentTitle)
      : undefined;
    const nodeId = programNodeId({
      programId: program.programId,
      programPlanVersion: input.programPlanVersion,
      title: child.title,
      requestedOutcome: child.requestedOutcome,
      ...(parentNodeId ? { parentNodeId } : {}),
    });
    titleToId.set(child.title, nodeId);
    nodes.push({
      nodeId,
      title: child.title,
      requestedOutcome: child.requestedOutcome,
      acceptanceCriteria: [...child.acceptanceCriteria],
      nonGoals: [...child.nonGoals],
      constraints: [...child.constraints],
      priority: child.priority,
      requirement: child.requirement,
      requestedProjectId: child.requestedProjectId ?? program.projectId,
      requestedEnvironment:
        child.requestedEnvironment ?? program.requestedEnvironment,
      requestedCapabilityIds: [...child.requestedCapabilityIds],
      requestedRepositoryIdentities: [...child.requestedRepositoryIdentities],
      requestedBudget: child.requestedBudget ?? emptyBudgetEstimate(),
      criterionBindings: [...child.criterionBindings],
      ...(parentNodeId ? { parentNodeId } : {}),
      depth,
      disposition: "NEW",
    });
  }

  const edges: ProgramPlanEdge[] = [];
  for (const child of proposal.children) {
    const toId = titleToId.get(child.title)!;
    for (const depTitle of child.dependsOnTitles) {
      const fromId = titleToId.get(depTitle);
      if (!fromId) {
        continue;
      }
      edges.push({
        edgeId: `edge_${fromId}_${toId}`,
        fromNodeId: fromId,
        toNodeId: toId,
        requiredMilestone: "COMPLETED",
      });
    }
  }

  const requiredNodeIds = nodes
    .filter((n) => n.requirement === "REQUIRED")
    .map((n) => n.nodeId);
  const optionalNodeIds = nodes
    .filter((n) => n.requirement === "OPTIONAL")
    .map((n) => n.nodeId);

  const body = {
    programId: program.programId,
    programPlanVersion: input.programPlanVersion,
    nodes,
    edges,
    requiredNodeIds,
    optionalNodeIds,
    decompositionProposalHash: decompositionProposalHash(proposal),
    compilerVersion: PROGRAM_PLAN_COMPILER_VERSION,
    modelProviderId: proposal.modelProviderId,
    inputContextFingerprint: programInputContextFingerprint(program),
    revisionAttempt: input.revisionAttempt,
    createdAt: input.createdAt,
  };
  const hash = programPlanHash(body);
  return { ...body, programPlanHash: hash };
}
