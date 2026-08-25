import { createHash } from "node:crypto";
import { z } from "zod";
import {
  BUDGET_DIMENSIONS,
  BudgetResourceEstimateSchema,
  type BudgetDimension,
  type BudgetResourceEstimate,
} from "../control-plane/budgets/budget.js";

/**
 * Durable program budget escrow.
 * Budgets partition; they do not multiply.
 */
export const ProgramBudgetLedgerSchema = z
  .object({
    programId: z.string().min(1),
    programVersion: z.number().int().positive(),
    ceiling: BudgetResourceEstimateSchema,
    reserved: BudgetResourceEstimateSchema,
    settled: BudgetResourceEstimateSchema,
    released: BudgetResourceEstimateSchema,
    recordRevision: z.number().int().min(1),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type ProgramBudgetLedger = z.infer<typeof ProgramBudgetLedgerSchema>;

export const ProgramBudgetReservationSchema = z
  .object({
    reservationId: z.string().min(1),
    programId: z.string().min(1),
    programPlanVersion: z.number().int().positive(),
    nodeId: z.string().min(1),
    amount: BudgetResourceEstimateSchema,
    status: z.enum(["RESERVED", "SETTLED", "RELEASED"]),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    recordRevision: z.number().int().min(1),
  })
  .strict();

export type ProgramBudgetReservation = z.infer<
  typeof ProgramBudgetReservationSchema
>;

export function emptyBudgetEstimate(): BudgetResourceEstimate {
  return {
    llmCalls: 0,
    totalTokens: 0,
    apiCalls: 0,
    executionMinutes: 0,
    estimatedCost: 0,
    humanReviewMinutes: 0,
    planSteps: 0,
    parallelWorkstreams: 0,
    revisionAttempts: 0,
  };
}

export function addBudget(
  a: BudgetResourceEstimate,
  b: BudgetResourceEstimate,
): BudgetResourceEstimate {
  const out = emptyBudgetEstimate();
  for (const dim of BUDGET_DIMENSIONS) {
    out[dim as BudgetDimension] =
      a[dim as BudgetDimension] + b[dim as BudgetDimension];
  }
  return out;
}

export function subtractBudget(
  a: BudgetResourceEstimate,
  b: BudgetResourceEstimate,
): BudgetResourceEstimate {
  const out = emptyBudgetEstimate();
  for (const dim of BUDGET_DIMENSIONS) {
    out[dim as BudgetDimension] =
      a[dim as BudgetDimension] - b[dim as BudgetDimension];
  }
  return out;
}

export function remainingBudget(
  ledger: ProgramBudgetLedger,
): BudgetResourceEstimate {
  return subtractBudget(
    ledger.ceiling,
    addBudget(ledger.reserved, subtractBudget(ledger.settled, ledger.released)),
  );
}

/**
 * Remaining = ceiling - (reserved - released) conceptually:
 * reserved holds current holds; settled consumes permanently; released returns
 * unused planning/scheduling units that never had external effect.
 */
export function availableToReserve(
  ledger: ProgramBudgetLedger,
): BudgetResourceEstimate {
  // Active hold = reserved - released (released only from prior RESERVED).
  // Settled amounts stay consumed (already removed from reserved when settled).
  const held = subtractBudget(ledger.reserved, ledger.released);
  return subtractBudget(ledger.ceiling, addBudget(held, ledger.settled));
}

export function canReserve(
  available: BudgetResourceEstimate,
  request: BudgetResourceEstimate,
): boolean {
  for (const dim of BUDGET_DIMENSIONS) {
    if (request[dim as BudgetDimension] > available[dim as BudgetDimension]) {
      return false;
    }
  }
  return true;
}

export function sumNodeBudgets(
  amounts: readonly BudgetResourceEstimate[],
): BudgetResourceEstimate {
  return amounts.reduce((acc, cur) => addBudget(acc, cur), emptyBudgetEstimate());
}

export function exceedsCeiling(
  total: BudgetResourceEstimate,
  ceiling: BudgetResourceEstimate,
): boolean {
  for (const dim of BUDGET_DIMENSIONS) {
    if (total[dim as BudgetDimension] > ceiling[dim as BudgetDimension]) {
      return true;
    }
  }
  return false;
}

export function budgetAllocationFingerprint(
  allocations: ReadonlyArray<{ nodeId: string; amount: BudgetResourceEstimate }>,
): string {
  const sorted = [...allocations].sort((a, b) =>
    a.nodeId.localeCompare(b.nodeId),
  );
  return createHash("sha256")
    .update(JSON.stringify(sorted), "utf8")
    .digest("hex");
}

export function reservationIdFor(input: {
  programId: string;
  programPlanVersion: number;
  nodeId: string;
}): string {
  return `pbr_${createHash("sha256")
    .update(
      JSON.stringify({
        nodeId: input.nodeId,
        planVersion: input.programPlanVersion,
        programId: input.programId,
      }),
      "utf8",
    )
    .digest("hex")
    .slice(0, 32)}`;
}

/**
 * Unused budget categories:
 * - RELEASEABLE: planning/scheduling reservation never dispatched externally
 * - NON_RELEASEABLE: ambiguous external effect / execution spend
 * Phase 14 only auto-releases RELEASEABLE planning units via explicit release().
 */
export const BUDGET_RELEASE_CATEGORIES = [
  "RELEASEABLE_PLANNING",
  "NON_RELEASEABLE_EXTERNAL",
] as const;
