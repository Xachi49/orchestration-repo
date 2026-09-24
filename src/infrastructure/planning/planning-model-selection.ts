/**
 * Planning model selection.
 *
 * PRODUCTION != FAKE PLANNING
 * MODEL CONFIGURATION != MODEL SELECTION
 * MODEL FAILURE != PERMISSION TO SIMULATE
 *
 * Production requires explicit ORCHESTRATOR_MODEL_PROVIDER=openai and
 * OPENAI_API_KEY. Never infer provider from key presence. Never fall back
 * from OpenAI → Fake.
 */
import type OpenAI from "openai";
import type { PlanningModel } from "../../planning/model.js";
import { createExecutionFriendlyPlanningModel } from "../../execution/friendly-planning-model.js";
import { OpenAIPlanningModel } from "./openai-planning-model.js";

/** Non-secret provider labels exposed on /health/info. */
export const PLANNING_MODEL_PROVIDER_LABELS = ["OPENAI", "FAKE"] as const;
export type PlanningModelProviderLabel =
  (typeof PLANNING_MODEL_PROVIDER_LABELS)[number];

export class PlanningModelSelectionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PlanningModelSelectionError";
    this.code = code;
  }
}

export function isPlanningModelSelectionError(
  error: unknown,
): error is PlanningModelSelectionError {
  return error instanceof PlanningModelSelectionError;
}

export interface PlanningModelSelection {
  model: PlanningModel;
  /** Non-secret provider label. */
  planningModelProvider: PlanningModelProviderLabel;
  /** Non-secret model id (e.g. gpt-4.1-mini or fake-planning-v1). */
  planningModelId: string;
  planningModelConfigured: true;
}

export interface SelectPlanningModelInput {
  runtimeEnvironment: string;
  env?: NodeJS.ProcessEnv;
  /**
   * Explicit model override (tests). In PRODUCTION the override must not be
   * Fake / provider "fake".
   */
  planningModel?: PlanningModel;
  /** Test seam — injected OpenAI client (never used in live production). */
  openaiClient?: OpenAI;
}

function rawProviderFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env["ORCHESTRATOR_MODEL_PROVIDER"]?.trim();
  if (raw === undefined || raw === "") {
    return undefined;
  }
  return raw.toLowerCase();
}

/**
 * Resolve and construct the PlanningModel for a stack.
 * PRODUCTION fails closed on missing/invalid provider or Fake resolution.
 */
export function selectPlanningModel(
  input: SelectPlanningModelInput,
): PlanningModelSelection {
  const env = input.env ?? process.env;
  const isProduction = input.runtimeEnvironment === "PRODUCTION";

  if (input.planningModel !== undefined) {
    if (isProduction && input.planningModel.provider === "fake") {
      throw new PlanningModelSelectionError(
        "PRODUCTION_FAKE_PLANNING_FORBIDDEN",
        "PRODUCTION != FAKE PLANNING; injected FakePlanningModel is forbidden",
      );
    }
    return selectionFromModel(input.planningModel);
  }

  const raw = rawProviderFromEnv(env);

  if (isProduction) {
    if (raw === undefined) {
      throw new PlanningModelSelectionError(
        "PRODUCTION_MODEL_PROVIDER_REQUIRED",
        "PRODUCTION requires explicit ORCHESTRATOR_MODEL_PROVIDER=openai; MODEL CONFIGURATION != MODEL SELECTION",
      );
    }
    if (raw === "fake") {
      throw new PlanningModelSelectionError(
        "PRODUCTION_FAKE_PLANNING_FORBIDDEN",
        "PRODUCTION != FAKE PLANNING; ORCHESTRATOR_MODEL_PROVIDER=fake is forbidden",
      );
    }
    if (raw !== "openai") {
      throw new PlanningModelSelectionError(
        "PRODUCTION_MODEL_PROVIDER_UNSUPPORTED",
        `PRODUCTION supports only ORCHESTRATOR_MODEL_PROVIDER=openai, got ${raw}`,
      );
    }
    return constructOpenAi(env, input.openaiClient, true);
  }

  // Non-production: preserve deterministic Fake unless openai is explicitly requested.
  if (raw === "openai") {
    return constructOpenAi(env, input.openaiClient, false);
  }
  if (raw !== undefined && raw !== "fake") {
    throw new PlanningModelSelectionError(
      "MODEL_PROVIDER_UNSUPPORTED",
      `ORCHESTRATOR_MODEL_PROVIDER must be openai or fake (non-production), got ${raw}`,
    );
  }

  const fake = createExecutionFriendlyPlanningModel();
  return selectionFromModel(fake);
}

function constructOpenAi(
  env: NodeJS.ProcessEnv,
  client: OpenAI | undefined,
  forProduction: boolean,
): PlanningModelSelection {
  const apiKey = env["OPENAI_API_KEY"]?.trim();
  if (!apiKey) {
    throw new PlanningModelSelectionError(
      forProduction
        ? "PRODUCTION_OPENAI_API_KEY_REQUIRED"
        : "OPENAI_API_KEY_REQUIRED",
      "ORCHESTRATOR_MODEL_PROVIDER=openai requires OPENAI_API_KEY; never inferred from absent credentials; never fall back to Fake",
    );
  }
  const model = new OpenAIPlanningModel({
    apiKey,
    model: env["OPENAI_MODEL"]?.trim() || "gpt-4.1-mini",
    ...(client !== undefined ? { client } : {}),
  });
  return selectionFromModel(model);
}

function selectionFromModel(model: PlanningModel): PlanningModelSelection {
  const planningModelProvider: PlanningModelProviderLabel =
    model.provider === "openai"
      ? "OPENAI"
      : model.provider === "fake"
        ? "FAKE"
        : (() => {
            throw new PlanningModelSelectionError(
              "MODEL_PROVIDER_UNSUPPORTED",
              `Unsupported PlanningModel.provider: ${model.provider}`,
            );
          })();
  return {
    model,
    planningModelProvider,
    planningModelId: model.modelId,
    planningModelConfigured: true,
  };
}
