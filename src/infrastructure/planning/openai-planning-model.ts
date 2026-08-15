import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { ZodType } from "zod";
import type {
  PlanningModel,
  PlanningModelOutput,
  PlanningModelTokenUsage,
} from "../../planning/model.js";
import type { PlanningContext } from "../../planning/context.js";
import {
  GapAnalysisSchema,
  PlanProposalSchema,
  parsePlanProposal,
  type GapAnalysis,
  type PlanProposal,
} from "../../planning/proposal.js";
import { PlanningPromptAssembler } from "../../planning/prompt-assembler.js";
import { PlanningError } from "../../planning/errors.js";
import {
  DEFAULT_PLANNING_MAX_OUTPUT_TOKENS,
  type PlanningMaxOutputTokensByOperation,
} from "../../planning/token-reservation.js";
import type { PlanningModelOperation } from "../../planning/model.js";

export interface OpenAIPlanningModelOptions {
  apiKey: string | undefined;
  model: string;
  timeoutMs?: number;
  /** @deprecated Prefer maxOutputTokensByOperation for per-op bounds. */
  maxOutputTokens?: number;
  maxOutputTokensByOperation?: Partial<PlanningMaxOutputTokensByOperation>;
  client?: OpenAI;
}

function requireKey(apiKey: string | undefined): string {
  if (!apiKey || apiKey.trim() === "") {
    throw new PlanningError(
      "PLANNING_MODEL_UNAVAILABLE",
      "OPENAI_API_KEY is unavailable for live planning mode",
    );
  }
  return apiKey;
}

