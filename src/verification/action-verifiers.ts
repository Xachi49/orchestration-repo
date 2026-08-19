import type { ExecutionPlan } from "../domain/plan/execution-plan.js";
import type {
  ExecutionArtifact,
  StepExecutionResult,
} from "../domain/execution/index.js";
import type { ExecutionArtifactRepository } from "../execution/artifact-repository.js";
import { TestProfileRegistry } from "../execution/test-profiles.js";
import { ExecutionTargetValidator } from "../execution/target-validator.js";
import type { VerificationFinding } from "../domain/verification/index.js";
import type { CriterionVerdict } from "../domain/verification/index.js";
import type { VerificationIdentityGenerator } from "./identity.js";
import {
  readVerificationArtifactBytes,
  utf8FromVerificationBytes,
} from "./artifact-verifier.js";
import type { ArtifactBlobStore } from "../durability/artifacts.js";

export interface ActionOutcomeContext {
  runId: string;
  executionAttemptId: string;
  plan: ExecutionPlan;
  step: StepExecutionResult;
  dataRoot: string;
  artifacts: ExecutionArtifactRepository;
  recomputedHashes: ReadonlyMap<string, string>;
  workspaceRoot: string;
  blobStore?: ArtifactBlobStore;
}

export interface ActionOutcomeVerification {
  actionType: string;
  stepId: string;
  passed: boolean;
  postconditionVerdict: CriterionVerdict;
  findings: VerificationFinding[];
  observedSummary: string;
  evidenceHints: readonly string[];
}

export interface ActionOutcomeVerifier {
  readonly actionType: string;
  verify(ctx: ActionOutcomeContext): Promise<ActionOutcomeVerification>;
}

/**
 * Deterministic per-action outcome verifiers for Phase 7 action types.
 * No generic model-based action verifier.
 */
export class ActionOutcomeVerifierRegistry {
  private readonly byType = new Map<string, ActionOutcomeVerifier>();

  constructor(
    private readonly identities: VerificationIdentityGenerator,
    private readonly testProfiles = new TestProfileRegistry(),
    private readonly targets = new ExecutionTargetValidator(),
  ) {
    this.register(new CreateLocalPatchVerifier(identities, targets));
    this.register(new RunTestsVerifier(identities, testProfiles));
    this.register(new CreateTaskVerifier(identities));
    this.register(new PreparePullRequestVerifier(identities));
  }

  register(verifier: ActionOutcomeVerifier): void {
    this.byType.set(verifier.actionType, verifier);
  }

  get(actionType: string): ActionOutcomeVerifier | undefined {
    return this.byType.get(actionType);
  }

  async verifyAll(
    ctx: Omit<ActionOutcomeContext, "step"> & {
      steps: readonly StepExecutionResult[];
    },
  ): Promise<ActionOutcomeVerification[]> {
    const results: ActionOutcomeVerification[] = [];
    for (const step of ctx.steps) {
      const verifier = this.byType.get(step.actionType);
      if (!verifier) {
        results.push({
          actionType: step.actionType,
          stepId: step.stepId,
          passed: false,
          postconditionVerdict: "INCONCLUSIVE",
          findings: [
            {
              findingId: this.identities.nextFindingId(),
              category: "EXECUTION_INTEGRITY",
              severity: "ERROR",
              ruleId: "UNSUPPORTED_ACTION_VERIFIER",
              message: `No action outcome verifier for ${step.actionType}`,
              criterionIds: [],
              stepIds: [step.stepId],
              evidenceRefs: [],
              blocksVerifiedSuccess: true,
              metadata: {},
            },
          ],
          observedSummary: `No verifier for ${step.actionType}`,
          evidenceHints: [],
        });
        continue;
      }
      results.push(
        await verifier.verify({
          runId: ctx.runId,
          executionAttemptId: ctx.executionAttemptId,
          plan: ctx.plan,
          step,
          dataRoot: ctx.dataRoot,
          artifacts: ctx.artifacts,
          recomputedHashes: ctx.recomputedHashes,
          workspaceRoot: ctx.workspaceRoot,
          ...(ctx.blobStore !== undefined ? { blobStore: ctx.blobStore } : {}),
        }),
      );
    }
    return results;
  }
}

class CreateLocalPatchVerifier implements ActionOutcomeVerifier {
  readonly actionType = "CREATE_LOCAL_PATCH";

  constructor(
    private readonly identities: VerificationIdentityGenerator,
    private readonly targets: ExecutionTargetValidator,
  ) {}

