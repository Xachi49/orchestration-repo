import { CausalError } from "./errors.js";
import type { CausalAnalysisBudget } from "./question.js";
import type {
  CausalUsageLedgerRepository,
  CausalUsageSnapshot,
} from "./repositories.js";

export function emptyCausalUsage(updatedAt: string): CausalUsageSnapshot {
  return {
    graphModelCalls: 0,
    modelTokens: 0,
    estimators: 0,
    synthesisOperations: 0,
    recordRevision: 1,
    updatedAt,
  };
}

export async function reserveCausalUsage(input: {
  ledger: CausalUsageLedgerRepository;
  causalQuestionId: string;
  budget: CausalAnalysisBudget;
  delta: Partial<{
    graphModelCalls: number;
    modelTokens: number;
    estimators: number;
    synthesisOperations: number;
  }>;
  nowIso: string;
}): Promise<CausalUsageSnapshot> {
  const existing = await input.ledger.get(input.causalQuestionId);
  const current = existing ?? emptyCausalUsage(input.nowIso);
  const next: CausalUsageSnapshot = {
    graphModelCalls:
      current.graphModelCalls + (input.delta.graphModelCalls ?? 0),
    modelTokens: current.modelTokens + (input.delta.modelTokens ?? 0),
    estimators: current.estimators + (input.delta.estimators ?? 0),
    synthesisOperations:
      current.synthesisOperations + (input.delta.synthesisOperations ?? 0),
    recordRevision: current.recordRevision,
    updatedAt: input.nowIso,
  };
  if (next.graphModelCalls > input.budget.maximumGraphModelCalls) {
    throw new CausalError(
      "CAUSAL_BUDGET_EXCEEDED",
      "Graph model call budget exceeded",
    );
  }
  if (next.modelTokens > input.budget.maximumModelTokens) {
    throw new CausalError("CAUSAL_BUDGET_EXCEEDED", "Model token budget exceeded");
  }
  if (next.estimators > input.budget.maximumEstimators) {
    throw new CausalError("CAUSAL_BUDGET_EXCEEDED", "Estimator budget exceeded");
  }
  if (next.synthesisOperations > input.budget.maximumSynthesisOperations) {
    throw new CausalError(
      "CAUSAL_BUDGET_EXCEEDED",
      "Synthesis operation budget exceeded",
    );
  }
  return input.ledger.save(
    input.causalQuestionId,
    next,
    existing ? existing.recordRevision : null,
  );
}
