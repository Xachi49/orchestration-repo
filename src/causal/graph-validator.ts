import { CausalError } from "./errors.js";
import type { CausalGraph } from "./graph.js";
import type { CausalQuestion } from "./question.js";

export interface CausalGraphValidationResult {
  outcome: "PASS" | "BLOCK";
  reasons: string[];
}

/**
 * Deterministic graph validator. Prefer DAG semantics.
 * Cycles fail closed: CAUSAL_GRAPH_CYCLE_UNSUPPORTED.
 */
export function validateCausalGraph(
  graph: CausalGraph,
  question: CausalQuestion,
): CausalGraphValidationResult {
  const reasons: string[] = [];
  const nodeIds = new Set<string>();
  for (const node of graph.nodes) {
    if (nodeIds.has(node.variableId)) {
      reasons.push(`duplicate node ${node.variableId}`);
    }
    nodeIds.add(node.variableId);
  }

  const edgeKeys = new Set<string>();
  for (const edge of graph.edges) {
    if (!nodeIds.has(edge.fromVariableId) || !nodeIds.has(edge.toVariableId)) {
      reasons.push(`edge ${edge.edgeId} references unknown node`);
    }
    if (edge.fromVariableId === edge.toVariableId) {
      reasons.push(`illegal self-edge ${edge.edgeId}`);
    }
    const key = `${edge.fromVariableId}->${edge.toVariableId}:${edge.edgeType}:${edge.provenance}`;
    if (edgeKeys.has(key)) {
      reasons.push(`duplicate edge ${key}`);
    }
    edgeKeys.add(key);
  }

  const interventions = graph.nodes.filter(
    (n) => n.variableClass === "INTERVENTION",
  );
  const outcomes = graph.nodes.filter((n) => n.variableClass === "OUTCOME");
  if (interventions.length < 1) {
    reasons.push("required INTERVENTION node missing");
  }
  if (outcomes.length < 1) {
    reasons.push("required OUTCOME node missing");
  }

  for (const node of interventions) {
    if (node.unit !== question.interventionUnit) {
      reasons.push(
        `intervention unit ${node.unit} != question ${question.interventionUnit}`,
      );
    }
  }
  for (const node of outcomes) {
    if (node.unit !== question.outcomeUnit) {
      reasons.push(
        `outcome unit ${node.unit} != question ${question.outcomeUnit}`,
      );
    }
  }

  if (hasDirectedCycle(graph)) {
    throw new CausalError(
      "CAUSAL_GRAPH_CYCLE_UNSUPPORTED",
      "Cyclic SCMs unsupported; refuse to silently break cycles",
      { causalGraphId: graph.causalGraphId },
    );
  }

  return {
    outcome: reasons.length === 0 ? "PASS" : "BLOCK",
    reasons,
  };
}

function hasDirectedCycle(graph: CausalGraph): boolean {
  const adj = new Map<string, string[]>();
  for (const node of graph.nodes) {
    adj.set(node.variableId, []);
  }
  for (const edge of graph.edges) {
    adj.get(edge.fromVariableId)?.push(edge.toVariableId);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const dfs = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const next of adj.get(id) ?? []) {
      if (dfs(next)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  for (const id of adj.keys()) {
    if (dfs(id)) return true;
  }
  return false;
}
