import { describe, expect, it } from "vitest";
import type OpenAI from "openai";
import {
  selectPlanningModel,
  PlanningModelSelectionError,
} from "./planning-model-selection.js";
import { OpenAIPlanningModel } from "./openai-planning-model.js";
import { FakePlanningModel } from "../../planning/fake-planning-model.js";
import { createExperimentAwarePlanningModel } from "../../experiments/planning-proposal.js";
import { createExecutionFriendlyPlanningModel } from "../../execution/friendly-planning-model.js";

function mockOpenAiClient(): OpenAI {
  return {
    responses: {
      parse: async () => {
        throw new Error("mock OpenAI client must not be called in selection tests");
      },
    },
  } as unknown as OpenAI;
}

describe("selectPlanningModel", () => {
  it("PRODUCTION + openai constructs OpenAIPlanningModel", () => {
    const selected = selectPlanningModel({
      runtimeEnvironment: "PRODUCTION",
      env: {
        ORCHESTRATOR_MODEL_PROVIDER: "openai",
        OPENAI_API_KEY: "sk-test-fixture",
        OPENAI_MODEL: "gpt-4.1-mini",
      },
      openaiClient: mockOpenAiClient(),
    });
    expect(selected.model).toBeInstanceOf(OpenAIPlanningModel);
    expect(selected.planningModelProvider).toBe("OPENAI");
    expect(selected.planningModelId).toBe("gpt-4.1-mini");
    expect(selected.planningModelConfigured).toBe(true);
    expect(selected.model.provider).toBe("openai");
    expect(selected.model).not.toBeInstanceOf(FakePlanningModel);
  });

  it("PRODUCTION without ORCHESTRATOR_MODEL_PROVIDER fails", () => {
    expect(() =>
      selectPlanningModel({
        runtimeEnvironment: "PRODUCTION",
        env: { OPENAI_API_KEY: "sk-test-fixture" },
      }),
    ).toThrow(PlanningModelSelectionError);
    expect(() =>
      selectPlanningModel({
        runtimeEnvironment: "PRODUCTION",
        env: { OPENAI_API_KEY: "sk-test-fixture" },
      }),
    ).toThrow(/ORCHESTRATOR_MODEL_PROVIDER/);
  });

  it("PRODUCTION with unsupported provider fails", () => {
    expect(() =>
      selectPlanningModel({
        runtimeEnvironment: "PRODUCTION",
        env: {
          ORCHESTRATOR_MODEL_PROVIDER: "anthropic",
          OPENAI_API_KEY: "sk-test-fixture",
        },
      }),
    ).toThrow(/unsupported|openai/i);
  });

  it("PRODUCTION cannot resolve to FakePlanningModel", () => {
    expect(() =>
      selectPlanningModel({
        runtimeEnvironment: "PRODUCTION",
        env: { ORCHESTRATOR_MODEL_PROVIDER: "fake" },
      }),
    ).toThrow(/FAKE PLANNING/);

    expect(() =>
      selectPlanningModel({
        runtimeEnvironment: "PRODUCTION",
        env: {
          ORCHESTRATOR_MODEL_PROVIDER: "openai",
          OPENAI_API_KEY: "sk-test-fixture",
        },
        planningModel: createExecutionFriendlyPlanningModel(),
        openaiClient: mockOpenAiClient(),
      }),
    ).toThrow(/FAKE PLANNING/);
  });

  it("PRODUCTION + openai without OPENAI_API_KEY fails", () => {
    expect(() =>
      selectPlanningModel({
        runtimeEnvironment: "PRODUCTION",
        env: { ORCHESTRATOR_MODEL_PROVIDER: "openai" },
      }),
    ).toThrow(/OPENAI_API_KEY/);
  });

  it("non-production defaults to Fake / ExecutionFriendly", () => {
    const selected = selectPlanningModel({
      runtimeEnvironment: "TEST",
      env: {},
    });
    expect(selected.planningModelProvider).toBe("FAKE");
    expect(selected.model.provider).toBe("fake");
    expect(selected.model).toBeInstanceOf(FakePlanningModel);
  });

  it("OpenAI model remains usable under experiment-aware wrapping", () => {
    const selected = selectPlanningModel({
      runtimeEnvironment: "PRODUCTION",
      env: {
        ORCHESTRATOR_MODEL_PROVIDER: "openai",
        OPENAI_API_KEY: "sk-test-fixture",
      },
      openaiClient: mockOpenAiClient(),
    });
    const wrapped = createExperimentAwarePlanningModel(selected.model, {
      lineage: {
        getByChildObjectiveFingerprint: async () => null,
      } as never,
      plans: { getById: async () => null } as never,
      experiments: { getById: async () => null } as never,
    });
    expect(wrapped.provider).toBe("openai");
    expect(wrapped.modelId).toBe(selected.planningModelId);
    expect(wrapped).not.toBeInstanceOf(FakePlanningModel);
  });

  it("OpenAI selection never falls back to Fake on construction failure", () => {
    expect(() =>
      selectPlanningModel({
        runtimeEnvironment: "PRODUCTION",
        env: {
          ORCHESTRATOR_MODEL_PROVIDER: "openai",
          OPENAI_API_KEY: "   ",
        },
      }),
    ).toThrow(/OPENAI_API_KEY/);
    // Re-select with valid key still yields OpenAI — never silent Fake.
    const selected = selectPlanningModel({
      runtimeEnvironment: "PRODUCTION",
      env: {
        ORCHESTRATOR_MODEL_PROVIDER: "openai",
        OPENAI_API_KEY: "sk-test-fixture",
      },
      openaiClient: mockOpenAiClient(),
    });
    expect(selected.model).toBeInstanceOf(OpenAIPlanningModel);
  });

  it("does not infer openai from API key alone", () => {
    const selected = selectPlanningModel({
      runtimeEnvironment: "TEST",
      env: { OPENAI_API_KEY: "sk-present-but-ignored" },
    });
    expect(selected.planningModelProvider).toBe("FAKE");
  });
});
