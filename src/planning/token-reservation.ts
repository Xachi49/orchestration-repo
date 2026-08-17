import type { AssembledPlanningPrompt } from "./prompt-assembler.js";
import type { PlanningModelOperation } from "./model.js";

/**
 * Bounded maximum output tokens per planning operation.
 * Used both for OpenAI `max_output_tokens` and pre-call reservation.
 * Provider defaults must not define an unbounded allowance.
 */
export const DEFAULT_PLANNING_MAX_OUTPUT_TOKENS = {
  GAP_ANALYSIS: 4_096,
  PLAN_PROPOSAL: 4_096,
} as const satisfies Record<PlanningModelOperation, number>;

export type PlanningMaxOutputTokensByOperation = Record<
  PlanningModelOperation,
  number
>;

/**
 * Conservative estimate of compiled planning prompt input tokens.
 * Deterministic; never uses post-hoc provider actuals for reservation.
 */
export interface PlanningTokenReservationEstimator {
  estimateInputTokens(assembled: AssembledPlanningPrompt): number;
}

/**
 * Overestimates relative to common ~4 chars/token heuristics by using
 * ceil(utf8Bytes / 3), so reservation stays fail-closed.
 */
export class ByteLengthPlanningTokenEstimator
  implements PlanningTokenReservationEstimator
{
  estimateInputTokens(assembled: AssembledPlanningPrompt): number {
    const text = [
      assembled.systemContract,
      assembled.controlPlaneSection,
      assembled.objectiveSection,
      assembled.repositorySection,
      assembled.precedentsSection,
      assembled.evidenceSection,
      assembled.taskSection,
    ].join("\n\n");
    return Math.max(1, Math.ceil(Buffer.byteLength(text, "utf8") / 3));
  }
}

/** Test helper: fixed input estimate independent of prompt size. */
export class FixedPlanningTokenEstimator
  implements PlanningTokenReservationEstimator
{
  constructor(private readonly tokens: number) {}

  estimateInputTokens(_assembled: AssembledPlanningPrompt): number {
    return this.tokens;
  }
}

export function computeTokenReservation(input: {
  inputTokenEstimate: number;
  maxOutputTokens: number;
}): number {
  if (input.inputTokenEstimate < 0 || input.maxOutputTokens < 0) {
    throw new Error("Token reservation components must be non-negative");
  }
  return input.inputTokenEstimate + input.maxOutputTokens;
}
