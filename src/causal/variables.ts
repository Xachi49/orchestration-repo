import { z } from "zod";
import { CausalError } from "./errors.js";

/** Reuse established dimensional units — no mixing. */
export const QUANTITY_UNITS = [
  "USD",
  "TOKENS",
  "PERCENT",
  "RATIO",
  "DAYS",
  "HOURS",
  "COUNT",
  "SCORE",
  "DIMENSIONLESS",
] as const;

export const QuantityUnitSchema = z.enum(QUANTITY_UNITS);
export type QuantityUnit = z.infer<typeof QuantityUnitSchema>;

export function assertCompatibleUnits(
  a: QuantityUnit,
  b: QuantityUnit,
  operation: string,
): void {
  if (a !== b) {
    throw new CausalError(
      "UNIT_MIXING_REJECTED",
      `Cannot ${operation} incompatible units ${a} + ${b}`,
      { a, b, operation },
    );
  }
}

export const CAUSAL_VARIABLE_CLASSES = [
  "INTERVENTION",
  "OUTCOME",
  "CONFOUNDER",
  "MEDIATOR",
  "MODERATOR",
  "COVARIATE",
  "LATENT_OR_UNKNOWN",
] as const;

export const CausalVariableClassSchema = z.enum(CAUSAL_VARIABLE_CLASSES);
export type CausalVariableClass = z.infer<typeof CausalVariableClassSchema>;

export const CausalVariableSchema = z
  .object({
    variableId: z.string().min(1),
    name: z.string().min(1).max(200),
    description: z.string().max(4000).default(""),
    unit: QuantityUnitSchema,
    variableClass: CausalVariableClassSchema,
    source: z.string().min(1).max(500),
    measurementDefinition: z.string().min(1).max(4000),
    populationScope: z.string().min(1).max(500),
    environmentScope: z.string().min(1).max(200),
  })
  .strict();

export type CausalVariable = z.infer<typeof CausalVariableSchema>;
