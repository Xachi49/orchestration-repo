import { createHash } from "node:crypto";
import type { Program } from "./program.js";
import type {
  ChildProgramNode,
  ProgramPlan,
  ProgramPlanEdge,
} from "./program-plan.js";
import {
  childWeakensConstraints,
  intersectChildAuthority,
} from "./authority.js";
import {
  exceedsCeiling,
  sumNodeBudgets,
} from "./budget.js";
import { ProgramError } from "./errors.js";

export const PROGRAM_VALIDATION_STEPS = [
  "SCHEMA",
  "GRAPH",
  "DEPTH",
  "FAN_OUT",
  "CHILD_COUNT",
  "PROJECT_SCOPE",
  "REPOSITORY_SCOPE",
  "POLICY",
  "CAPABILITY",
  "ENVIRONMENT",
  "BUDGET",
  "DEPENDENCY",
  "COMPLETION_BINDING",
  "SECURITY",
] as const;

export type ProgramValidationStep = (typeof PROGRAM_VALIDATION_STEPS)[number];

export interface ProgramValidationFinding {
  step: ProgramValidationStep;
  severity: "BLOCK" | "WARN";
  code: string;
  message: string;
  nodeId?: string;
}

export interface ProgramValidationResult {
  valid: boolean;
  findings: readonly ProgramValidationFinding[];
}

/**
 * Deterministic ProgramGraphValidator.
 * Model output cannot override BLOCK findings.
 */