  async verify(ctx: ActionOutcomeContext): Promise<ActionOutcomeVerification> {
    const findings: VerificationFinding[] = [];
    const planStep = ctx.plan.steps.find((s) => s.stepId === ctx.step.stepId);
    const artifacts = await this.loadArtifacts(ctx);

    if (artifacts.length === 0) {
      findings.push(finding(this.identities, {
        ruleId: "VERIFICATION_ARTIFACT_MISSING",
        message: "CREATE_LOCAL_PATCH expected patch artifact missing",
        category: "ARTIFACT_INTEGRITY",
        stepIds: [ctx.step.stepId],
      }));
      return fail(ctx, findings, "Patch artifact missing");
    }

    for (const artifact of artifacts) {
      if (artifact.artifactType !== "PATCH") {
        findings.push(finding(this.identities, {
          ruleId: "VERIFICATION_ARTIFACT_IDENTITY_MISMATCH",
          message: `Expected PATCH artifact, got ${artifact.artifactType}`,
          category: "ARTIFACT_INTEGRITY",
          stepIds: [ctx.step.stepId],
        }));
      }
      const recomputed = ctx.recomputedHashes.get(artifact.artifactId);
      if (recomputed && recomputed !== artifact.contentHash) {
        findings.push(finding(this.identities, {
          ruleId: "VERIFICATION_ARTIFACT_HASH_MISMATCH",
          message: "Patch artifact hash failed recomputation",
          category: "ARTIFACT_INTEGRITY",
          stepIds: [ctx.step.stepId],
        }));
      }

      const body = await this.readArtifact(ctx, artifact);
      if (body === null || !body.includes("# Phase 7 local patch artifact")) {
        findings.push(finding(this.identities, {
          ruleId: "VERIFICATION_POSTCONDITION_FAILED",
          message: "Patch artifact is not syntactically interpretable",
          category: "POSTCONDITION",
          stepIds: [ctx.step.stepId],
        }));
      }

      for (const target of ctx.step.affectedTargets) {
        try {
          this.targets.assertNotProtected(target);
        } catch {
          findings.push(finding(this.identities, {
            ruleId: "VERIFICATION_SCOPE_VIOLATION",
            message: `Protected path unexpectedly affected: ${target}`,
            category: "BOUNDARY",
            stepIds: [ctx.step.stepId],
            metadata: { target },
          }));
        }
        if (planStep && !planStep.targetIds.includes(target)) {
          // affected may be normalized; still require containment under plan targets or listed
          const allowed = planStep.targetIds.some(
            (t) => target === t || target.startsWith(`${t}/`) || t.startsWith(`${target}/`),
          );
          if (!allowed) {
            findings.push(finding(this.identities, {
              ruleId: "VERIFICATION_SCOPE_VIOLATION",
              message: `Affected path outside authorized targets: ${target}`,
              category: "BOUNDARY",
              stepIds: [ctx.step.stepId],
              metadata: { target },
            }));
          }
        }
      }
    }

    const passed = findings.length === 0 && ctx.step.status === "SUCCEEDED";
    return {
      actionType: this.actionType,
      stepId: ctx.step.stepId,
      passed,
      postconditionVerdict: passed
        ? "SATISFIED"
        : findings.length > 0
          ? "UNSATISFIED"
          : "INCONCLUSIVE",
      findings,
      observedSummary: passed
        ? "Local patch artifact prepared and intact"
        : "Local patch verification failed",
      evidenceHints: artifacts.map((a) => a.artifactId),
    };
  }

  private async loadArtifacts(
    ctx: ActionOutcomeContext,
  ): Promise<ExecutionArtifact[]> {
    const out: ExecutionArtifact[] = [];
    for (const id of ctx.step.outputArtifactRefs) {
      const a = await ctx.artifacts.getById(id);
      if (a) out.push(a);
    }
    return out;
  }

  private async readArtifact(
    ctx: ActionOutcomeContext,
    artifact: ExecutionArtifact,
  ): Promise<string | null> {
    return readActionArtifactText(ctx, artifact);
  }
}

class RunTestsVerifier implements ActionOutcomeVerifier {
  readonly actionType = "RUN_TESTS";

  constructor(
    private readonly identities: VerificationIdentityGenerator,
    private readonly testProfiles: TestProfileRegistry,
  ) {}

