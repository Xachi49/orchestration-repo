import { createHash } from "node:crypto";
import { z } from "zod";
import {
  BudgetResourceEstimateSchema,
  type BudgetResourceEstimate,
} from "../control-plane/budgets/budget.js";
import {
  addBudget,
  availableToReserve,
  canReserve,
  emptyBudgetEstimate,
  subtractBudget,
} from "../programs/budget.js";

export {
  emptyBudgetEstimate,
  addBudget,
  subtractBudget,
  canReserve,
  availableToReserve,
};

export const PortfolioBudgetLedgerSchema = z
  .object({
    portfolioId: z.string().min(1),
    portfolioVersion: z.number().int().positive(),
    ceiling: BudgetResourceEstimateSchema,
    reserved: BudgetResourceEstimateSchema,
    settled: BudgetResourceEstimateSchema,
    released: BudgetResourceEstimateSchema,
    recordRevision: z.number().int().min(1),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type PortfolioBudgetLedger = z.infer<typeof PortfolioBudgetLedgerSchema>;

export const PortfolioBudgetReservationSchema = z
  .object({
    reservationId: z.string().min(1),
    portfolioId: z.string().min(1),
    portfolioPlanVersion: z.number().int().positive(),
    proposalId: z.string().min(1),
    amount: BudgetResourceEstimateSchema,
    status: z.enum(["RESERVED", "SETTLED", "RELEASED"]),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    recordRevision: z.number().int().min(1),
  })
  .strict();

export type PortfolioBudgetReservation = z.infer<
  typeof PortfolioBudgetReservationSchema
>;

export function portfolioAvailableToReserve(
  ledger: PortfolioBudgetLedger,
): BudgetResourceEstimate {
  const held = subtractBudget(ledger.reserved, ledger.released);
  return subtractBudget(ledger.ceiling, addBudget(held, ledger.settled));
}

export function reservationIdFor(input: {
  portfolioId: string;
  portfolioPlanVersion: number;
  proposalId: string;
}): string {
  return `pbr_${input.portfolioId}_${input.portfolioPlanVersion}_${input.proposalId}`.slice(
    0,
    120,
  );
}

export function portfolioAllocationFingerprint(
  allocations: readonly { proposalId: string; amount: BudgetResourceEstimate }[],
): string {
  const sorted = [...allocations].sort((a, b) =>
    a.proposalId.localeCompare(b.proposalId),
  );
  return createHash("sha256")
    .update(JSON.stringify(sorted), "utf8")
    .digest("hex");
}

export function exceedsCeiling(
  request: BudgetResourceEstimate,
  ceiling: BudgetResourceEstimate,
): boolean {
  return !canReserve(ceiling, request);
}

export function sumAllocations(
  amounts: readonly BudgetResourceEstimate[],
): BudgetResourceEstimate {
  return amounts.reduce((acc, a) => addBudget(acc, a), emptyBudgetEstimate());
}