export function validateProgramPlan(
  program: Program,
  plan: Omit<ProgramPlan, "programPlanHash"> & { programPlanHash?: string },
): ProgramValidationResult {
  const findings: ProgramValidationFinding[] = [];

  const nodeIds = new Set(plan.nodes.map((n) => n.nodeId));
  if (nodeIds.size !== plan.nodes.length) {
    findings.push({
      step: "SCHEMA",
      severity: "BLOCK",
      code: "DUPLICATE_NODE_ID",
      message: "Program plan has duplicate nodeIds",
    });
  }

  for (const edge of plan.edges) {
    if (!nodeIds.has(edge.fromNodeId) || !nodeIds.has(edge.toNodeId)) {
      findings.push({
        step: "GRAPH",
        severity: "BLOCK",
        code: "MISSING_EDGE_ENDPOINT",
        message: `Edge ${edge.edgeId} references unknown node`,
      });
    }
    if (edge.fromNodeId === edge.toNodeId) {
      findings.push({
        step: "GRAPH",
        severity: "BLOCK",
        code: "SELF_DEPENDENCY",
        message: `Edge ${edge.edgeId} is a self-dependency`,
        nodeId: edge.fromNodeId,
      });
    }
  }

  if (hasCycle(plan.nodes, plan.edges)) {
    findings.push({
      step: "GRAPH",
      severity: "BLOCK",
      code: "PROGRAM_GRAPH_CYCLE",
      message: "Program plan graph contains a cycle",
    });
  }

  const maxDepth = Math.max(0, ...plan.nodes.map((n) => n.depth));
  if (maxDepth > program.delegationEnvelope.maximumDepth) {
    findings.push({
      step: "DEPTH",
      severity: "BLOCK",
      code: "PROGRAM_DEPTH_EXCEEDED",
      message: `Depth ${maxDepth} exceeds maximumDepth ${program.delegationEnvelope.maximumDepth}`,
    });
  }

  if (plan.nodes.length > program.delegationEnvelope.maximumChildren) {
    findings.push({
      step: "CHILD_COUNT",
      severity: "BLOCK",
      code: "PROGRAM_CHILD_COUNT_EXCEEDED",
      message: `Child count ${plan.nodes.length} exceeds maximumChildren ${program.delegationEnvelope.maximumChildren}`,
    });
  }

  const childrenByParent = new Map<string | null, number>();
  for (const node of plan.nodes) {
    const key = node.parentNodeId ?? null;
    childrenByParent.set(key, (childrenByParent.get(key) ?? 0) + 1);
  }
  for (const [parent, count] of childrenByParent) {
    if (count > program.delegationEnvelope.maximumFanOut) {
      findings.push({
        step: "FAN_OUT",
        severity: "BLOCK",
        code: "PROGRAM_FAN_OUT_EXCEEDED",
        message: `Fan-out ${count} under ${parent ?? "root"} exceeds maximumFanOut ${program.delegationEnvelope.maximumFanOut}`,
        ...(parent ? { nodeId: parent } : {}),
      });
    }
  }

  const totalBudget = sumNodeBudgets(plan.nodes.map((n) => n.requestedBudget));
  if (
    exceedsCeiling(totalBudget, program.delegationEnvelope.maximumProgramBudget)
  ) {
    findings.push({
      step: "BUDGET",
      severity: "BLOCK",
      code: "PROGRAM_BUDGET_MULTIPLICATION",
      message: "Sum of child budgets exceeds maximumProgramBudget",
    });
  }

  const parentConstraints = program.rootIntent.constraints;
  for (const node of plan.nodes) {
    const auth = intersectChildAuthority({
      envelope: program.delegationEnvelope,
      requestedProjectId: node.requestedProjectId,
      requestedEnvironment: node.requestedEnvironment,
      requestedCapabilityIds: node.requestedCapabilityIds,
      requestedRepositoryIdentities: node.requestedRepositoryIdentities,
      requestedBudget: node.requestedBudget,
    });
    if (!auth.ok) {
      const step: ProgramValidationStep =
        auth.reasonCode.includes("CAPABILITY")
          ? "CAPABILITY"
          : auth.reasonCode.includes("REPOSITORY")
            ? "REPOSITORY_SCOPE"
            : auth.reasonCode.includes("PROJECT") ||
                auth.reasonCode.includes("CROSS_PROJECT")
              ? "PROJECT_SCOPE"
              : auth.reasonCode.includes("ENVIRONMENT")
                ? "ENVIRONMENT"
                : "BUDGET";
      findings.push({
        step,
        severity: "BLOCK",
        code: auth.reasonCode,
        message: auth.message,
        nodeId: node.nodeId,
      });
    }

    if (childWeakensConstraints(parentConstraints, node.constraints)) {
      findings.push({
        step: "POLICY",
        severity: "BLOCK",
        code: "POLICY_WEAKENING_REJECTED",
        message: "Child constraints weaken parent deny constraints",
        nodeId: node.nodeId,
      });
    }

    // Security: reject production deployment proposals under no-production parents.
    // Do not treat the parent's deny string itself as a proposal when inherited.
    const parentDeniesProd = parentConstraints.some((c) =>
      /no\s+production|no\s+deploy/i.test(c),
    );
    const childProposesProd =
      /(?:^|[^\w])(?:deploy(?:ment)?\s+to\s+production|production\s+deploy)/i.test(
        node.requestedOutcome,
      ) ||
      node.constraints.some(
        (c) =>
          !/no\s+production|no\s+deploy/i.test(c) &&
          /production\s+deploy|deploy\s+to\s+production/i.test(c),
      );
    if (parentDeniesProd && childProposesProd) {
      findings.push({
        step: "SECURITY",
        severity: "BLOCK",
        code: "POLICY_WEAKENING_REJECTED",
        message: "Child proposes production deployment under parent deny",
        nodeId: node.nodeId,
      });
    }
  }

  const criterionCount = program.rootIntent.acceptanceCriteria.length;
  const covered = new Set<number>();
  for (const node of plan.nodes) {
    for (const binding of node.criterionBindings) {
      if (binding.rootCriterionIndex >= criterionCount) {
        findings.push({
          step: "COMPLETION_BINDING",
          severity: "BLOCK",
          code: "COMPLETION_BINDING_INCOMPLETE",
          message: `Binding references criterion index ${binding.rootCriterionIndex} out of range`,
          nodeId: node.nodeId,
        });
      } else if (binding.contributionKind === "SATISFIES") {
        covered.add(binding.rootCriterionIndex);
      }
    }
  }
  for (let i = 0; i < criterionCount; i++) {
    if (!covered.has(i)) {
      findings.push({
        step: "COMPLETION_BINDING",
        severity: "BLOCK",
        code: "COMPLETION_BINDING_INCOMPLETE",
        message: `Root criterion ${i} has no SATISFIES binding`,
      });
    }
  }

  const requiredIds = new Set(
    plan.nodes.filter((n) => n.requirement === "REQUIRED").map((n) => n.nodeId),
  );
  for (const id of plan.requiredNodeIds) {
    if (!requiredIds.has(id) && !nodeIds.has(id)) {
      findings.push({
        step: "DEPENDENCY",
        severity: "BLOCK",
        code: "REQUIRED_NODE_UNKNOWN",
        message: `requiredNodeIds references unknown node ${id}`,
      });
    }
  }

  const valid = !findings.some((f) => f.severity === "BLOCK");
  return { valid, findings };
}

function hasCycle(
  nodes: readonly ChildProgramNode[],
  edges: readonly ProgramPlanEdge[],
): boolean {
  const adj = new Map<string, string[]>();
  for (const n of nodes) {
    adj.set(n.nodeId, []);
  }
  for (const e of edges) {
    adj.get(e.fromNodeId)?.push(e.toNodeId);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const dfs = (id: string): boolean => {
    if (visiting.has(id)) {
      return true;
    }
    if (visited.has(id)) {
      return false;
    }
    visiting.add(id);
    for (const next of adj.get(id) ?? []) {
      if (dfs(next)) {
        return true;
      }
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  for (const n of nodes) {
    if (dfs(n.nodeId)) {
      return true;
    }
  }
  return false;
}

export function assertValidProgramPlan(
  program: Program,
  plan: Omit<ProgramPlan, "programPlanHash"> & { programPlanHash?: string },
): void {
  const result = validateProgramPlan(program, plan);
  if (!result.valid) {
    throw new ProgramError(
      "PROGRAM_PLAN_INVALID",
      "Program plan failed deterministic validation",
      {
        findings: result.findings.filter((f) => f.severity === "BLOCK"),
      },
    );
  }
}

export function validationResultHash(
  result: ProgramValidationResult,
): string {
  return createHash("sha256")
    .update(JSON.stringify(result), "utf8")
    .digest("hex");
}
