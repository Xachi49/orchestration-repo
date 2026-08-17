import type {
  LearningModel,
  LearningModelInput,
  LearningModelOutput,
  LearningModelTokenUsage,
} from "./model.js";

/**
 * Default learning model. Never promotes. Never assigns trust.
 * Suggestions are advisory only.
 */
export class FakeLearningModel implements LearningModel {
  readonly provider = "fake";
  readonly modelId = "fake-learning-v1";

  /** When set, returns this output (for tests). */
  forcedOutput: LearningModelOutput | null = null;

  async assess(input: LearningModelInput): Promise<{
    value: LearningModelOutput;
    usage?: LearningModelTokenUsage;
  }> {
    if (this.forcedOutput) {
      return {
        value: this.forcedOutput,
        usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
      };
    }
    // Default: no contextual suggestions — deterministic extraction owns learning.
    void input;
    return {
      value: { suggestions: [] },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };
  }
}
