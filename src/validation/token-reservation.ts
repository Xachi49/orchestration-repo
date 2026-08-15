import { computeTokenReservation } from "../planning/token-reservation.js";
import type { AssembledValidationPrompt } from "./prompt-assembler.js";
import type { AssembledRevisionPrompt } from "./revision-prompt-assembler.js";
import type { ValidationModelOperation } from "./model.js";

export { computeTokenReservation };

/**
 * Bounded maximum output tokens per validation operation.
 * Used both for provider `max_output_tokens` and for pre-call reservation.
 * There is no unbounded provider default.
 */
export const DEFAULT_VALIDATION_MAX_OUTPUT_TOKENS = {
  CONTEXTUAL_ASSESSMENT: 4_096,
  PLAN_REVISION: 4_096,
} as const satisfies Record<ValidationModelOperation, number>;

export type ValidationMaxOutputTokensByOperation = Record<
  ValidationModelOperation,
  number
>;

export type AssembledValidationPromptLike =
  | AssembledValidationPrompt
  | AssembledRevisionPrompt;

/**
 * Conservative estimate of compiled prompt input tokens.
 * Deterministic; provider actuals are never used to size a reservation.
 */
export interface ValidationTokenReservationEstimator {
  estimateInputTokens(assembled: AssembledValidationPromptLike): number;
}

/** Every assembled section except the version marker, in stable order. */
function promptText(assembled: AssembledValidationPromptLike): string {
  return Object.entries(assembled)
    .filter(([key]) => key !== "promptVersion")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, section]) => String(section))
    .join("\n\n");
}

/**
 * Overestimates relative to common ~4 chars/token heuristics by using
 * ceil(utf8Bytes / 3), so the reservation stays fail-closed.
 */
export class ByteLengthValidationTokenEstimator
  implements ValidationTokenReservationEstimator
{
  estimateInputTokens(assembled: AssembledValidationPromptLike): number {
    return Math.max(
      1,
      Math.ceil(Buffer.byteLength(promptText(assembled), "utf8") / 3),
    );
  }
}

/** Test helper: fixed input estimate independent of prompt size. */
export class FixedValidationTokenEstimator
  implements ValidationTokenReservationEstimator
{
  constructor(private readonly tokens: number) {}

  estimateInputTokens(_assembled: AssembledValidationPromptLike): number {
    return this.tokens;
  }
}
