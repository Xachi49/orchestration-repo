import { createHash } from "node:crypto";
import { z } from "zod";
import { ScenarioError } from "./errors.js";
import { ScenarioEvidenceAuthorityClassSchema } from "./evidence-classes.js";

export const QUANTITY_UNITS = [
  "USD",
  "TOKENS",
  "DAYS",
  "PERCENT",
  "COUNT",
  "SCORE",
  "RATIO",
  "UNKNOWN",
] as const;

export const QuantityUnitSchema = z.enum(QUANTITY_UNITS);
export type QuantityUnit = z.infer<typeof QuantityUnitSchema>;

export const QuantifiedValueSchema = z
  .object({
    value: z.number().finite(),
    unit: QuantityUnitSchema,
  })
  .strict();

export type QuantifiedValue = z.infer<typeof QuantifiedValueSchema>;

export function assertCompatibleUnits(
  a: QuantityUnit,
  b: QuantityUnit,
  operation: string,
): void {
  if (a === "UNKNOWN" || b === "UNKNOWN") {
    throw new ScenarioError(
      "UNIT_MIXING_REJECTED",
      `Cannot ${operation} with UNKNOWN unit`,
      { a, b },
    );
  }
  if (a !== b) {
    throw new ScenarioError(
      "UNIT_MIXING_REJECTED",
      `Cannot ${operation} heterogeneous units ${a} + ${b}`,
      { a, b },
    );
  }
}

export const ScenarioAssumptionSchema = z
  .object({
    assumptionId: z.string().min(1),
    name: z.string().min(1).max(200),
    description: z.string().min(1).max(4000),
    value: z.number().finite(),
    unit: QuantityUnitSchema,
    sourceClass: ScenarioEvidenceAuthorityClassSchema,
    sourceRef: z.string().min(1).optional(),
    confidenceClassification: z.enum([
      "HIGH",
      "MEDIUM",
      "LOW",
      "UNKNOWN",
    ]),
    lowerBound: z.number().finite().optional(),
    upperBound: z.number().finite().optional(),
    validFrom: z.string().datetime().optional(),
    validUntil: z.string().datetime().optional(),
    sensitivityEligible: z.boolean().default(false),
    materiality: z.enum(["LOW", "MEDIUM", "HIGH"]).default("MEDIUM"),
    owner: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((a, ctx) => {
    if (
      a.sourceClass !== "ASSUMPTION" &&
      a.sourceClass !== "MODEL_ESTIMATE" &&
      a.sourceClass !== "EXTERNAL_REFERENCE_DATA" &&
      a.sourceClass !== "OBSERVATIONAL_DATA" &&
      a.sourceClass !== "GOVERNED_PRECEDENT"
    ) {
      // Verified truth classes may still be referenced as frozen inputs,
      // but assumption records themselves should not claim CURRENT truth.
    }
    if (
      a.lowerBound !== undefined &&
      a.upperBound !== undefined &&
      a.lowerBound > a.upperBound
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "lowerBound must be <= upperBound",
      });
    }
  });

export type ScenarioAssumption = z.infer<typeof ScenarioAssumptionSchema>;

export function parseAssumptions(input: unknown): ScenarioAssumption[] {
  const assumptions = z.array(ScenarioAssumptionSchema).parse(input);
  validateAssumptionSet(assumptions);
  return assumptions;
}

export function validateAssumptionSet(
  assumptions: readonly ScenarioAssumption[],
): void {
  const ids = new Set<string>();
  for (const a of assumptions) {
    if (ids.has(a.assumptionId)) {
      throw new ScenarioError(
        "ASSUMPTION_INVALID",
        `Duplicate assumption id ${a.assumptionId}`,
      );
    }
    ids.add(a.assumptionId);
  }
}

export function assumptionSetHash(
  assumptions: readonly ScenarioAssumption[],
): string {
  const sorted = [...assumptions].sort((a, b) =>
    a.assumptionId.localeCompare(b.assumptionId),
  );
  return createHash("sha256")
    .update(JSON.stringify(sorted), "utf8")
    .digest("hex");
}

export const AssumptionSetSchema = z
  .object({
    assumptions: z.array(ScenarioAssumptionSchema),
    assumptionSetHash: z.string().min(1),
  })
  .strict();

export type AssumptionSet = z.infer<typeof AssumptionSetSchema>;

export function withAssumptionSetHash(
  assumptions: readonly ScenarioAssumption[],
): AssumptionSet {
  validateAssumptionSet(assumptions);
  const hash = assumptionSetHash(assumptions);
  return AssumptionSetSchema.parse({
    assumptions,
    assumptionSetHash: hash,
  });
}
