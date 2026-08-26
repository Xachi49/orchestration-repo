import { createHash } from "node:crypto";
import { z } from "zod";

export const PortfolioIntentSchema = z
  .object({
    portfolioName: z.string().min(1).max(200),
    strategicOutcome: z.string().min(1).max(4000),
    strategicGoals: z.array(z.string().min(1)).min(1),
    constraints: z.array(z.string()).default([]),
    nonGoals: z.array(z.string()).default([]),
    priorityPrinciples: z.array(z.string()).default([]),
    timeHorizon: z.string().min(1).max(200),
    requestedEnvironmentScopes: z.array(z.string().min(1)).min(1),
    allowedProjectScopes: z.array(z.string().min(1)).min(1),
    riskToleranceProfile: z.enum(["LOW", "MEDIUM", "HIGH"]),
    capitalAllocationPrinciples: z.array(z.string()).default([]),
    successCriteria: z.array(z.string().min(1)).min(1),
  })
  .strict();

export type PortfolioIntent = z.infer<typeof PortfolioIntentSchema>;

export function parsePortfolioIntent(input: unknown): PortfolioIntent {
  return PortfolioIntentSchema.parse(input);
}

export function portfolioIntentHash(intent: PortfolioIntent): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalIntent(intent)), "utf8")
    .digest("hex");
}

function canonicalIntent(intent: PortfolioIntent): Record<string, unknown> {
  return {
    allowedProjectScopes: [...intent.allowedProjectScopes].sort(),
    capitalAllocationPrinciples: [...intent.capitalAllocationPrinciples],
    constraints: [...intent.constraints],
    nonGoals: [...intent.nonGoals],
    portfolioName: intent.portfolioName,
    priorityPrinciples: [...intent.priorityPrinciples],
    requestedEnvironmentScopes: [...intent.requestedEnvironmentScopes].sort(),
    riskToleranceProfile: intent.riskToleranceProfile,
    strategicGoals: [...intent.strategicGoals],
    strategicOutcome: intent.strategicOutcome,
    successCriteria: [...intent.successCriteria],
    timeHorizon: intent.timeHorizon,
  };
}

export function mintPortfolioId(input: {
  primaryProjectId: string;
  intentHash: string;
  admittedAt: string;
}): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        admittedAt: input.admittedAt,
        intentHash: input.intentHash,
        primaryProjectId: input.primaryProjectId,
      }),
      "utf8",
    )
    .digest("hex")
    .slice(0, 24);
  return `pfo_${digest}`;
}