function usageFromResponse(usage: {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
} | null | undefined): PlanningModelTokenUsage | undefined {
  if (!usage) {
    return undefined;
  }
  const result: PlanningModelTokenUsage = {};
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
 * Optional OpenAI Responses API–backed PlanningModel.
 * No tools, web search, file search, code interpreter, MCP, function calling,
 * or conversation state (`previous_response_id`).
 * Domain code must not import this class.
 */
export class OpenAIPlanningModel implements PlanningModel {
  readonly provider = "openai";
  readonly toolsEnabled = false as const;
  readonly modelId: string;
  private readonly client: OpenAI;
  private readonly timeoutMs: number;
  private readonly maxOutputTokensByOperation: PlanningMaxOutputTokensByOperation;
  private readonly prompts = new PlanningPromptAssembler();

  constructor(options: OpenAIPlanningModelOptions) {
    const apiKey = requireKey(options.apiKey);
    this.modelId = options.model;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    const legacyDefault = options.maxOutputTokens;
    this.maxOutputTokensByOperation = {
      GAP_ANALYSIS:
        options.maxOutputTokensByOperation?.GAP_ANALYSIS ??
        legacyDefault ??
        DEFAULT_PLANNING_MAX_OUTPUT_TOKENS.GAP_ANALYSIS,
      PLAN_PROPOSAL:
        options.maxOutputTokensByOperation?.PLAN_PROPOSAL ??
        legacyDefault ??
        DEFAULT_PLANNING_MAX_OUTPUT_TOKENS.PLAN_PROPOSAL,
    };
    this.client =
      options.client ??
      new OpenAI({
        apiKey,
        timeout: this.timeoutMs,
        maxRetries: 1,
      });
  }

  static fromEnv(
    env: NodeJS.ProcessEnv = process.env,
  ): OpenAIPlanningModel {
    return new OpenAIPlanningModel({
      apiKey: env["OPENAI_API_KEY"],
      model: env["OPENAI_MODEL"] ?? "gpt-4.1-mini",
    });
  }

  async analyzeGaps(input: {
    context: PlanningContext;
    promptVersion: string;
  }): Promise<PlanningModelOutput<GapAnalysis>> {
    const assembled = this.prompts.assemble({
      context: input.context,
      mode: "gaps",
    });
    const { value, usage } = await this.structuredCall({
      assembled,
      schemaName: "gap_analysis",
      schema: GapAnalysisSchema,
      operation: "GAP_ANALYSIS",
    });
    const output: PlanningModelOutput<GapAnalysis> = {
      value: GapAnalysisSchema.parse(value),
    };
    if (usage) {
      output.usage = usage;
    }
    return output;
  }

  async proposePlan(input: {
    context: PlanningContext;
    gapAnalysis: GapAnalysis;
    promptVersion: string;
  }): Promise<PlanningModelOutput<PlanProposal>> {
    const assembled = this.prompts.assemble({
      context: input.context,
      gapAnalysis: input.gapAnalysis,
      mode: "plan",
    });
    const { value, usage } = await this.structuredCall({
      assembled,
      schemaName: "plan_proposal",
      schema: PlanProposalSchema,
      operation: "PLAN_PROPOSAL",
    });
    const output: PlanningModelOutput<PlanProposal> = {
      value: parsePlanProposal(value),
    };
    if (usage) {
      output.usage = usage;
    }
    return output;
  }

  private async structuredCall(input: {
    assembled: ReturnType<PlanningPromptAssembler["assemble"]>;
    schemaName: string;
    schema: ZodType;
    operation: PlanningModelOperation;
  }): Promise<{ value: unknown; usage?: PlanningModelTokenUsage }> {
    const userContent = [
      input.assembled.controlPlaneSection,
      input.assembled.objectiveSection,
      input.assembled.repositorySection,
      input.assembled.evidenceSection,
      input.assembled.taskSection,
    ].join("\n\n");

    const maxOutputTokens = this.maxOutputTokensByOperation[input.operation];

    try {
      const response = await this.client.responses.parse({
        model: this.modelId,
        temperature: 0,
        max_output_tokens: maxOutputTokens,
        input: [
          { role: "system", content: input.assembled.systemContract },
          { role: "user", content: userContent },
        ],
        text: {
          format: zodTextFormat(input.schema, input.schemaName),
        },
      });

      const usage = usageFromResponse(response.usage);

      if (response.status === "incomplete") {
        const reason = response.incomplete_details?.reason;
        if (reason === "content_filter") {
          throw new PlanningError(
            "PLANNING_MODEL_REFUSED",
            "OpenAI refused the planning request",
          );
        }
        throw new PlanningError(
          "PLANNING_MODEL_INVALID_OUTPUT",
          "OpenAI returned an incomplete planning response",
          { reason: reason ?? "unknown" },
        );
      }

      if (response.status === "failed" || response.error) {
        throw new PlanningError(
          "PLANNING_MODEL_UNAVAILABLE",
          "OpenAI planning response failed",
          {
            cause: response.error?.message ?? response.status ?? "failed",
          },
        );
      }

      for (const item of response.output) {
        if (item.type !== "message") {
          continue;
        }
        for (const part of item.content) {
          if (part.type === "refusal") {
            throw new PlanningError(
              "PLANNING_MODEL_REFUSED",
              "OpenAI refused the planning request",
              { refusal: part.refusal },
            );
          }
        }
      }

      if (response.output_parsed == null) {
        throw new PlanningError(
          "PLANNING_MODEL_INVALID_OUTPUT",
          "OpenAI returned empty or unparsable structured planning output",
        );
      }

      const result: { value: unknown; usage?: PlanningModelTokenUsage } = {
        value: response.output_parsed,
      };
      if (usage) {
        result.usage = usage;
      }
      return result;
    } catch (error) {
      if (error instanceof PlanningError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (/timeout|timed out|AbortError/i.test(message)) {
        throw new PlanningError(
          "PLANNING_MODEL_TIMEOUT",
          "OpenAI planning request timed out",
        );
      }
      if (
        /parse|schema|invalid|json|structured/i.test(message) &&
        !/ECONN|ENOTFOUND|fetch failed|network/i.test(message)
      ) {
        throw new PlanningError(
          "PLANNING_MODEL_INVALID_OUTPUT",
          "OpenAI returned malformed structured planning output",
          { cause: message },
        );
      }
      throw new PlanningError(
        "PLANNING_MODEL_UNAVAILABLE",
        "OpenAI planning request failed",
        { cause: message },
      );
    }
  }
}
