import type {
  AcceptanceCriterionResult,
  CriterionVerdict,
  VerificationEvidence,
  VerificationFinding,
} from "../domain/verification/index.js";
import type { AcceptanceCriterionVerificationBinding } from "../domain/plan/verification-binding.js";
import type { ExecutionPlan } from "../domain/plan/execution-plan.js";
import type { ActionOutcomeVerification } from "./action-verifiers.js";
import type { VerificationIdentityGenerator } from "./identity.js";

/**
 * Evaluate whether approved plan bindings are fulfilled by authoritative evidence.
 *
 * HEURISTIC_RELEVANCE ≠ VERIFICATION_BINDING — this evaluator never uses
 * keyword/action coincidence as completion authority.
 */
export class BindingFulfillmentEvaluator {
  constructor(private readonly identities: VerificationIdentityGenerator) {}

  evaluateCriterion(input: {
    criterionId: string;
    criterionText: string;
    binding: AcceptanceCriterionVerificationBinding | undefined;
    plan: ExecutionPlan;
    actionOutcomes: readonly ActionOutcomeVerification[];
    evidence: readonly VerificationEvidence[];
    findings: VerificationFinding[];
  }): AcceptanceCriterionResult {
    const findingRefs: string[] = [];
    const evidenceRefs: string[] = [];
    const stepRefs: string[] = [];

    if (!input.binding) {
      const finding = this.finding({
        category: "BINDING",
        ruleId: "VERIFICATION_CRITERION_UNBOUND",
        message: `No approved verification binding for criterion: ${input.criterionText}`,
        criterionIds: [input.criterionId],
        blocksVerifiedSuccess: true,
      });
      input.findings.push(finding);
      return {
        criterionId: input.criterionId,
        criterionText: input.criterionText,
        verdict: "INCONCLUSIVE",
        evidenceRefs: [],
        stepRefs: [],
        findingRefs: [finding.findingId],
        conciseRationale: "Missing approved verification binding",
        verificationMethod: "UNBOUND",
      };
    }

    const binding = input.binding;
    stepRefs.push(...binding.stepIds);

    const boundOutcomes = input.actionOutcomes.filter((o) =>
      binding.stepIds.includes(o.stepId),
    );

    // Collect qualifying evidence for this binding only
    const qualifying = input.evidence.filter((e) =>
      evidenceQualifiesForBinding(e, binding),
    );
    for (const e of qualifying) {
      evidenceRefs.push(e.evidenceId);
    }

    // Wrong-step / wrong-type evidence attached to criterion is a conflict
    const claimed = input.evidence.filter((e) =>
      e.criterionIds.includes(input.criterionId),
    );
    for (const e of claimed) {
      if (!evidenceQualifiesForBinding(e, binding)) {
        const finding = this.finding({
          category: "EVIDENCE_GAP",
          ruleId: "VERIFICATION_EVIDENCE_CONFLICT",
          message: `Evidence ${e.evidenceId} is not allowed by approved binding for ${input.criterionId}`,
          criterionIds: [input.criterionId],
          evidenceRefs: [e.evidenceId],
          blocksVerifiedSuccess: true,
        });
        input.findings.push(finding);
        findingRefs.push(finding.findingId);
      }
    }

    if (qualifying.length === 0) {
      const finding = this.finding({
        category: "EVIDENCE_GAP",
        ruleId: "VERIFICATION_EVIDENCE_MISSING",
        message: `Approved binding unfulfilled: no qualifying evidence for ${input.criterionText}`,
        criterionIds: [input.criterionId],
        stepIds: binding.stepIds,
        blocksVerifiedSuccess: true,
      });
      input.findings.push(finding);
      findingRefs.push(finding.findingId);
      return {
        criterionId: input.criterionId,
        criterionText: input.criterionText,
        verdict: "INCONCLUSIVE",
        evidenceRefs: [],
        stepRefs,
        findingRefs,
        conciseRationale: "Approved binding lacks qualifying evidence",
        verificationMethod: binding.verificationMethod,
      };
    }

    const methodResult = evaluateMethod({
      binding,
      boundOutcomes,
      qualifying,
      plan: input.plan,
    });

    for (const f of methodResult.findings) {
      input.findings.push(f);
      findingRefs.push(f.findingId);
    }

    return {
      criterionId: input.criterionId,
      criterionText: input.criterionText,
      verdict: methodResult.verdict,
      evidenceRefs: [...new Set(evidenceRefs)],
      stepRefs,
      findingRefs,
      conciseRationale: methodResult.rationale,
      verificationMethod: binding.verificationMethod,
    };
  }

