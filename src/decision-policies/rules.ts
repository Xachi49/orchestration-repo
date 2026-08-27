import { createHash } from "node:crypto";
import { z } from "zod";
import {
  PredicateAstSchema,
  canonicalizePredicate,
  parsePredicateAst,
  type PredicateAst,
} from "./predicates.js";

export const DecisionRuleSchema = z
  .object({
    decisionRuleId: z.string().min(1),
    name: z.string().min(1),
    predicate: PredicateAstSchema,
    actionId: z.string().min(1),
    priority: z.number().int(),
    expectedOutcome: z
      .object({
        description: z.string().min(1),
        estimatedDelta: z.number().finite().optional(),
        unit: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    evidenceRefs: z.array(z.string().min(1)).default([]),
    promotedCausalClaimIds: z.array(z.string().min(1)).default([]),
    confidence: z.enum(["LOW", "MEDIUM", "HIGH"]).default("MEDIUM"),
    uncertainty: z
      .object({
        kind: z.enum(["QUALITATIVE", "INTERVAL", "UNSUPPORTED"]),
        notes: z.string().optional(),
      })
      .strict()
      .optional(),
    limitations: z.array(z.string().min(1)).default([]),
    heuristicOnly: z.boolean().default(false),
  })
  .strict()
  .superRefine((rule, ctx) => {
    if (
      !rule.heuristicOnly &&
      rule.evidenceRefs.length === 0 &&
      rule.promotedCausalClaimIds.length === 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Non-heuristic rules require evidenceRefs or promotedCausalClaimIds",
      });
    }
    try {
      parsePredicateAst(rule.predicate);
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          error instanceof Error ? error.message : "Invalid predicate AST",
      });
    }
  });

export type DecisionRule = z.infer<typeof DecisionRuleSchema>;

export function mintDecisionRuleId(input: {
  actionId: string;
  predicate: PredicateAst;
  priority: number;
}): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        actionId: input.actionId,
        predicate: canonicalizePredicate(input.predicate),
        priority: input.priority,
      }),
      "utf8",
    )
    .digest("hex")
    .slice(0, 16);
  return `drule_${digest}`;
}

export type RuleConflictKind =
  | "IDENTICAL_PREDICATE_DIFFERENT_ACTION"
  | "POTENTIAL_RULE_CONFLICT";

export interface DecisionRuleConflict {
  kind: RuleConflictKind;
  ruleIdA: string;
  ruleIdB: string;
  actionIdA: string;
  actionIdB: string;
  requiresHumanReview: boolean;
  notes: string;
}

function predicateKey(predicate: PredicateAst): string {
  return JSON.stringify(canonicalizePredicate(predicate));
}

/**
 * Bounded conflict detector — not a full theorem prover.
 * Detects identical predicates → different actions; marks other overlaps
 * as POTENTIAL_RULE_CONFLICT when both reference the same variableIds.
 */
export function detectDecisionRuleConflicts(
  rules: readonly DecisionRule[],
): DecisionRuleConflict[] {
  const conflicts: DecisionRuleConflict[] = [];
  for (let i = 0; i < rules.length; i += 1) {
    for (let j = i + 1; j < rules.length; j += 1) {
      const a = rules[i]!;
      const b = rules[j]!;
      if (predicateKey(a.predicate) === predicateKey(b.predicate)) {
        if (a.actionId !== b.actionId) {
          conflicts.push({
            kind: "IDENTICAL_PREDICATE_DIFFERENT_ACTION",
            ruleIdA: a.decisionRuleId,
            ruleIdB: b.decisionRuleId,
            actionIdA: a.actionId,
            actionIdB: b.actionId,
            requiresHumanReview: true,
            notes: "Identical predicates map to incompatible actions",
          });
        }
        continue;
      }
      const varsA = collectVariableIds(a.predicate);
      const varsB = collectVariableIds(b.predicate);
      const overlap = [...varsA].some((v) => varsB.has(v));
      if (overlap && a.actionId !== b.actionId && a.priority === b.priority) {
        conflicts.push({
          kind: "POTENTIAL_RULE_CONFLICT",
          ruleIdA: a.decisionRuleId,
          ruleIdB: b.decisionRuleId,
          actionIdA: a.actionId,
          actionIdB: b.actionId,
          requiresHumanReview: true,
          notes:
            "Overlapping variable scope with equal priority — human review required when material",
        });
      }
    }
  }
  return conflicts;
}

function collectVariableIds(predicate: PredicateAst): Set<string> {
  const out = new Set<string>();
  const walk = (p: PredicateAst): void => {
    switch (p.op) {
      case "AND":
      case "OR":
        p.children.forEach(walk);
        break;
      case "NOT":
        walk(p.child);
        break;
      default:
        out.add(p.variableId);
    }
  };
  walk(predicate);
  return out;
}
