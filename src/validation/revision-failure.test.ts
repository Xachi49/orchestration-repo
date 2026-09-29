import { describe, expect, it } from "vitest";
import { z } from "zod";
import { exampleAdmissionRequest } from "../admission/fixtures.js";
import {
  EXAMPLE_ENVIRONMENT,
  EXAMPLE_PROJECT_ID,
} from "../control-plane/fixtures.js";
import { createLocalValidationStack } from "../infrastructure/validation/local-stack.js";
import { PlanningError } from "../planning/errors.js";
import type { PlanProposal } from "../planning/proposal.js";
import {
  RecoveryTargetBinderError,
  type RevenueRecoveryTargetBinder,
} from "../revenue-recovery/target-binder.js";
import { ValidationError } from "./errors.js";
import { FakeValidationModel } from "./fake-validation-model.js";
import type { ValidationModelOutput } from "./model.js";
import {
  PlanningModelRevisionAdapter,
  type PlanRevisionModel,
  type PlanRevisionModelInput,
} from "./revision-model.js";
import {
  classifyRevisionCompilationFailure,
  revisionFailureFindingMetadata,
} from "./revision-failure-cause.js";

const CUSTOMER_EMAIL = "alex@example.com";

describe("classifyRevisionCompilationFailure", () => {
  it("distinguishes capability denial", () => {
    expect(
      classifyRevisionCompilationFailure(
        new PlanningError(
          "INVALID_CAPABILITY_REFERENCE",
          "Unknown action type: SEND_RECOVERY_SMS",
        ),
      ),
    ).toEqual({
      causeClass: "CAPABILITY_REFERENCE",
      causeCode: "INVALID_CAPABILITY_REFERENCE",
      planningCode: "INVALID_CAPABILITY_REFERENCE",
    });
  });

  it("distinguishes target binder failure (raw or wrapped)", () => {
    const raw = new RecoveryTargetBinderError(
      "MODEL_TARGET_CONFLICT",
      `conflict for ${CUSTOMER_EMAIL}`,
      { email: CUSTOMER_EMAIL },
    );
    expect(classifyRevisionCompilationFailure(raw)).toEqual({
      causeClass: "RECOVERY_TARGET_BINDING",
      causeCode: "MODEL_TARGET_CONFLICT",
      binderCode: "MODEL_TARGET_CONFLICT",
    });
    const wrapped = new ValidationError(
      "REVISION_COMPILATION_FAILED",
      "Recovery target binding failed: RECOVERY_TEMPLATE_UNRESOLVED",
      { runId: "run_1", binderCode: "RECOVERY_TEMPLATE_UNRESOLVED" },
    );
    expect(classifyRevisionCompilationFailure(wrapped)).toMatchObject({
      causeClass: "RECOVERY_TARGET_BINDING",
      causeCode: "RECOVERY_TEMPLATE_UNRESOLVED",
    });
  });

  it("distinguishes schema failure with structural paths only", () => {
    const parsed = z
      .object({ steps: z.array(z.object({ actionType: z.string() })) })
      .safeParse({ steps: [{ actionType: 7 }], [CUSTOMER_EMAIL]: true });
    if (parsed.success) {
      throw new Error("expected schema failure");
    }
    const cause = classifyRevisionCompilationFailure(parsed.error);
    expect(cause.causeClass).toBe("PLAN_SCHEMA");
    expect(cause.causeCode).toBe("PLAN_SCHEMA_INVALID");
    expect(cause.schemaIssues).toEqual([
      { path: "steps.0.actionType", code: "invalid_type" },
    ]);
  });

  it("distinguishes infrastructure failure without keeping the message", () => {
    const error = Object.assign(
      new Error(`connection to postgres://svc:hunter2@db failed for ${CUSTOMER_EMAIL}`),
      { code: "ECONNRESET" },
    );
    const cause = classifyRevisionCompilationFailure(error);
    expect(cause).toEqual({
      causeClass: "INFRASTRUCTURE",
      causeCode: "ECONNRESET",
    });
    expect(JSON.stringify(cause)).not.toContain("hunter2");
  });
});

describe("revisionFailureFindingMetadata", () => {
  it("drops free-text causes, stack traces, and tenant data", () => {
    const failure = new ValidationError(
      "REVISION_PERSISTENCE_FAILED",
      "Failed to persist the revised plan",
      {
        cause: `Error: duplicate key for ${CUSTOMER_EMAIL}\n    at save (/app/dist/x.js:1:1)`,
        runId: "run_9a969030-6533-4aa3-af5f-a123c5a66508",
        prompt: "SYSTEM: you are a planner",
        ruleIds: ["PLAN_COVERAGE_GAP", `bad ${CUSTOMER_EMAIL}`],
      },
    );
    const metadata = revisionFailureFindingMetadata(failure);
    expect(metadata).toEqual({
      code: "REVISION_PERSISTENCE_FAILED",
      causeClass: "REVISION_PROCESS",
      causeCode: "REVISION_PERSISTENCE_FAILED",
      details: { runId: "run_9a969030-6533-4aa3-af5f-a123c5a66508" },
    });
    const serialized = JSON.stringify(metadata);
    expect(serialized).not.toContain(CUSTOMER_EMAIL);
    expect(serialized).not.toContain(" at ");
    expect(serialized).not.toContain("SYSTEM");
  });
});

