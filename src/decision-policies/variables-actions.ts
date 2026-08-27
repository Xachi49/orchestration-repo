import { z } from "zod";

export const QUANTITY_UNITS = [
  "PERCENT",
  "RATIO",
  "COUNT",
  "DIMENSIONLESS",
  "USD",
  "TOKENS",
  "MILLISECONDS",
] as const;

export const QuantityUnitSchema = z.enum(QUANTITY_UNITS);
export type QuantityUnit = z.infer<typeof QuantityUnitSchema>;

export const STATE_SOURCE_CLASSES = [
  "CURRENT_CONTROL_PLANE_TRUTH",
  "VERIFIED_PROGRAM_OUTCOME",
  "VERIFIED_PORTFOLIO_OUTCOME",
  "OBSERVATIONAL_DATA",
  "PROMOTED_CAUSAL_CLAIM",
  "PHASE16_SCENARIO_CONTEXT",
] as const;

export const StateSourceClassSchema = z.enum(STATE_SOURCE_CLASSES);
export type StateSourceClass = z.infer<typeof StateSourceClassSchema>;

export const MissingValuePolicySchema = z.enum([
  "FAIL_CLOSED",
  "NO_ACTION",
  "USE_DEFAULT",
]);
export type MissingValuePolicy = z.infer<typeof MissingValuePolicySchema>;

export const DecisionStateVariableSchema = z
  .object({
    variableId: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1),
    unit: QuantityUnitSchema,
    sourceClass: StateSourceClassSchema,
    sourceRef: z.string().min(1),
    measurementDefinition: z.string().min(1),
    freshnessRequirementMs: z.number().int().nonnegative(),
    qualityRequirement: z.enum(["VALIDATED", "PARTIAL", "ANY"]),
    allowedRange: z
      .object({
        min: z.number().finite().optional(),
        max: z.number().finite().optional(),
      })
      .strict()
      .optional(),
    missingValuePolicy: MissingValuePolicySchema,
    defaultValue: z.union([z.string(), z.number(), z.boolean()]).optional(),
  })
  .strict();

export type DecisionStateVariable = z.infer<typeof DecisionStateVariableSchema>;

export const ACTION_CLASSES = [
  "CREATE_OBJECTIVE",
  "PROGRAM_PROPOSAL",
  "PORTFOLIO_REALLOCATION_PROPOSAL",
  "RUN_EXPERIMENT",
  "NO_ACTION",
] as const;

export const ActionClassSchema = z.enum(ACTION_CLASSES);
export type ActionClass = z.infer<typeof ActionClassSchema>;

export const EXECUTION_PATHS = [
  "OBJECTIVE",
  "PROGRAM",
  "PORTFOLIO_PROPOSAL",
  "EXPERIMENT_PROPOSAL",
  "NO_ACTION",
] as const;

export const ExecutionPathSchema = z.enum(EXECUTION_PATHS);
export type ExecutionPath = z.infer<typeof ExecutionPathSchema>;

export const RISK_CLASSES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export const RiskClassSchema = z.enum(RISK_CLASSES);
export type RiskClass = z.infer<typeof RiskClassSchema>;

export const DecisionActionDefinitionSchema = z
  .object({
    actionId: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1),
    actionClass: ActionClassSchema,
    requiredCapabilities: z.array(z.string().min(1)).default([]),
    projectScope: z.array(z.string().min(1)).min(1),
    environmentScope: z.array(z.string().min(1)).min(1),
    estimatedResources: z
      .object({
        tokens: z.number().nonnegative().optional(),
        usd: z.number().nonnegative().optional(),
        humanReviewHours: z.number().nonnegative().optional(),
      })
      .strict()
      .default({}),
    reversibility: z.enum(["REVERSIBLE", "PARTIALLY_REVERSIBLE", "IRREVERSIBLE"]),
    riskClass: RiskClassSchema,
    executionPath: ExecutionPathSchema,
    authorityRequirements: z.array(z.string().min(1)).default([]),
  })
  .strict()
  .superRefine((action, ctx) => {
    if (action.actionClass === "NO_ACTION" && action.executionPath !== "NO_ACTION") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "NO_ACTION class requires executionPath NO_ACTION",
      });
    }
    if (action.actionClass === "CREATE_OBJECTIVE" && action.executionPath !== "OBJECTIVE") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "CREATE_OBJECTIVE requires executionPath OBJECTIVE",
      });
    }
    if (
      action.actionClass === "PROGRAM_PROPOSAL" &&
      action.executionPath !== "PROGRAM"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "PROGRAM_PROPOSAL requires executionPath PROGRAM",
      });
    }
    if (
      action.actionClass === "PORTFOLIO_REALLOCATION_PROPOSAL" &&
      action.executionPath !== "PORTFOLIO_PROPOSAL"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "PORTFOLIO_REALLOCATION_PROPOSAL requires executionPath PORTFOLIO_PROPOSAL",
      });
    }
    if (
      action.actionClass === "RUN_EXPERIMENT" &&
      action.executionPath !== "EXPERIMENT_PROPOSAL"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "RUN_EXPERIMENT requires executionPath EXPERIMENT_PROPOSAL",
      });
    }
  });

export type DecisionActionDefinition = z.infer<
  typeof DecisionActionDefinitionSchema
>;

export function defaultNoActionDefinition(input: {
  projectIds: readonly string[];
  environments: readonly string[];
}): DecisionActionDefinition {
  return DecisionActionDefinitionSchema.parse({
    actionId: "action_no_action",
    name: "No action",
    description: "Explicit bounded default — recommend nothing",
    actionClass: "NO_ACTION",
    requiredCapabilities: [],
    projectScope: [...input.projectIds],
    environmentScope: [...input.environments],
    estimatedResources: {},
    reversibility: "REVERSIBLE",
    riskClass: "LOW",
    executionPath: "NO_ACTION",
    authorityRequirements: [],
  });
}
