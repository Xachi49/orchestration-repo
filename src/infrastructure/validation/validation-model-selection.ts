/**
 * Validation model selection.
 *
 * PRODUCTION != FAKE VALIDATION
 * MODEL FAILURE != PERMISSION TO SIMULATE
 * VALIDATION CONFIGURATION != VALIDATION AUTHORITY
 * PASS != APPROVED
 *
 * Production requires explicit ORCHESTRATOR_MODEL_PROVIDER=openai and
 * OPENAI_API_KEY. Never infer provider from key presence. Never fall back
 * from OpenAI → Fake.
 */
import type OpenAI from "openai";
import type { ValidationModel } from "../../validation/model.js";
import { FakeValidationModel } from "../../validation/fake-validation-model.js";
import { OpenAIValidationModel } from "./openai-validation-model.js";

/** Non-secret provider labels exposed on /health/info. */
export const VALIDATION_MODEL_PROVIDER_LABELS = ["OPENAI", "FAKE"] as const;
export type ValidationModelProviderLabel =
  (typeof VALIDATION_MODEL_PROVIDER_LABELS)[number];

export class ValidationModelSelectionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ValidationModelSelectionError";
    this.code = code;
  }
}

export function isValidationModelSelectionError(
  error: unknown,
): error is ValidationModelSelectionError {
  return error instanceof ValidationModelSelectionError;
}

export interface ValidationModelSelection {
  model: ValidationModel;
  validationModelProvider: ValidationModelProviderLabel;
  validationModelId: string;
  validationModelConfigured: true;
}

export interface SelectValidationModelInput {
  runtimeEnvironment: string;
  env?: NodeJS.ProcessEnv;
  /**
   * Explicit model override (tests). In PRODUCTION the override must not be
   * Fake / provider "fake".
   */
  validationModel?: ValidationModel;
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
 * Resolve and construct the ValidationModel for a stack.
 * PRODUCTION fails closed on missing/invalid provider or Fake resolution.
 */
export function selectValidationModel(
  input: SelectValidationModelInput,
): ValidationModelSelection {
  const env = input.env ?? process.env;
  const isProduction = input.runtimeEnvironment === "PRODUCTION";

  if (input.validationModel !== undefined) {
    if (isProduction && input.validationModel.provider === "fake") {
      throw new ValidationModelSelectionError(
        "PRODUCTION_FAKE_VALIDATION_FORBIDDEN",
        "PRODUCTION != FAKE VALIDATION; injected FakeValidationModel is forbidden",
      );
    }
    return selectionFromModel(input.validationModel);
  }

  const raw = rawProviderFromEnv(env);

  if (isProduction) {
    if (raw === undefined) {
      throw new ValidationModelSelectionError(
        "PRODUCTION_MODEL_PROVIDER_REQUIRED",
        "PRODUCTION requires explicit ORCHESTRATOR_MODEL_PROVIDER=openai; VALIDATION CONFIGURATION != VALIDATION AUTHORITY",
      );
    }
    if (raw === "fake") {
      throw new ValidationModelSelectionError(
        "PRODUCTION_FAKE_VALIDATION_FORBIDDEN",
        "PRODUCTION != FAKE VALIDATION; ORCHESTRATOR_MODEL_PROVIDER=fake is forbidden",
      );
    }
    if (raw !== "openai") {
      throw new ValidationModelSelectionError(
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
    throw new ValidationModelSelectionError(
      "MODEL_PROVIDER_UNSUPPORTED",
      `ORCHESTRATOR_MODEL_PROVIDER must be openai or fake (non-production), got ${raw}`,
    );
  }

  return selectionFromModel(new FakeValidationModel());
}

function constructOpenAi(
  env: NodeJS.ProcessEnv,
  client: OpenAI | undefined,
  forProduction: boolean,
): ValidationModelSelection {
  const apiKey = env["OPENAI_API_KEY"]?.trim();
  if (!apiKey) {
    throw new ValidationModelSelectionError(
      forProduction
        ? "PRODUCTION_OPENAI_API_KEY_REQUIRED"
        : "OPENAI_API_KEY_REQUIRED",
      "ORCHESTRATOR_MODEL_PROVIDER=openai requires OPENAI_API_KEY for validation; never inferred from absent credentials; never fall back to Fake",
    );
  }
  const modelId =
    env["OPENAI_VALIDATION_MODEL"]?.trim() ||
    env["OPENAI_MODEL"]?.trim() ||
    "gpt-4.1-mini";
  const model = new OpenAIValidationModel({
    apiKey,
    model: modelId,
    ...(client !== undefined ? { client } : {}),
  });
  return selectionFromModel(model);
}

function selectionFromModel(model: ValidationModel): ValidationModelSelection {
  const validationModelProvider: ValidationModelProviderLabel =
    model.provider === "openai"
      ? "OPENAI"
      : model.provider === "fake"
        ? "FAKE"
        : (() => {
            throw new ValidationModelSelectionError(
              "MODEL_PROVIDER_UNSUPPORTED",
              `Unsupported ValidationModel.provider: ${model.provider}`,
            );
          })();
  return {
    model,
    validationModelProvider,
    validationModelId: model.modelId,
    validationModelConfigured: true,
  };
}
