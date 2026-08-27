import type { DecisionContext } from "./context.js";
import type { DecisionPolicyCandidate } from "./policy.js";
import { detectDecisionRuleConflicts } from "./rules.js";
import { parsePredicateAst } from "./predicates.js";
import { DecisionPolicyError } from "./errors.js";

export const ValidationOutcomeSchemaValues = [
  "PASS",
  "BLOCK",
  "HUMAN_APPROVAL_REQUIRED",
  "REVISE",
] as const;

export type ValidationOutcome = (typeof ValidationOutcomeSchemaValues)[number];

export interface DecisionPolicyValidationResult {
  outcome: ValidationOutcome;
  issues: string[];
  conflicts: ReturnType<typeof detectDecisionRuleConflicts>;
  requiresHumanReview: boolean;
}

/**
 * Deterministic validator. Model does not decide terminal validation.
 */
export function validateDecisionPolicy(input: {
  context: DecisionContext;
  policy: DecisionPolicyCandidate;
}): DecisionPolicyValidationResult {
  const issues: string[] = [];
  const { context, policy } = input;

  if (policy.decisionContextId !== context.decisionContextId) {
    issues.push("Policy decisionContextId does not match context");
  }
  if (policy.decisionContextVersion !== context.decisionContextVersion) {
    issues.push("Policy decisionContextVersion does not match context");
  }
  if (policy.decisionContextHash !== context.contextHash) {
    issues.push("Policy decisionContextHash does not match context");
  }

  const actionIds = new Set(context.eligibleActions.map((a) => a.actionId));
  const variableIds = new Set(context.stateVariables.map((v) => v.variableId));

  if (!actionIds.has(policy.defaultActionId)) {
    issues.push(`Default action ${policy.defaultActionId} is not eligible`);
  }
  const defaultAction = context.eligibleActions.find(
    (a) => a.actionId === policy.defaultActionId,
  );
  if (defaultAction && defaultAction.actionClass !== "NO_ACTION") {
    // Prefer NO_ACTION but allow explicit eligible default if present —
    // still require an explicit default (already checked).
  }
  if (!policy.defaultActionId) {
    issues.push("Missing default action");
  }

  for (const rule of policy.rules) {
    try {
      parsePredicateAst(rule.predicate);
    } catch (error) {
      issues.push(
        `Rule ${rule.decisionRuleId}: ${error instanceof Error ? error.message : "bad predicate"}`,
      );
    }
    if (!actionIds.has(rule.actionId)) {
      issues.push(
        `Rule ${rule.decisionRuleId} action ${rule.actionId} is not eligible`,
      );
    }
    const usedVars = collectVars(rule.predicate);
    for (const v of usedVars) {
      if (!variableIds.has(v)) {
        issues.push(
          `Rule ${rule.decisionRuleId} references unknown state variable ${v}`,
        );
      }
    }
    if (
      !rule.heuristicOnly &&
      rule.evidenceRefs.length === 0 &&
      rule.promotedCausalClaimIds.length === 0
    ) {
      issues.push(
        `Rule ${rule.decisionRuleId} lacks evidence provenance (mark heuristicOnly or attach evidence)`,
      );
    }
    for (const claimId of rule.promotedCausalClaimIds) {
      if (!policy.sourcePromotedCausalClaimIds.includes(claimId)) {
        issues.push(
          `Rule ${rule.decisionRuleId} references causal claim ${claimId} not listed on policy`,
        );
      }
    }
  }

  const conflicts = detectDecisionRuleConflicts(policy.rules);
  const hardConflicts = conflicts.filter(
    (c) => c.kind === "IDENTICAL_PREDICATE_DIFFERENT_ACTION",
  );
  if (hardConflicts.length > 0) {
    issues.push(
      ...hardConflicts.map(
        (c) =>
          `Hard rule conflict: ${c.ruleIdA} vs ${c.ruleIdB} (${c.actionIdA}/${c.actionIdB})`,
      ),
    );
  }

  const potentialConflicts = conflicts.filter(
    (c) => c.kind === "POTENTIAL_RULE_CONFLICT",
  );
  const requiresHumanReview =
    potentialConflicts.length > 0 ||
    policy.rules.some((r) => r.heuristicOnly);

  if (issues.length > 0) {
    return {
      outcome: "BLOCK",
      issues,
      conflicts,
      requiresHumanReview: true,
    };
  }
  if (requiresHumanReview) {
    return {
      outcome: "HUMAN_APPROVAL_REQUIRED",
      issues: potentialConflicts.map((c) => c.notes),
      conflicts,
      requiresHumanReview: true,
    };
  }
  return {
    outcome: "PASS",
    issues: [],
    conflicts,
    requiresHumanReview: false,
  };
}

function collectVars(predicate: {
  op: string;
  variableId?: string;
  children?: readonly unknown[];
  child?: unknown;
}): string[] {
  const out: string[] = [];
  const walk = (p: unknown): void => {
    if (!p || typeof p !== "object") return;
    const node = p as Record<string, unknown>;
    if (typeof node["variableId"] === "string") out.push(node["variableId"]);
    if (Array.isArray(node["children"])) node["children"].forEach(walk);
    if (node["child"]) walk(node["child"]);
  };
  walk(predicate);
  return out;
}

export function assertValidationPass(
  result: DecisionPolicyValidationResult,
): void {
  if (result.outcome === "BLOCK" || result.outcome === "REVISE") {
    throw new DecisionPolicyError(
      "DECISION_POLICY_VALIDATION_FAILED",
      result.issues.join("; ") || "Validation blocked",
      { outcome: result.outcome, issues: result.issues },
    );
  }
}
