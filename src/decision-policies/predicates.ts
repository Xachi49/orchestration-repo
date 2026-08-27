import { z } from "zod";
import { DecisionPolicyError } from "./errors.js";

/**
 * Bounded predicate DSL. No arbitrary code, shell, JS expressions, or SQL.
 */
export const PREDICATE_OPERATORS = [
  "EQ",
  "NEQ",
  "GT",
  "GTE",
  "LT",
  "LTE",
  "IN",
  "AND",
  "OR",
  "NOT",
  "BETWEEN",
] as const;

export type PredicateOperator = (typeof PREDICATE_OPERATORS)[number];

export type PredicateAst =
  | {
      op: "EQ" | "NEQ" | "GT" | "GTE" | "LT" | "LTE";
      variableId: string;
      value: string | number | boolean;
    }
  | {
      op: "IN";
      variableId: string;
      values: ReadonlyArray<string | number | boolean>;
    }
  | {
      op: "BETWEEN";
      variableId: string;
      min: number;
      max: number;
    }
  | {
      op: "AND" | "OR";
      children: readonly PredicateAst[];
    }
  | {
      op: "NOT";
      child: PredicateAst;
    };

const LeafCompareSchema = z
  .object({
    op: z.enum(["EQ", "NEQ", "GT", "GTE", "LT", "LTE"]),
    variableId: z.string().min(1),
    value: z.union([z.string(), z.number(), z.boolean()]),
  })
  .strict();

const InSchema = z
  .object({
    op: z.literal("IN"),
    variableId: z.string().min(1),
    values: z.array(z.union([z.string(), z.number(), z.boolean()])).min(1),
  })
  .strict();

const BetweenSchema = z
  .object({
    op: z.literal("BETWEEN"),
    variableId: z.string().min(1),
    min: z.number().finite(),
    max: z.number().finite(),
  })
  .strict();

export const PredicateAstSchema: z.ZodType<PredicateAst> = z.lazy(() =>
  z.union([
    LeafCompareSchema,
    InSchema,
    BetweenSchema,
    z
      .object({
        op: z.enum(["AND", "OR"]),
        children: z.array(PredicateAstSchema).min(1),
      })
      .strict(),
    z
      .object({
        op: z.literal("NOT"),
        child: PredicateAstSchema,
      })
      .strict(),
  ]),
);

const FORBIDDEN_CODE_PATTERNS = [
  /\beval\b/i,
  /\bFunction\b/,
  /\brequire\b/,
  /\bimport\s*\(/,
  /\bprocess\b/,
  /\bchild_process\b/,
  /\bshell\b/i,
  /\$\{/,
  /;\s*DROP\b/i,
  /--|\/\*|\*\//,
  /=>/,
  /\bnew\s+Function\b/,
];

export function assertNoArbitraryPredicateCode(raw: unknown): void {
  const serialized = typeof raw === "string" ? raw : JSON.stringify(raw);
  for (const pattern of FORBIDDEN_CODE_PATTERNS) {
    if (pattern.test(serialized)) {
      throw new DecisionPolicyError(
        "DECISION_PREDICATE_ARBITRARY_CODE_REJECTED",
        "Arbitrary code / shell / SQL fragments are not allowed in predicates",
        { pattern: String(pattern) },
      );
    }
  }
  if (
    raw !== null &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    "expression" in (raw as Record<string, unknown>)
  ) {
    throw new DecisionPolicyError(
      "DECISION_PREDICATE_ARBITRARY_CODE_REJECTED",
      "Free-form expression predicates are not allowed",
    );
  }
}

export function parsePredicateAst(raw: unknown): PredicateAst {
  assertNoArbitraryPredicateCode(raw);
  const parsed = PredicateAstSchema.safeParse(raw);
  if (!parsed.success) {
    throw new DecisionPolicyError(
      "DECISION_PREDICATE_INVALID",
      "Predicate AST failed schema validation",
      { issues: parsed.error.issues },
    );
  }
  return parsed.data;
}

export type DecisionStateValues = Readonly<
  Record<string, string | number | boolean | null | undefined>
>;

function readNumber(
  values: DecisionStateValues,
  variableId: string,
): number | null {
  const v = values[variableId];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) {
    return Number(v);
  }
  return null;
}

export function evaluatePredicate(
  predicate: PredicateAst,
  values: DecisionStateValues,
): boolean {
  switch (predicate.op) {
    case "EQ":
      return values[predicate.variableId] === predicate.value;
    case "NEQ":
      return values[predicate.variableId] !== predicate.value;
    case "GT": {
      const n = readNumber(values, predicate.variableId);
      return n !== null && typeof predicate.value === "number" && n > predicate.value;
    }
    case "GTE": {
      const n = readNumber(values, predicate.variableId);
      return (
        n !== null && typeof predicate.value === "number" && n >= predicate.value
      );
    }
    case "LT": {
      const n = readNumber(values, predicate.variableId);
      return n !== null && typeof predicate.value === "number" && n < predicate.value;
    }
    case "LTE": {
      const n = readNumber(values, predicate.variableId);
      return (
        n !== null && typeof predicate.value === "number" && n <= predicate.value
      );
    }
    case "IN":
      return predicate.values.some((v) => values[predicate.variableId] === v);
    case "BETWEEN": {
      const n = readNumber(values, predicate.variableId);
      return n !== null && n >= predicate.min && n <= predicate.max;
    }
    case "AND":
      return predicate.children.every((c) => evaluatePredicate(c, values));
    case "OR":
      return predicate.children.some((c) => evaluatePredicate(c, values));
    case "NOT":
      return !evaluatePredicate(predicate.child, values);
    default: {
      const _exhaustive: never = predicate;
      return _exhaustive;
    }
  }
}

/** Canonical serialization for hashing — sorted keys where order is immaterial. */
export function canonicalizePredicate(predicate: PredicateAst): unknown {
  switch (predicate.op) {
    case "AND":
    case "OR":
      return {
        op: predicate.op,
        children: predicate.children.map(canonicalizePredicate),
      };
    case "NOT":
      return { op: "NOT", child: canonicalizePredicate(predicate.child) };
    case "IN":
      return {
        op: "IN",
        variableId: predicate.variableId,
        values: [...predicate.values],
      };
    case "BETWEEN":
      return {
        op: "BETWEEN",
        variableId: predicate.variableId,
        min: predicate.min,
        max: predicate.max,
      };
    default:
      return {
        op: predicate.op,
        variableId: predicate.variableId,
        value: predicate.value,
      };
  }
}
