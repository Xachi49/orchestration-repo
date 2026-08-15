import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { ExecutionPlan } from "../../domain/plan/execution-plan.js";
import type { ValidationFinding } from "../../domain/validation/index.js";
import type { PlanningContext } from "../../planning/context.js";
import {
  ContextualValidationAssessmentSchema,
  parseContextualValidationAssessment,
  type ContextualValidationAssessment,
  type ValidationModel,
  type ValidationModelInput,
  type ValidationModelOutput,
  type ValidationModelTokenUsage,
} from "../../validation/model.js";
import { ValidationPromptAssembler } from "../../validation/prompt-assembler.js";
import { ValidationError } from "../../validation/errors.js";
import {
  DEFAULT_VALIDATION_MAX_OUTPUT_TOKENS,
  type ValidationMaxOutputTokensByOperation,
} from "../../validation/token-reservation.js";

export interface OpenAIValidationModelOptions {
  apiKey: string | undefined;
  model: string;
  timeoutMs?: number;
  maxOutputTokensByOperation?: Partial<ValidationMaxOutputTokensByOperation>;
  client?: OpenAI;
}

function requireKey(apiKey: string | undefined): string {
  if (!apiKey || apiKey.trim() === "") {
    throw new ValidationError(
      "VALIDATION_MODEL_UNAVAILABLE",
      "OPENAI_API_KEY is unavailable for live validation mode",
    );
  }
  return apiKey;
}

function usageFromResponse(
  usage:
    | {
        input_tokens?: number;
        output_tokens?: number;
        total_tokens?: number;
      }
    | null
    | undefined,
): ValidationModelTokenUsage | undefined {
  if (!usage) {
    return undefined;
  }
  const result: ValidationModelTokenUsage = {};
  if (typeof usage.input_tokens === "number") {
    result.inputTokens = usage.input_tokens;
  }
  if (typeof usage.output_tokens === "number") {
    result.outputTokens = usage.output_tokens;
  }
  if (typeof usage.total_tokens === "number") {
    result.totalTokens = usage.total_tokens;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Optional OpenAI Responses API–backed `ValidationModel`.
 *
 * No tools, web search, file search, code interpreter, MCP, function calling,
 * or conversation state (`previous_response_id`). Opt-in only; the default
 * local stack never constructs it. Domain code must not import this class.
 */
export class OpenAIValidationModel implements ValidationModel {
  readonly provider = "openai";
  readonly toolsEnabled = false as const;
  readonly modelId: string;
  private readonly client: OpenAI;
  private readonly timeoutMs: number;
  private readonly maxOutputTokens: number;
  private readonly prompts = new ValidationPromptAssembler();

  constructor(options: OpenAIValidationModelOptions) {
    const apiKey = requireKey(options.apiKey);
    this.modelId = options.model;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.maxOutputTokens =
      options.maxOutputTokensByOperation?.CONTEXTUAL_ASSESSMENT ??
      DEFAULT_VALIDATION_MAX_OUTPUT_TOKENS.CONTEXTUAL_ASSESSMENT;
    this.client =
      options.client ??
      new OpenAI({
        apiKey,
        timeout: this.timeoutMs,
        maxRetries: 1,
      });
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): OpenAIValidationModel {
    return new OpenAIValidationModel({
      apiKey: env["OPENAI_API_KEY"],
      model:
        env["OPENAI_VALIDATION_MODEL"] ?? env["OPENAI_MODEL"] ?? "gpt-4.1-mini",
    });
  }

  async validatePlan(
    input: ValidationModelInput,
  ): Promise<ValidationModelOutput<ContextualValidationAssessment>> {
    const assembled = this.prompts.assemble({
      plan: input.plan as ExecutionPlan,
      context: input.context as PlanningContext,
      deterministicFindings:
        input.deterministicFindings as readonly ValidationFinding[],
    });

    const userContent = [
      assembled.controlPlaneSection,
      assembled.objectiveSection,
      assembled.planSection,
      assembled.deterministicFindingsSection,
      assembled.evidenceSection,
      assembled.taskSection,
    ].join("\n\n");

    try {
      const response = await this.client.responses.parse({
        model: this.modelId,
        temperature: 0,
        max_output_tokens: this.maxOutputTokens,
        input: [
          { role: "system", content: assembled.systemContract },
          { role: "user", content: userContent },
        ],
        text: {
          format: zodTextFormat(
            ContextualValidationAssessmentSchema,
            "contextual_validation_assessment",
          ),
        },
      });

      const usage = usageFromResponse(response.usage);

      if (response.status === "incomplete") {
        const reason = response.incomplete_details?.reason;
        if (reason === "content_filter") {
          throw new ValidationError(
            "VALIDATION_MODEL_REFUSED",
            "OpenAI refused the validation request",
          );
        }
        throw new ValidationError(
          "VALIDATION_MODEL_INVALID_OUTPUT",
          "OpenAI returned an incomplete validation response",
          { reason: reason ?? "unknown" },
        );
      }

      if (response.status === "failed" || response.error) {
        throw new ValidationError(
          "VALIDATION_MODEL_UNAVAILABLE",
          "OpenAI validation response failed",
          { cause: response.error?.message ?? response.status ?? "failed" },
        );
      }

      for (const item of response.output) {
        if (item.type !== "message") {
          continue;
        }
        for (const part of item.content) {
          if (part.type === "refusal") {
            throw new ValidationError(
              "VALIDATION_MODEL_REFUSED",
              "OpenAI refused the validation request",
              { refusal: part.refusal },
            );
          }
        }
      }

      if (response.output_parsed == null) {
        throw new ValidationError(
          "VALIDATION_MODEL_INVALID_OUTPUT",
          "OpenAI returned empty or unparsable structured validation output",
        );
      }

      const output: ValidationModelOutput<ContextualValidationAssessment> = {
        value: parseContextualValidationAssessment(response.output_parsed),
      };
      if (usage) {
        output.usage = usage;
      }
      return output;
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (/timeout|timed out|AbortError/i.test(message)) {
        throw new ValidationError(
          "VALIDATION_MODEL_TIMEOUT",
          "OpenAI validation request timed out",
        );
      }
      if (
        /parse|schema|invalid|json|structured/i.test(message) &&
        !/ECONN|ENOTFOUND|fetch failed|network/i.test(message)
      ) {
        throw new ValidationError(
          "VALIDATION_MODEL_INVALID_OUTPUT",
          "OpenAI returned malformed structured validation output",
          { cause: message },
        );
      }
      throw new ValidationError(
        "VALIDATION_MODEL_UNAVAILABLE",
        "OpenAI validation request failed",
        { cause: message },
      );
    }
  }
}
