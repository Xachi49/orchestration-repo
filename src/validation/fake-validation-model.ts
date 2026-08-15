import {
  parseContextualValidationAssessment,
  type ContextualValidationAssessment,
  type ValidationModel,
  type ValidationModelInput,
  type ValidationModelOutput,
  type ValidationModelTokenUsage,
} from "./model.js";
import { ValidationPreDispatchError } from "./errors.js";

export const PASSING_ASSESSMENT: ContextualValidationAssessment = {
  recommendation: "PASS",
  confidence: 0.9,
  observations: [],
  unsupportedClaims: [],
  coverageGaps: [],
  summary:
    "Deterministic fake validator found no contextual objection to the plan.",
};

/**
 * Deterministic fake validation model for tests and the default local stack.
 * Never contacts a provider.
 */
export class FakeValidationModel implements ValidationModel {
  readonly provider = "fake";
  readonly modelId = "fake-validation-v1";
  readonly toolsEnabled = false as const;

  private assessment: ContextualValidationAssessment = PASSING_ASSESSMENT;
  private readonly queue: ContextualValidationAssessment[] = [];
  private failNext: Error | null = null;
  private failBeforeDispatchNext: Error | null = null;
  private omitUsageNext = false;
  private tokenUsage: ValidationModelTokenUsage | undefined = {
    inputTokens: 120,
    outputTokens: 60,
    totalTokens: 180,
  };
  callCount = 0;
  lastInput: ValidationModelInput | null = null;

  setAssessment(assessment: ContextualValidationAssessment): void {
    this.assessment = parseContextualValidationAssessment(assessment);
  }

  /** Consumed one per call, then falls back to the standing assessment. */
  queueAssessments(
    assessments: readonly ContextualValidationAssessment[],
  ): void {
    for (const assessment of assessments) {
      this.queue.push(parseContextualValidationAssessment(assessment));
    }
  }

  /** Convenience: a single blocking, repairable contextual objection. */
  setReviseRecommendation(input: {
    ruleId: string;
    message?: string;
    affectedStepIds?: readonly string[];
  }): void {
    this.setAssessment({
      recommendation: "REVISE",
      confidence: 0.6,
      observations: [
        {
          ruleId: input.ruleId,
          category: "semantic-coverage",
          severity: "ERROR",
          message: input.message ?? `Contextual objection ${input.ruleId}`,
          affectedStepIds: [...(input.affectedStepIds ?? [])],
          evidenceRefs: [],
          repairable: true,
          rationale: "Fake validation model configured to request a revision",
        },
      ],
      unsupportedClaims: [],
      coverageGaps: [],
      summary: "Fake validation model requests a bounded revision.",
    });
  }

  failNextCall(error: Error): void {
    this.failNext = error;
  }

  failBeforeDispatch(
    error: Error = new ValidationPreDispatchError("pre-dispatch"),
  ): void {
    this.failBeforeDispatchNext = error;
  }

  setTokenUsagePerCall(usage: ValidationModelTokenUsage | undefined): void {
    this.tokenUsage = usage === undefined ? undefined : { ...usage };
  }

  omitUsageOnNextCall(): void {
    this.omitUsageNext = true;
  }

  async validatePlan(
    input: ValidationModelInput,
  ): Promise<ValidationModelOutput<ContextualValidationAssessment>> {
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
    const output: ValidationModelOutput<ContextualValidationAssessment> = {
      value,
    };
    if (!this.omitUsageNext && this.tokenUsage) {
      output.usage = { ...this.tokenUsage };
    }
    this.omitUsageNext = false;
    return output;
  }
}