  private finding(input: {
    category: VerificationFinding["category"];
    ruleId: string;
    message: string;
    criterionIds?: string[];
    stepIds?: string[];
    evidenceRefs?: string[];
    blocksVerifiedSuccess?: boolean;
  }): VerificationFinding {
    return {
      findingId: this.identities.nextFindingId(),
      category: input.category,
      severity: "ERROR",
      ruleId: input.ruleId,
      message: input.message,
      criterionIds: input.criterionIds ?? [],
      stepIds: input.stepIds ?? [],
      evidenceRefs: input.evidenceRefs ?? [],
      blocksVerifiedSuccess: input.blocksVerifiedSuccess ?? true,
      metadata: {},
    };
  }
}

function evidenceQualifiesForBinding(
  evidence: VerificationEvidence,
  binding: AcceptanceCriterionVerificationBinding,
): boolean {
  if (
    !binding.requiredEvidenceClasses.includes(
      evidence.trustClass as (typeof binding.requiredEvidenceClasses)[number],
    )
  ) {
    // MODEL_INTERPRETATION never qualifies
    if (evidence.trustClass === "MODEL_INTERPRETATION") return false;
    // Allow SYSTEM_* that are in required set only
    return false;
  }

  const stepOverlap = evidence.stepIds.some((s) => binding.stepIds.includes(s));
  if (!stepOverlap && evidence.stepIds.length > 0) {
    return false;
  }

  switch (binding.verificationMethod) {
    case "REGISTERED_TEST_RESULT":
      return (
        evidence.sourceType === "TEST_RESULT" &&
        (binding.testProfileId === undefined ||
          (evidence.metadata as { testProfileId?: string }).testProfileId ===
            binding.testProfileId ||
          evidence.observedValue === binding.testProfileId ||
          JSON.stringify(evidence.observedValue).includes(
            binding.testProfileId ?? "",
          ))
      );
    case "EXECUTION_ARTIFACT":
      return (
        evidence.sourceType === "EXECUTION_ARTIFACT" &&
        (binding.artifactTypes === undefined ||
          binding.artifactTypes.length === 0 ||
          binding.artifactTypes.includes(
            String(
              (evidence.metadata as { artifactType?: string }).artifactType ??
                "",
            ),
          ))
      );
    case "TASK_RECORD":
      return evidence.sourceType === "TASK_RECORD";
    case "PR_PREPARATION_ARTIFACT":
      return (
        evidence.sourceType === "PR_PREPARATION" ||
        (evidence.sourceType === "EXECUTION_ARTIFACT" &&
          (binding.artifactTypes?.includes("PR_PREPARATION") ?? true))
      );
    case "STEP_POSTCONDITION":
      return (
        evidence.sourceType === "STEP_RESULT" ||
        evidence.sourceType === "EXECUTION_ARTIFACT" ||
        evidence.sourceType === "TEST_RESULT" ||
        evidence.sourceType === "TASK_RECORD" ||
        evidence.sourceType === "PR_PREPARATION"
      );
    case "ACTION_OUTCOME":
      return (
        evidence.sourceType === "STEP_RESULT" ||
        evidence.sourceType === "EXECUTION_ARTIFACT" ||
        evidence.sourceType === "TEST_RESULT" ||
        evidence.sourceType === "TASK_RECORD" ||
        evidence.sourceType === "PR_PREPARATION"
      );
    default:
      return false;
  }
}