  async verify(ctx: ActionOutcomeContext): Promise<ActionOutcomeVerification> {
    const findings: VerificationFinding[] = [];
    const artifacts: ExecutionArtifact[] = [];
    for (const id of ctx.step.outputArtifactRefs) {
      const a = await ctx.artifacts.getById(id);
      if (a) artifacts.push(a);
    }

    if (artifacts.length === 0) {
      findings.push(finding(this.identities, {
        ruleId: "VERIFICATION_ARTIFACT_MISSING",
        message: "RUN_TESTS result artifact missing",
        category: "ARTIFACT_INTEGRITY",
        stepIds: [ctx.step.stepId],
      }));
      return fail(ctx, findings, "Test result artifact missing");
    }

    let exitCode: number | undefined;
    let testProfileId: string | undefined;
    for (const artifact of artifacts) {
      if (artifact.artifactType !== "TEST_RESULT") {
        findings.push(finding(this.identities, {
          ruleId: "VERIFICATION_ARTIFACT_IDENTITY_MISMATCH",
          message: `Expected TEST_RESULT, got ${artifact.artifactType}`,
          category: "ARTIFACT_INTEGRITY",
          stepIds: [ctx.step.stepId],
        }));
        continue;
      }
      try {
        const bodyText = await readActionArtifactText(ctx, artifact);
        if (bodyText === null) {
          throw new Error("missing artifact body");
        }
        const body = JSON.parse(bodyText) as {
          testProfileId?: string;
          exitCode?: number;
          shell?: boolean;
        };
        testProfileId = body.testProfileId;
        exitCode = body.exitCode;
        if (body.shell === true) {
          findings.push(finding(this.identities, {
            ruleId: "VERIFICATION_GOVERNANCE_VIOLATION",
            message: "Test result claimed shell:true",
            category: "GOVERNANCE",
            stepIds: [ctx.step.stepId],
          }));
        }
        if (testProfileId) {
          try {
            this.testProfiles.require(testProfileId);
          } catch {
            findings.push(finding(this.identities, {
              ruleId: "VERIFICATION_POSTCONDITION_FAILED",
              message: `Unregistered test profile: ${testProfileId}`,
              category: "POSTCONDITION",
              stepIds: [ctx.step.stepId],
            }));
          }
        }
      } catch {
        findings.push(finding(this.identities, {
          ruleId: "VERIFICATION_ARTIFACT_MISSING",
          message: "Could not read test result artifact",
          category: "ARTIFACT_INTEGRITY",
          stepIds: [ctx.step.stepId],
        }));
      }
    }

    if (exitCode !== undefined && exitCode !== 0) {
      findings.push(finding(this.identities, {
        ruleId: "VERIFICATION_POSTCONDITION_FAILED",
        message: `Registered test profile exited non-zero: ${exitCode}`,
        category: "POSTCONDITION",
        stepIds: [ctx.step.stepId],
        metadata: { exitCode, testProfileId },
      }));
    }

    const passed =
      findings.length === 0 &&
      ctx.step.status === "SUCCEEDED" &&
      exitCode === 0;
    return {
      actionType: this.actionType,
      stepId: ctx.step.stepId,
      passed,
      postconditionVerdict: passed
        ? "SATISFIED"
        : exitCode !== undefined && exitCode !== 0
          ? "UNSATISFIED"
          : findings.length > 0
            ? "UNSATISFIED"
            : "INCONCLUSIVE",
      findings,
      observedSummary: passed
        ? "Registered test profile executed successfully"
        : `Test verification failed (exitCode=${String(exitCode)})`,
      evidenceHints: artifacts.map((a) => a.artifactId),
    };
  }
}

class CreateTaskVerifier implements ActionOutcomeVerifier {
  readonly actionType = "CREATE_TASK";

  constructor(private readonly identities: VerificationIdentityGenerator) {}

