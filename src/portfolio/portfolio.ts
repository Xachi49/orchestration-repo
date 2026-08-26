import { createHash } from "node:crypto";
import { z } from "zod";
import {
  PortfolioAuthorizationEnvelopeSchema,
  type PortfolioAuthorizationEnvelope,
} from "./authorization-envelope.js";
import { PortfolioGoalSchema, type PortfolioGoal } from "./goals.js";
import { PortfolioIntentSchema, type PortfolioIntent } from "./intent.js";
import { PortfolioStateSchema } from "./portfolio-state.js";
import { canTransitionPortfolio } from "./portfolio-state.js";
import { PortfolioError } from "./errors.js";

export const INITIAL_PORTFOLIO_VERSION = 1;

export const PortfolioAuthorityFreezeSchema = z
  .object({
    policyBundleId: z.string().min(1),
    policyBundleHash: z.string().min(1),
    capabilitySetFingerprint: z.string().min(1),
    projectConfigurationFingerprint: z.string().min(1),
    budgetProfileId: z.string().min(1),
    budgetConfigurationFingerprint: z.string().min(1),
    repositoryAllowlistFingerprint: z.string().min(1),
    environmentScopeFingerprint: z.string().min(1),
    authorizationEnvelopeHash: z.string().min(1),
    frozenAt: z.string().datetime(),
  })
  .strict();

export type PortfolioAuthorityFreeze = z.infer<
  typeof PortfolioAuthorityFreezeSchema
>;

export const PortfolioSchema = z
  .object({
    portfolioId: z.string().min(1),
    portfolioVersion: z.number().int().positive(),
    primaryProjectId: z.string().min(1),
    requesterId: z.string().min(1),
    intent: PortfolioIntentSchema,
    goals: z.array(PortfolioGoalSchema).min(1),
    authorizationEnvelope: PortfolioAuthorizationEnvelopeSchema,
    authorityFreeze: PortfolioAuthorityFreezeSchema,
    status: PortfolioStateSchema,
    portfolioPlanVersion: z.number().int().positive().optional(),
    portfolioPlanHash: z.string().min(1).optional(),
    paused: z.boolean().default(false),
    failureReasonCode: z.string().min(1).optional(),
    failureClass: z
      .enum([
        "PROGRAM_FAILURE",
        "PORTFOLIO_GOAL_FAILURE",
        "BUDGET_EXHAUSTION",
        "AUTHORITY_DRIFT",
        "INSUFFICIENT_EVIDENCE",
        "REBALANCE_REQUIRED",
        "DEPENDENCY_FAILURE",
        "DEADLINE_FAILURE",
        "STRATEGIC_INCONCLUSIVE",
      ])
      .optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    recordRevision: z.number().int().min(1).default(1),
    correlationId: z.string().min(1),
    traceId: z.string().min(1),
    idempotencyKey: z.string().min(1),
    contentFingerprint: z.string().min(1),
  })
  .strict();

export type Portfolio = z.infer<typeof PortfolioSchema>;

export function parsePortfolio(input: unknown): Portfolio {
  return PortfolioSchema.parse(input);
}

export function assertPortfolioTransition(
  from: Portfolio["status"],
  to: Portfolio["status"],
): void {
  if (!canTransitionPortfolio(from, to)) {
    throw new PortfolioError(
      "INVALID_PORTFOLIO_TRANSITION",
      `Illegal portfolio transition ${from} → ${to}`,
      { from, to },
    );
  }
}

export function portfolioContentFingerprint(input: {
  intent: PortfolioIntent;
  goals: readonly PortfolioGoal[];
  envelope: PortfolioAuthorizationEnvelope;
  primaryProjectId: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        envelope: input.envelope,
        goals: input.goals,
        intent: input.intent,
        primaryProjectId: input.primaryProjectId,
      }),
      "utf8",
    )
    .digest("hex");
}

export function portfolioIdempotencyKey(input: {
  primaryProjectId: string;
  contentFingerprint: string;
  requesterId: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        contentFingerprint: input.contentFingerprint,
        primaryProjectId: input.primaryProjectId,
        requesterId: input.requesterId,
      }),
      "utf8",
    )
    .digest("hex");
}

export function environmentScopeFingerprint(
  environments: readonly string[],
): string {
  return createHash("sha256")
    .update(JSON.stringify([...environments].sort()), "utf8")
    .digest("hex");
}