function evaluateMethod(input: {
  binding: AcceptanceCriterionVerificationBinding;
  boundOutcomes: readonly ActionOutcomeVerification[];
  qualifying: readonly VerificationEvidence[];
  plan: ExecutionPlan;
}): {
  verdict: CriterionVerdict;
  rationale: string;
  findings: VerificationFinding[];
} {
  const findings: VerificationFinding[] = [];
  const { binding, boundOutcomes, qualifying } = input;

  if (binding.requireAll && boundOutcomes.length < binding.stepIds.length) {
    return {
      verdict: "INCONCLUSIVE",
      rationale: "requireAll binding missing outcomes for some bound steps",
      findings,
    };
  }

  const failed = boundOutcomes.filter(
    (o) =>
      !o.passed ||
      o.postconditionVerdict === "UNSATISFIED",
  );
  const partial = boundOutcomes.filter(
    (o) => o.postconditionVerdict === "PARTIALLY_SATISFIED",
  );
  const inconclusive = boundOutcomes.filter(
    (o) => o.postconditionVerdict === "INCONCLUSIVE",
  );

  if (failed.length > 0) {
    return {
      verdict: "UNSATISFIED",
      rationale: failed.map((f) => f.observedSummary).join("; "),
      findings,
    };
  }
  if (partial.length > 0) {
    return {
      verdict: "PARTIALLY_SATISFIED",
      rationale: partial.map((f) => f.observedSummary).join("; "),
      findings,
    };
  }
  if (inconclusive.length > 0 || boundOutcomes.length === 0) {
    return {
      verdict: "INCONCLUSIVE",
      rationale: "Bound step outcomes inconclusive or missing",
      findings,
    };
  }

  // REGISTERED_TEST_RESULT: non-zero exit must fail
  if (binding.verificationMethod === "REGISTERED_TEST_RESULT") {
    const testFail = boundOutcomes.some((o) =>
      o.findings.some((f) => f.ruleId.includes("TEST") && f.blocksVerifiedSuccess),
    );
    if (testFail || boundOutcomes.some((o) => !o.passed)) {
      return {
        verdict: "UNSATISFIED",
        rationale: "Registered test result did not satisfy binding",
        findings,
      };
    }
  }

  if (qualifying.length === 0) {
    return {
      verdict: "INCONCLUSIVE",
      rationale: "No qualifying authoritative evidence for binding",
      findings,
    };
  }

  const allPassed = boundOutcomes.every(
    (o) => o.passed && o.postconditionVerdict === "SATISFIED",
  );
  if (allPassed) {
    return {
      verdict: "SATISFIED",
      rationale: `Approved binding ${binding.verificationMethod} fulfilled`,
      findings,
    };
  }

  return {
    verdict: "INCONCLUSIVE",
    rationale: "Binding not fully fulfilled",
    findings,
  };
}

/**
 * Non-authoritative diagnostic only.
 * HEURISTIC_RELEVANCE ≠ VERIFICATION_BINDING.
 * Must never create SYSTEM_OBSERVED evidence or cause SATISFIED / VERIFIED_SUCCESS.
 */
export function heuristicRelevanceSuggestion(
  criterionText: string,
): string | undefined {
  const norm = criterionText.trim().toLowerCase();
  if (norm.includes("patch")) return "CREATE_LOCAL_PATCH";
  if (norm.includes("test")) return "RUN_TESTS";
  if (norm.includes("task") && !norm.includes("patch")) return "CREATE_TASK";
  if (norm.includes("pull request") || norm.includes("pr preparation")) {
    return "PREPARE_PULL_REQUEST";
  }
  return undefined;
}