  async verify(ctx: ActionOutcomeContext): Promise<ActionOutcomeVerification> {
    const findings: VerificationFinding[] = [];
    const artifacts: ExecutionArtifact[] = [];
    for (const id of ctx.step.outputArtifactRefs) {
      const a = await ctx.artifacts.getById(id);
      if (a) artifacts.push(a);
    }

    if (artifacts.length === 0) {
      findings.push(finding(this.identities, {
        ruleId: "VERIFICATION_ARTIFACT_MISSING",
        message: "CREATE_TASK record missing",
        category: "ARTIFACT_INTEGRITY",
        stepIds: [ctx.step.stepId],
      }));
      return fail(ctx, findings, "Task record missing");
    }

    const seenTaskIds = new Set<string>();
    for (const artifact of artifacts) {
      if (artifact.artifactType !== "TASK") {
        findings.push(finding(this.identities, {
          ruleId: "VERIFICATION_ARTIFACT_IDENTITY_MISMATCH",
          message: `Expected TASK artifact, got ${artifact.artifactType}`,
          category: "ARTIFACT_INTEGRITY",
          stepIds: [ctx.step.stepId],
        }));
        continue;
      }
      try {
        const bodyText = await readActionArtifactText(ctx, artifact);
        if (bodyText === null) {
          throw new Error("missing artifact body");
        }
        const body = JSON.parse(bodyText) as {
          taskId?: string;
          sourcePlanId?: string;
          sourceStepId?: string;
          title?: string;
        };
        if (body.taskId) {
          if (seenTaskIds.has(body.taskId)) {
            findings.push(finding(this.identities, {
              ruleId: "VERIFICATION_EVIDENCE_CONFLICT",
              message: `Duplicate unexpected task record: ${body.taskId}`,
              category: "EXECUTION_INTEGRITY",
              stepIds: [ctx.step.stepId],
            }));
          }
          seenTaskIds.add(body.taskId);
        }
        if (body.sourcePlanId && body.sourcePlanId !== ctx.plan.planId) {
          findings.push(finding(this.identities, {
            ruleId: "VERIFICATION_BINDING_MISMATCH",
            message: "Task sourcePlanId does not match plan",
            category: "BINDING",
            stepIds: [ctx.step.stepId],
          }));
        }
        if (body.sourceStepId && body.sourceStepId !== ctx.step.stepId) {
          findings.push(finding(this.identities, {
            ruleId: "VERIFICATION_BINDING_MISMATCH",
            message: "Task sourceStepId does not match step",
            category: "BINDING",
            stepIds: [ctx.step.stepId],
          }));
        }
        if (!body.title) {
          findings.push(finding(this.identities, {
            ruleId: "VERIFICATION_POSTCONDITION_FAILED",
            message: "Task record missing title",
            category: "POSTCONDITION",
            stepIds: [ctx.step.stepId],
          }));
        }
      } catch {
        findings.push(finding(this.identities, {
          ruleId: "VERIFICATION_ARTIFACT_MISSING",
          message: "Could not read task artifact",
          category: "ARTIFACT_INTEGRITY",
          stepIds: [ctx.step.stepId],
        }));
      }
    }

    // Same idempotency identity should not produce multiple TASK artifacts
    if (artifacts.filter((a) => a.artifactType === "TASK").length > 1) {
      findings.push(finding(this.identities, {
        ruleId: "VERIFICATION_EVIDENCE_CONFLICT",
        message: "Duplicate unexpected task artifacts for same step",
        category: "EXECUTION_INTEGRITY",
        stepIds: [ctx.step.stepId],
      }));
    }

    const passed = findings.length === 0 && ctx.step.status === "SUCCEEDED";
    return {
      actionType: this.actionType,
      stepId: ctx.step.stepId,
      passed,
      postconditionVerdict: passed ? "SATISFIED" : "UNSATISFIED",
      findings,
      observedSummary: passed
        ? "Expected task record exists"
        : "Task verification failed",
      evidenceHints: artifacts.map((a) => a.artifactId),
    };
  }
}

class PreparePullRequestVerifier implements ActionOutcomeVerifier {
  readonly actionType = "PREPARE_PULL_REQUEST";

  constructor(private readonly identities: VerificationIdentityGenerator) {}

