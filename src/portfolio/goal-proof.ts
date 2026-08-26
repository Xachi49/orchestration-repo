import type { Portfolio } from "./portfolio.js";
import type { PortfolioPlan, PortfolioGoalContributionBinding } from "./plan.js";
import type { Program } from "../programs/program.js";
import type { ProgramCompletionRecord } from "../programs/lineage.js";
import type { PortfolioProgramLineage } from "./lineage.js";

export type GoalProofResult =
  | { status: "SATISFIED"; evidenceRefs: string[] }
  | {
      status: "UNSATISFIED" | "INCONCLUSIVE";
      reasonCode: string;
      message: string;
    };

/**
 * Portfolio goal proof chain (criterion-specific):
 *
 * PortfolioGoal
 *   → PortfolioGoalContributionBinding
 *   → exact Program root criterion identity (acceptanceCriteria[index])
 *   → ProgramCompletionRecord.criterionResults[that index] with
 *     satisfied:true and non-empty evidenceRefs
 *
 * ProgramCompletionRecord is Phase 14 completion authority and already stores
 * criterion-level proof (rootCriterionIndex + satisfied + evidenceRefs).
 * Program COMPLETED status alone is never sufficient. Plan assertions and
 * model narrative are never sufficient. Text similarity across unrelated
 * criteria is never sufficient — identity is exact string equality at the
 * bound root criterion index.
 */
export function provePortfolioGoal(input: {
  portfolio: Portfolio;
  plan: PortfolioPlan;
  goalId: string;
  lineage: readonly PortfolioProgramLineage[];
  programsById: ReadonlyMap<string, Program | null>;
  programCompletionsById: ReadonlyMap<string, ProgramCompletionRecord | null>;
}): GoalProofResult {
  const goal = input.portfolio.goals.find((g) => g.goalId === input.goalId);
  if (!goal) {
    return {
      status: "INCONCLUSIVE",
      reasonCode: "GOAL_MISSING",
      message: `Goal ${input.goalId} not found`,
    };
  }

  const bindings = input.plan.goalBindings.filter(
    (b) =>
      b.portfolioGoalId === input.goalId &&
      b.contributionType !== "OPTIONAL",
  );
  if (bindings.length === 0) {
    return {
      status: "INCONCLUSIVE",
      reasonCode: "NO_BINDING",
      message: `No contribution binding for goal ${input.goalId}`,
    };
  }

  const evidenceRefs: string[] = [];
  let sawFalseBinding = false;
  let sawMissing = false;
  let sawUnsatisfied = false;
  let sawUnavailableCriterionProof = false;

  for (const binding of bindings) {
    const proof = proveBinding({
      binding,
      lineage: input.lineage,
      programsById: input.programsById,
      programCompletionsById: input.programCompletionsById,
      goalCriteria: goal.successCriteria,
    });
    if (proof.kind === "SATISFIED") {
      evidenceRefs.push(...proof.evidenceRefs);
      continue;
    }
    if (proof.kind === "FALSE_BINDING") {
      sawFalseBinding = true;
      continue;
    }
    if (proof.kind === "UNSATISFIED") {
      sawUnsatisfied = true;
      continue;
    }
    if (proof.kind === "CRITERION_PROOF_UNAVAILABLE") {
      sawUnavailableCriterionProof = true;
      continue;
    }
    sawMissing = true;
  }

  if (evidenceRefs.length > 0) {
    return { status: "SATISFIED", evidenceRefs };
  }
  if (sawFalseBinding) {
    return {
      status: "UNSATISFIED",
      reasonCode: "FALSE_CONTRIBUTION_BINDING",
      message: `Binding criterion does not match goal ${input.goalId}`,
    };
  }
  if (sawUnsatisfied) {
    return {
      status: "UNSATISFIED",
      reasonCode: "PROGRAM_CRITERION_UNSATISFIED",
      message: `Bound programs did not prove goal ${input.goalId}`,
    };
  }
  if (sawUnavailableCriterionProof) {
    return {
      status: "INCONCLUSIVE",
      reasonCode: "CRITERION_PROOF_UNAVAILABLE",
      message: `ProgramCompletionRecord lacks criterion-level proof for goal ${input.goalId}`,
    };
  }
  if (sawMissing) {
    return {
      status: "INCONCLUSIVE",
      reasonCode: "INSUFFICIENT_EVIDENCE",
      message: `Missing program completion evidence for goal ${input.goalId}`,
    };
  }
  return {
    status: "INCONCLUSIVE",
    reasonCode: "INSUFFICIENT_EVIDENCE",
    message: `No proven contribution for goal ${input.goalId}`,
  };
}

function proveBinding(input: {
  binding: PortfolioGoalContributionBinding;
  lineage: readonly PortfolioProgramLineage[];
  programsById: ReadonlyMap<string, Program | null>;
  programCompletionsById: ReadonlyMap<
    string,
    ProgramCompletionRecord | null
  >;
  goalCriteria: readonly string[];
}):
  | { kind: "SATISFIED"; evidenceRefs: string[] }
  | { kind: "FALSE_BINDING" }
  | { kind: "MISSING" }
  | { kind: "UNSATISFIED" }
  | { kind: "CRITERION_PROOF_UNAVAILABLE" } {
  const boundCriterion = input.binding.programCriterionId;

  // Binding must name a success criterion of THIS portfolio goal.
  if (!input.goalCriteria.includes(boundCriterion)) {
    return { kind: "FALSE_BINDING" };
  }

  let programId = input.binding.programId;
  if (!programId && input.binding.programProposalId) {
    const link = input.lineage.find(
      (l) => l.proposalId === input.binding.programProposalId,
    );
    programId = link?.programId;
  }
  if (!programId) {
    return { kind: "MISSING" };
  }

  const program = input.programsById.get(programId) ?? null;
  if (!program) {
    return { kind: "MISSING" };
  }

  // Exact Program root criterion identity — not fuzzy text matching.
  const rootCriterionIndex =
    program.rootIntent.acceptanceCriteria.indexOf(boundCriterion);
  if (rootCriterionIndex < 0) {
    // Unrelated criterion: program never claimed this criterion.
    return { kind: "FALSE_BINDING" };
  }

  // Program status alone is never enough — need completion authority.
  const completion = input.programCompletionsById.get(programId) ?? null;
  if (!completion) {
    return { kind: "MISSING" };
  }

  if (completion.outcome !== "VERIFIED_SUCCESS") {
    return { kind: "UNSATISFIED" };
  }

  // Criterion-level proof must be present on the completion record.
  const criterionProof = completion.criterionResults.find(
    (c) => c.rootCriterionIndex === rootCriterionIndex,
  );

  if (!criterionProof) {
    // Completion exists but this specific criterion lacks authoritative proof.
    return { kind: "CRITERION_PROOF_UNAVAILABLE" };
  }

  // Confirm the indexed criterion text still matches (guards stale indexes).
  const indexedText =
    program.rootIntent.acceptanceCriteria[criterionProof.rootCriterionIndex];
  if (indexedText !== boundCriterion) {
    return { kind: "FALSE_BINDING" };
  }

  if (!criterionProof.satisfied) {
    return { kind: "UNSATISFIED" };
  }

  if (criterionProof.evidenceRefs.length === 0) {
    return { kind: "CRITERION_PROOF_UNAVAILABLE" };
  }

  return {
    kind: "SATISFIED",
    evidenceRefs: [
      `programCompletion:${completion.programCompletionRecordId}`,
      `rootCriterionIndex:${rootCriterionIndex}`,
      `rootCriterion:${boundCriterion}`,
      ...criterionProof.evidenceRefs,
    ],
  };
}
