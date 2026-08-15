import {
  parseContainmentResult,
  type ContainmentResult,
} from "../domain/execution/index.js";

export function buildContainmentResult(input: {
  runId: string;
  executionAttemptId: string;
  reasonCode: string;
  reasonMessage: string;
  preservedStepIds: readonly string[];
  preservedArtifactRefs: readonly string[];
  containedAt: string;
}): ContainmentResult {
  return parseContainmentResult({
    contained: true as const,
    runId: input.runId,
    executionAttemptId: input.executionAttemptId,
    reasonCode: input.reasonCode,
    reasonMessage: input.reasonMessage,
    preservedStepIds: [...input.preservedStepIds],
    preservedArtifactRefs: [...input.preservedArtifactRefs],
    containedAt: input.containedAt,
  });
}
