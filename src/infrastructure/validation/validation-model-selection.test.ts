import { describe, expect, it } from "vitest";
import type OpenAI from "openai";
import {
  selectValidationModel,
  ValidationModelSelectionError,
} from "./validation-model-selection.js";
import { OpenAIValidationModel } from "./openai-validation-model.js";
import { FakeValidationModel } from "../../validation/fake-validation-model.js";
import { selectPlanningModel } from "../planning/planning-model-selection.js";
import { PlanningModelRevisionAdapter } from "../../validation/revision-model.js";

function mockOpenAiClient(): OpenAI {
  return {
    responses: {
      parse: async () => {
        throw new Error(
          "mock OpenAI client must not be called in selection tests",
        );
      },
    },
  } as unknown as OpenAI;
}

describe("selectValidationModel", () => {
  it("PRODUCTION + openai constructs OpenAIValidationModel", () => {
    const selected = selectValidationModel({
      runtimeEnvironment: "PRODUCTION",
      env: {
        ORCHESTRATOR_MODEL_PROVIDER: "openai",
        OPENAI_API_KEY: "sk-test-fixture",
      },
      openaiClient: mockOpenAiClient(),
    });
    expect(selected.model).toBeInstanceOf(OpenAIValidationModel);
    expect(selected.validationModelProvider).toBe("OPENAI");
    expect(selected.validationModelId).toBe("gpt-4.1-mini");
    expect(selected.validationModelConfigured).toBe(true);
    expect(selected.model.provider).toBe("openai");
    expect(selected.model).not.toBeInstanceOf(FakeValidationModel);
  });

  it("honors OPENAI_VALIDATION_MODEL over OPENAI_MODEL", () => {
    const selected = selectValidationModel({
      runtimeEnvironment: "PRODUCTION",
      env: {
        ORCHESTRATOR_MODEL_PROVIDER: "openai",
        OPENAI_API_KEY: "sk-test-fixture",
        OPENAI_MODEL: "gpt-4.1",
        OPENAI_VALIDATION_MODEL: "gpt-4.1-mini",
      },
      openaiClient: mockOpenAiClient(),
    });
    expect(selected.validationModelId).toBe("gpt-4.1-mini");
  });

  it("PRODUCTION without provider fails", () => {
    expect(() =>
      selectValidationModel({
        runtimeEnvironment: "PRODUCTION",
        env: { OPENAI_API_KEY: "sk-test-fixture" },
      }),
    ).toThrow(/ORCHESTRATOR_MODEL_PROVIDER/);
  });

  it("PRODUCTION with unsupported provider fails", () => {
    expect(() =>
      selectValidationModel({
        runtimeEnvironment: "PRODUCTION",
        env: {
          ORCHESTRATOR_MODEL_PROVIDER: "anthropic",
          OPENAI_API_KEY: "sk-test-fixture",
        },
      }),
    ).toThrow(/unsupported|openai/i);
  });

  it("PRODUCTION cannot resolve to FakeValidationModel", () => {
    expect(() =>
      selectValidationModel({
        runtimeEnvironment: "PRODUCTION",
        env: { ORCHESTRATOR_MODEL_PROVIDER: "fake" },
      }),
    ).toThrow(/FAKE VALIDATION/);

    expect(() =>
      selectValidationModel({
        runtimeEnvironment: "PRODUCTION",
        env: {
          ORCHESTRATOR_MODEL_PROVIDER: "openai",
          OPENAI_API_KEY: "sk-test-fixture",
        },
        validationModel: new FakeValidationModel(),
        openaiClient: mockOpenAiClient(),
      }),
    ).toThrow(/FAKE VALIDATION/);
  });

  it("PRODUCTION + openai without OPENAI_API_KEY fails", () => {
    expect(() =>
      selectValidationModel({
        runtimeEnvironment: "PRODUCTION",
        env: { ORCHESTRATOR_MODEL_PROVIDER: "openai" },
      }),
    ).toThrow(/OPENAI_API_KEY/);
  });

  it("non-production defaults to FakeValidationModel", () => {
    const selected = selectValidationModel({
      runtimeEnvironment: "TEST",
      env: {},
    });
    expect(selected.validationModelProvider).toBe("FAKE");
    expect(selected.model).toBeInstanceOf(FakeValidationModel);
  });

  it("does not infer openai from API key alone", () => {
    const selected = selectValidationModel({
      runtimeEnvironment: "TEST",
      env: { OPENAI_API_KEY: "sk-present-but-ignored" },
    });
    expect(selected.validationModelProvider).toBe("FAKE");
  });

  it("OpenAI selection never falls back to Fake on construction failure", () => {
    expect(() =>
      selectValidationModel({
        runtimeEnvironment: "PRODUCTION",
        env: {
          ORCHESTRATOR_MODEL_PROVIDER: "openai",
          OPENAI_API_KEY: "   ",
        },
      }),
    ).toThrow(/OPENAI_API_KEY/);
    const selected = selectValidationModel({
      runtimeEnvironment: "PRODUCTION",
      env: {
        ORCHESTRATOR_MODEL_PROVIDER: "openai",
        OPENAI_API_KEY: "sk-test-fixture",
      },
      openaiClient: mockOpenAiClient(),
    });
    expect(selected.model).toBeInstanceOf(OpenAIValidationModel);
  });

  it("revision adapter remains based on selected PlanningModel", () => {
    const env = {
      ORCHESTRATOR_MODEL_PROVIDER: "openai",
      OPENAI_API_KEY: "sk-test-fixture",
    };
    const client = mockOpenAiClient();
    const planning = selectPlanningModel({
      runtimeEnvironment: "PRODUCTION",
      env,
      openaiClient: client,
    });
    const validation = selectValidationModel({
      runtimeEnvironment: "PRODUCTION",
      env,
      openaiClient: client,
    });
    const revision = new PlanningModelRevisionAdapter(planning.model);
    expect(revision.provider).toBe("openai");
    expect(revision.modelId).toBe(planning.planningModelId);
    expect(validation.model).toBeInstanceOf(OpenAIValidationModel);
    expect(validation.model.provider).toBe("openai");
  });
});

describe("OpenAIValidationModel structured contract", () => {
  it("retains Responses parse + structured schema wiring", () => {
    const model = new OpenAIValidationModel({
      apiKey: "sk-test-fixture",
      model: "gpt-4.1-mini",
      client: mockOpenAiClient(),
    });
    expect(model.provider).toBe("openai");
    expect(model.toolsEnabled).toBe(false);
    expect(model.modelId).toBe("gpt-4.1-mini");
  });
});
