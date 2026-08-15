import {
  parseContextualOutcomeAssessment,
  type ContextualOutcomeAssessment,
  type ContextualOutcomeInput,
  type VerificationModel,
  type VerificationModelOutput,
  type VerificationModelTokenUsage,
} from "./model.js";
import { VerificationPreDispatchError } from "./errors.js";

export const PASSING_OUTCOME_ASSESSMENT: ContextualOutcomeAssessment = {
  recommendedOutcome: "VERIFIED_SUCCESS",
  criterionConcerns: [],
  unsupportedClaims: [],
  contradictions: [],
  missingEvidence: [],
  semanticGaps: [],
  conciseRationale:
    "Deterministic fake verifier found no contextual objection to the outcome.",
  findings: [],
};

/**
 * Deterministic fake verification model for tests and the default local stack.
 * Never contacts a provider. Cannot create success authority by itself.
 */
export class FakeVerificationModel implements VerificationModel {
  readonly provider = "fake";
  readonly modelId = "fake-verification-v1";
  readonly toolsEnabled = false as const;

  private assessment: ContextualOutcomeAssessment = PASSING_OUTCOME_ASSESSMENT;
  private readonly queue: ContextualOutcomeAssessment[] = [];
  private failNext: Error | null = null;
  private failBeforeDispatchNext: Error | null = null;
  private omitUsageNext = false;
  private tokenUsage: VerificationModelTokenUsage | undefined = {
    inputTokens: 100,
    outputTokens: 40,
    totalTokens: 140,
  };
  callCount = 0;
  lastInput: ContextualOutcomeInput | null = null;

  setAssessment(assessment: ContextualOutcomeAssessment): void {
    this.assessment = parseContextualOutcomeAssessment(assessment);
  }

  queueAssessments(
    assessments: readonly ContextualOutcomeAssessment[],
  ): void {
    for (const assessment of assessments) {
      this.queue.push(parseContextualOutcomeAssessment(assessment));
    }
  }

  /** Force a success-blocking contextual concern (downgrade path). */
  setBlockingConcern(input: {
    ruleId: string;
    message?: string;
    recommendedOutcome?: ContextualOutcomeAssessment["recommendedOutcome"];
  }): void {
    this.setAssessment({
      recommendedOutcome: input.recommendedOutcome ?? "INCONCLUSIVE",
      criterionConcerns: [input.message ?? input.ruleId],
      unsupportedClaims: [],
      contradictions: [],
      missingEvidence: [],
      semanticGaps: [],
      conciseRationale: "Fake verification model configured to challenge success",
      findings: [
        {
          findingId: "fake_contextual_1",
          category: "CONTEXTUAL",
          severity: "ERROR",
          ruleId: input.ruleId,
          message: input.message ?? `Contextual concern ${input.ruleId}`,
          criterionIds: [],
          stepIds: [],
          evidenceRefs: [],
          blocksVerifiedSuccess: true,
          metadata: {},
        },
      ],
    });
  }

  failNextCall(error: Error): void {
    this.failNext = error;
  }

  failBeforeDispatch(
    error: Error = new VerificationPreDispatchError("pre-dispatch"),
  ): void {
    this.failBeforeDispatchNext = error;
  }

  setTokenUsagePerCall(usage: VerificationModelTokenUsage | undefined): void {
    this.tokenUsage = usage === undefined ? undefined : { ...usage };
  }

  omitUsageOnNextCall(): void {
    this.omitUsageNext = true;
  }

  async assessOutcome(
    input: ContextualOutcomeInput,
  ): Promise<VerificationModelOutput<ContextualOutcomeAssessment>> {
    if (this.failBeforeDispatchNext) {
      const error = this.failBeforeDispatchNext;
      this.failBeforeDispatchNext = null;
      throw error;
    }
    this.callCount += 1;
    this.lastInput = input;
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = null;
      throw error;
    }

    const value = this.queue.shift() ?? this.assessment;
    const output: VerificationModelOutput<ContextualOutcomeAssessment> = {
      value,
    };
    if (!this.omitUsageNext && this.tokenUsage) {
      output.usage = { ...this.tokenUsage };
    }
    this.omitUsageNext = false;
    return output;
  }
}