/** Wraps the stack's reviser and rewrites its proposal before compilation. */
class RewritingRevisionModel implements PlanRevisionModel {
  readonly provider = "fake";
  readonly modelId = "rewriting-reviser";
  readonly toolsEnabled = false as const;
  inner: PlanRevisionModel | null = null;

  constructor(private readonly rewrite: (proposal: PlanProposal) => PlanProposal) {}

  async revisePlan(
    input: PlanRevisionModelInput,
  ): Promise<ValidationModelOutput<PlanProposal>> {
    if (!this.inner) {
      throw new Error("inner reviser not attached");
    }
    const output = await this.inner.revisePlan(input);
    return { ...output, value: this.rewrite(output.value) };
  }
}

function withFirstAction(actionType: string) {
  return (proposal: PlanProposal): PlanProposal => ({
    ...proposal,
    steps: proposal.steps.map((step, index) =>
      index === 0 ? { ...step, actionType } : step,
    ),
  });
}

async function revisingRun(reviser: RewritingRevisionModel) {
  const model = new FakeValidationModel();
  model.setReviseRecommendation({
    ruleId: "PLAN_COVERAGE_GAP",
    affectedStepIds: ["step_patch"],
  });
  const stack = createLocalValidationStack({
    validationModel: model,
    revisionModel: reviser,
  });
  reviser.inner = new PlanningModelRevisionAdapter(stack.planningModel);
  const admitted = await stack.admission.admit(exampleAdmissionRequest());
  if (admitted.outcome !== "ADMITTED") {
    throw new Error("expected ADMITTED");
  }
  const runId = admitted.runId;
  await stack.ingestion.ingest(runId, EXAMPLE_PROJECT_ID, EXAMPLE_ENVIRONMENT);
  await stack.planning.plan(runId);
  return { stack, runId };
}

describe("ValidationService — revision failure", () => {
  it("capability denial: BLOCK with persisted sanitized cause", async () => {
    const { stack, runId } = await revisingRun(
      new RewritingRevisionModel(withFirstAction("SEND_RECOVERY_FAX")),
    );
    const result = await stack.validation.validate(runId);

    expect(result.decision).toBe("BLOCK");
    expect(result.reasonCodes).toEqual([
      "REVISION_FAILED",
      "NON_APPROVAL_ELIGIBLE_BLOCKING_FINDING",
    ]);
    expect(result.exception).toMatchObject({
      exceptionType: "REVISION_FAILED",
      decisionClass: "BLOCK",
    });

    const persisted = await stack.validation.getLatestDecision(runId);
    expect(persisted?.decision).toBe("BLOCK");
    const failure = persisted?.findings.find(
      (finding) => finding.ruleId === "REVISION_FAILED",
    );
    expect(failure?.approvalEligible).toBe(true);
    expect(failure?.metadata).toMatchObject({
      code: "REVISION_COMPILATION_FAILED",
      causeClass: "CAPABILITY_REFERENCE",
      causeCode: "INVALID_CAPABILITY_REFERENCE",
      planningCode: "INVALID_CAPABILITY_REFERENCE",
    });
    expect(
      persisted?.findings.some(
        (finding) =>
          finding.ruleId === "PLAN_COVERAGE_GAP" &&
          finding.blocking &&
          !finding.approvalEligible,
      ),
    ).toBe(true);
  });

  it("target binder failure: cause code survives, binder detail text does not", async () => {
    const { stack, runId } = await revisingRun(
      new RewritingRevisionModel(withFirstAction("SEND_RECOVERY_EMAIL")),
    );
    stack.validation.bindRecoveryTargetBinder({
      bindProposalSteps: async () => {
        throw new RecoveryTargetBinderError(
          "MODEL_TARGET_CONFLICT",
          `Model target conflicts with canonical lead <${CUSTOMER_EMAIL}>`,
          { email: CUSTOMER_EMAIL, leadId: "lead_secret" },
        );
      },
    } as unknown as RevenueRecoveryTargetBinder);

    const result = await stack.validation.validate(runId);
    expect(result.decision).toBe("BLOCK");
    const failure = result.findings.find(
      (finding) => finding.ruleId === "REVISION_FAILED",
    );
    expect(failure?.metadata).toMatchObject({
      code: "REVISION_COMPILATION_FAILED",
      causeClass: "RECOVERY_TARGET_BINDING",
      causeCode: "MODEL_TARGET_CONFLICT",
      binderCode: "MODEL_TARGET_CONFLICT",
    });
    expect(failure?.message).toBe(
      "Revised plan failed recovery target binding: MODEL_TARGET_CONFLICT",
    );
    const serialized = JSON.stringify(result.findings);
    expect(serialized).not.toContain(CUSTOMER_EMAIL);
    expect(serialized).not.toContain("lead_secret");
  });
});
