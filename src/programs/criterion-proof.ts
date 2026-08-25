import type { Program } from "./program.js";
import type { ChildProgramNode, ProgramPlan } from "./program-plan.js";
import type { ProgramLineageRecord } from "./lineage.js";
import type {
  CompletionRecord,
  OutcomeVerificationRecord,
} from "../domain/verification/index.js";
import type { RunRecord } from "../admission/run-repository.js";

export type CriterionProofResult =
  | { satisfied: true; evidenceRefs: string[] }
  | {
      satisfied: false;
      outcome: "INCONCLUSIVE" | "PROGRAM_FAILED" | "NOT_PROVEN";
      reasonCode: string;
      message: string;
    };

/**
 * Deterministic contribution proof.
 *
 * Binding + COMPLETED + CompletionRecord alone is insufficient. The referenced
 * child criterion must match the root criterion text and the Phase 8
 * OutcomeVerificationRecord must show that child criterion SATISFIED.
 */
export function proveRootCriterion(input: {
  program: Program;
  plan: ProgramPlan;
  rootCriterionIndex: number;
  lineage: readonly ProgramLineageRecord[];
  runsById: ReadonlyMap<string, RunRecord | null>;
  completionsByRunId: ReadonlyMap<string, CompletionRecord | null>;
  outcomesById: ReadonlyMap<string, OutcomeVerificationRecord | null>;
}): CriterionProofResult {
  const rootText =
    input.program.rootIntent.acceptanceCriteria[input.rootCriterionIndex];
  if (rootText === undefined) {
    return {
      satisfied: false,
      outcome: "INCONCLUSIVE",
      reasonCode: "ROOT_CRITERION_MISSING",
      message: `Root criterion ${input.rootCriterionIndex} missing`,
    };
  }

  const binders = input.plan.nodes.filter((n) =>
    n.criterionBindings.some(
      (b) =>
        b.rootCriterionIndex === input.rootCriterionIndex &&
        b.contributionKind === "SATISFIES",
    ),
  );
  if (binders.length === 0) {
    return {
      satisfied: false,
      outcome: "INCONCLUSIVE",
      reasonCode: "NO_SATISFIES_BINDING",
      message: `No SATISFIES binding for root criterion ${input.rootCriterionIndex}`,
    };
  }

  const evidenceRefs: string[] = [];
  let sawRequiredFailure = false;
  let sawMissingEvidence = false;
  let sawFalseContribution = false;

  for (const node of binders) {
    const binding = node.criterionBindings.find(
      (b) =>
        b.rootCriterionIndex === input.rootCriterionIndex &&
        b.contributionKind === "SATISFIES",
    )!;
    const childText = node.acceptanceCriteria[binding.childCriterionIndex];
    if (childText === undefined || childText !== rootText) {
      sawFalseContribution = true;
      continue;
    }
    const link = input.lineage.find((l) => l.nodeId === node.nodeId);
    const runId = link?.childRunId;
    if (!runId) {
      sawMissingEvidence = true;
      continue;
    }
    const run = input.runsById.get(runId) ?? null;
    if (!run) {
      sawMissingEvidence = true;
      continue;
    }
    if (["FAILED", "CONTAINED", "CANCELLED"].includes(run.state)) {
      if (node.requirement === "REQUIRED") {
        sawRequiredFailure = true;
      }
      // OPTIONAL failure is ignored only when other binders still prove the root.
      continue;
    }
    if (run.state !== "COMPLETED") {
      sawMissingEvidence = true;
      continue;
    }
    const completion = input.completionsByRunId.get(runId) ?? null;
    if (!completion) {
      sawMissingEvidence = true;
      continue;
    }
    const outcome =
      input.outcomesById.get(completion.outcomeVerificationId) ?? null;
    if (!outcome) {
      sawMissingEvidence = true;
      continue;
    }
    if (outcome.outcome !== "VERIFIED_SUCCESS") {
      sawMissingEvidence = true;
      continue;
    }
    const childResult = outcome.criterionResults[binding.childCriterionIndex];
    if (!childResult) {
      sawMissingEvidence = true;
      continue;
    }
    if (
      childResult.criterionText !== rootText ||
      childResult.verdict !== "SATISFIED"
    ) {
      sawFalseContribution = true;
      continue;
    }
    if (
      binding.evidenceRequirement === "COMPLETION_AND_VERIFICATION" &&
      !completion.outcomeVerificationId
    ) {
      sawMissingEvidence = true;
      continue;
    }
    evidenceRefs.push(
      `completion:${completion.completionRecordId}`,
      `outcomeVerification:${outcome.outcomeVerificationId}`,
      `childCriterion:${node.nodeId}:${binding.childCriterionIndex}`,
      `childCriterionVerdict:${childResult.verdict}`,
    );
  }

  if (evidenceRefs.length > 0) {
    return { satisfied: true, evidenceRefs };
  }
  if (sawRequiredFailure) {
    return {
      satisfied: false,
      outcome: "PROGRAM_FAILED",
      reasonCode: "REQUIRED_CHILD_FAILED",
      message: `Required contribution failed for criterion ${input.rootCriterionIndex}`,
    };
  }
  if (sawFalseContribution && !sawMissingEvidence) {
    return {
      satisfied: false,
      outcome: "NOT_PROVEN",
      reasonCode: "FALSE_CONTRIBUTION_BINDING",
      message: `Contribution binding does not prove root criterion ${input.rootCriterionIndex}`,
    };
  }
  return {
    satisfied: false,
    outcome: "INCONCLUSIVE",
    reasonCode: "MISSING_CONTRIBUTION_EVIDENCE",
    message: `Missing durable evidence for root criterion ${input.rootCriterionIndex}`,
  };
}

export function nodeProvesRootCriterion(
  node: ChildProgramNode,
  rootCriterionIndex: number,
  rootText: string,
): boolean {
  return node.criterionBindings.some(
    (b) =>
      b.rootCriterionIndex === rootCriterionIndex &&
      b.contributionKind === "SATISFIES" &&
      node.acceptanceCriteria[b.childCriterionIndex] === rootText,
  );
}