  async verify(ctx: ActionOutcomeContext): Promise<ActionOutcomeVerification> {
    const findings: VerificationFinding[] = [];
    const artifacts: ExecutionArtifact[] = [];
    for (const id of ctx.step.outputArtifactRefs) {
      const a = await ctx.artifacts.getById(id);
      if (a) artifacts.push(a);
    }

    if (artifacts.length === 0) {
      findings.push(finding(this.identities, {
        ruleId: "VERIFICATION_ARTIFACT_MISSING",
        message: "PREPARE_PULL_REQUEST artifact missing",
        category: "ARTIFACT_INTEGRITY",
        stepIds: [ctx.step.stepId],
      }));
      return fail(ctx, findings, "PR preparation artifact missing");
    }

    for (const artifact of artifacts) {
      if (artifact.artifactType !== "PR_PREPARATION") {
        findings.push(finding(this.identities, {
          ruleId: "VERIFICATION_ARTIFACT_IDENTITY_MISMATCH",
          message: `Expected PR_PREPARATION, got ${artifact.artifactType}`,
          category: "ARTIFACT_INTEGRITY",
          stepIds: [ctx.step.stepId],
        }));
        continue;
      }
      try {
        const bodyText = await readActionArtifactText(ctx, artifact);
        if (bodyText === null) {
          throw new Error("missing artifact body");
        }
        const body = JSON.parse(bodyText) as {
          title?: string;
          body?: string;
          base?: string;
          githubPullRequestCreated?: boolean;
          pullRequestUrl?: string;
          patchArtifactRefs?: string[];
        };
        if (body.githubPullRequestCreated === true || body.pullRequestUrl) {
          findings.push(finding(this.identities, {
            ruleId: "VERIFICATION_GOVERNANCE_VIOLATION",
            message:
              "PR preparation falsely claims a GitHub pull request exists",
            category: "GOVERNANCE",
            stepIds: [ctx.step.stepId],
          }));
        }
        if (!body.title || !body.base) {
          findings.push(finding(this.identities, {
            ruleId: "VERIFICATION_POSTCONDITION_FAILED",
            message: "PR preparation missing title/base metadata",
            category: "POSTCONDITION",
            stepIds: [ctx.step.stepId],
          }));
        }
        for (const ref of body.patchArtifactRefs ?? []) {
          const patch = await ctx.artifacts.getById(ref);
          if (!patch) {
            findings.push(finding(this.identities, {
              ruleId: "VERIFICATION_ARTIFACT_MISSING",
              message: `Referenced patch artifact missing: ${ref}`,
              category: "ARTIFACT_INTEGRITY",
              stepIds: [ctx.step.stepId],
            }));
          } else {
            const recomputed = ctx.recomputedHashes.get(ref);
            if (recomputed && recomputed !== patch.contentHash) {
              findings.push(finding(this.identities, {
                ruleId: "VERIFICATION_ARTIFACT_HASH_MISMATCH",
                message: `Referenced patch hash mismatch: ${ref}`,
                category: "ARTIFACT_INTEGRITY",
                stepIds: [ctx.step.stepId],
              }));
            }
          }
        }
      } catch {
        findings.push(finding(this.identities, {
          ruleId: "VERIFICATION_ARTIFACT_MISSING",
          message: "Could not read PR preparation artifact",
          category: "ARTIFACT_INTEGRITY",
          stepIds: [ctx.step.stepId],
        }));
      }
    }

    const passed = findings.length === 0 && ctx.step.status === "SUCCEEDED";
    return {
      actionType: this.actionType,
      stepId: ctx.step.stepId,
      passed,
      postconditionVerdict: passed ? "SATISFIED" : "UNSATISFIED",
      findings,
      observedSummary: passed
        ? "PR preparation artifact exists (no GitHub PR claimed)"
        : "PR preparation verification failed",
      evidenceHints: artifacts.map((a) => a.artifactId),
    };
  }
}

function finding(
  identities: VerificationIdentityGenerator,
  input: {
    ruleId: string;
    message: string;
    category: VerificationFinding["category"];
    stepIds: string[];
    metadata?: Record<string, unknown>;
  },
): VerificationFinding {
  return {
    findingId: identities.nextFindingId(),
    category: input.category,
    severity: "ERROR",
    ruleId: input.ruleId,
    message: input.message,
    criterionIds: [],
    stepIds: input.stepIds,
    evidenceRefs: [],
    blocksVerifiedSuccess: true,
    metadata: input.metadata ?? {},
  };
}

function fail(
  ctx: ActionOutcomeContext,
  findings: VerificationFinding[],
  summary: string,
): ActionOutcomeVerification {
  return {
    actionType: ctx.step.actionType,
    stepId: ctx.step.stepId,
    passed: false,
    postconditionVerdict: "UNSATISFIED",
    findings,
    observedSummary: summary,
    evidenceHints: [],
  };
}

async function readActionArtifactText(
  ctx: ActionOutcomeContext,
  artifact: ExecutionArtifact,
): Promise<string | null> {
  const body = await readVerificationArtifactBytes({
    artifactId: artifact.artifactId,
    relativePath: artifact.relativePath,
    runId: ctx.runId,
    dataRoot: ctx.dataRoot,
    ...(ctx.blobStore !== undefined ? { blobStore: ctx.blobStore } : {}),
  });
  return body ? utf8FromVerificationBytes(body.bytes) : null;
}
