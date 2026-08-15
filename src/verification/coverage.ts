import type {
  AcceptanceCriterionResult,
  StepPostconditionResult,
  VerificationEvidence,
  VerificationFinding,
  VerificationSpecification,
} from "../domain/verification/index.js";
import type { ExecutionPlan } from "../domain/plan/execution-plan.js";
import { heuristicRelevanceSuggestion } from "./binding-fulfillment.js";
import type { VerificationIdentityGenerator } from "./identity.js";

export interface CoverageAssessment {
  complete: boolean;
  findings: VerificationFinding[];
  /** Criterion ids lacking approved binding or qualifying evidence. */
  unmappedCriterionIds: readonly string[];
  /** Postcondition ids lacking evidence. */
  unmappedPostconditionIds: readonly string[];
}

/**
 * Operates against approved plan bindings.
 * Missing required bound evidence → INCONCLUSIVE (never default success).
 * HEURISTIC_RELEVANCE ≠ VERIFICATION_BINDING.
 */
export class VerificationCoverageService {
  constructor(private readonly identities: VerificationIdentityGenerator) {}

  assess(input: {
    specification: VerificationSpecification;
    plan: ExecutionPlan;
    criterionResults: readonly AcceptanceCriterionResult[];
    postconditionResults: readonly StepPostconditionResult[];
    evidence: readonly VerificationEvidence[];
  }): CoverageAssessment {
    const findings: VerificationFinding[] = [];
    const unmappedCriterionIds: string[] = [];
    const unmappedPostconditionIds: string[] = [];

    const bindings = input.plan.acceptanceCriterionVerificationBindings ?? [];
    const bindingsById = new Map(bindings.map((b) => [b.criterionId, b]));

    const criterionIds = new Set(
      input.specification.acceptanceCriteria.map((c) => c.criterionId),
    );
    const resultIds = new Set(
      input.criterionResults.map((c) => c.criterionId),
    );

    for (const criterion of input.specification.acceptanceCriteria) {
      if (!resultIds.has(criterion.criterionId)) {
        findings.push(
          this.finding({
            ruleId: "VERIFICATION_CRITERION_UNMAPPED",
            message: `Acceptance criterion missing from results: ${criterion.criterionText}`,
            category: "ACCEPTANCE_CRITERION",
            criterionIds: [criterion.criterionId],
          }),
        );
        unmappedCriterionIds.push(criterion.criterionId);
      }

      const binding = bindingsById.get(criterion.criterionId);
      if (!binding) {
        findings.push(
          this.finding({
            ruleId: "VERIFICATION_CRITERION_UNBOUND",
            message: `No approved verification binding for criterion: ${criterion.criterionText}`,
            category: "BINDING",
            criterionIds: [criterion.criterionId],
          }),
        );
        unmappedCriterionIds.push(criterion.criterionId);
        // Diagnostic only — never authoritative
        const heuristic = heuristicRelevanceSuggestion(criterion.criterionText);
        if (heuristic) {
          findings.push(
            this.finding({
              ruleId: "HEURISTIC_RELEVANCE_SUGGESTION",
              message: `Non-authoritative heuristic suggestion: ${heuristic} (HEURISTIC_RELEVANCE≠VERIFICATION_BINDING)`,
              category: "CONTEXTUAL",
              criterionIds: [criterion.criterionId],
              blocksVerifiedSuccess: false,
              severity: "INFO",
            }),
          );
        }
      }
    }

    for (const result of input.criterionResults) {
      if (!criterionIds.has(result.criterionId)) {
        findings.push(
          this.finding({
            ruleId: "VERIFICATION_EVIDENCE_CONFLICT",
            message: `Result for nonexistent criterion ${result.criterionId}`,
            category: "EVIDENCE_GAP",
            criterionIds: [result.criterionId],
          }),
        );
      }
      if (result.evidenceRefs.length === 0) {
        unmappedCriterionIds.push(result.criterionId);
        if (
          result.verdict !== "INCONCLUSIVE" &&
          result.verdict !== "UNSATISFIED"
        ) {
          findings.push(
            this.finding({
              ruleId: "VERIFICATION_EVIDENCE_MISSING",
              message: `Criterion lacks bound evidence but verdict is ${result.verdict}`,
              category: "EVIDENCE_GAP",
              criterionIds: [result.criterionId],
            }),
          );
        }
      }

      // Keyword coincidence must never appear as SATISFIED method
      if (
        result.verdict === "SATISFIED" &&
        result.verificationMethod.startsWith("KEYWORD_")
      ) {
        findings.push(
          this.finding({
            ruleId: "HEURISTIC_USED_AS_AUTHORITY",
            message:
              "Keyword heuristic must not authorize SATISFIED (HEURISTIC_RELEVANCE≠VERIFICATION_BINDING)",
            category: "BINDING",
            criterionIds: [result.criterionId],
          }),
        );
      }
    }

    for (const pc of input.specification.postconditions) {
      const result = input.postconditionResults.find(
        (r) => r.postconditionId === pc.postconditionId,
      );
      if (!result || result.evidenceRefs.length === 0) {
        unmappedPostconditionIds.push(pc.postconditionId);
      }
    }

    for (const evidence of input.evidence) {
      for (const cid of evidence.criterionIds) {
        if (!criterionIds.has(cid)) {
          findings.push(
            this.finding({
              ruleId: "VERIFICATION_EVIDENCE_CONFLICT",
              message: `Evidence points to nonexistent criterion ${cid}`,
              category: "EVIDENCE_GAP",
              criterionIds: [cid],
              evidenceRefs: [evidence.evidenceId],
            }),
          );
        }
        const binding = bindingsById.get(cid);
        if (binding && evidence.stepIds.length > 0) {
          const wrongStep = evidence.stepIds.every(
            (s) => !binding.stepIds.includes(s),
          );
          if (wrongStep) {
            findings.push(
              this.finding({
                ruleId: "VERIFICATION_EVIDENCE_CONFLICT",
                message: `Evidence for criterion ${cid} references unbound step`,
                category: "EVIDENCE_GAP",
                criterionIds: [cid],
                evidenceRefs: [evidence.evidenceId],
              }),
            );
          }
        }
      }
    }

    for (const cid of criterionIds) {
      const related = input.evidence.filter((e) =>
        e.criterionIds.includes(cid),
      );
      // Conflict only when same sourceType disagrees — complementary types
      // (STEP_RESULT + EXECUTION_ARTIFACT) may jointly fulfill a binding.
      const bySource = new Map<string, VerificationEvidence[]>();
      for (const e of related) {
        const list = bySource.get(e.sourceType) ?? [];
        list.push(e);
        bySource.set(e.sourceType, list);
      }
      for (const [, group] of bySource) {
        if (group.length <= 1) continue;
        const unique = new Set(
          group.map((e) => JSON.stringify(e.observedValue)),
        );
        if (unique.size > 1) {
          findings.push(
            this.finding({
              ruleId: "VERIFICATION_EVIDENCE_CONFLICT",
              message: `Duplicate conflicting evidence for criterion ${cid}`,
              category: "EVIDENCE_GAP",
              criterionIds: [cid],
              evidenceRefs: group.map((e) => e.evidenceId),
            }),
          );
        }
      }
    }

    for (const result of input.criterionResults) {
      if (result.verdict === "SATISFIED" && result.evidenceRefs.length === 0) {
        findings.push(
          this.finding({
            ruleId: "VERIFICATION_EVIDENCE_MISSING",
            message: "Unsupported success claim: SATISFIED without evidence",
            category: "EVIDENCE_GAP",
            criterionIds: [result.criterionId],
          }),
        );
      }
    }

    return {
      complete:
        unmappedCriterionIds.length === 0 &&
        unmappedPostconditionIds.length === 0 &&
        !findings.some((f) => f.blocksVerifiedSuccess),
      findings,
      unmappedCriterionIds,
      unmappedPostconditionIds,
    };
  }

  private finding(input: {
    ruleId: string;
    message: string;
    category: VerificationFinding["category"];
    criterionIds?: string[];
    evidenceRefs?: string[];
    blocksVerifiedSuccess?: boolean;
    severity?: VerificationFinding["severity"];
  }): VerificationFinding {
    return {
      findingId: this.identities.nextFindingId(),
      category: input.category,
      severity: input.severity ?? "ERROR",
      ruleId: input.ruleId,
      message: input.message,
      criterionIds: input.criterionIds ?? [],
      stepIds: [],
      evidenceRefs: input.evidenceRefs ?? [],
      blocksVerifiedSuccess: input.blocksVerifiedSuccess ?? true,
      metadata: {},
    };
  }
}
