import { z } from "zod";
import type { ExecutionStep } from "../domain/plan/execution-plan.js";
import type { ExecutionPlan } from "../domain/plan/execution-plan.js";
import {
  CapabilityExecutionSchemaMap,
  CreateLocalPatchArgsSchema,
  CreateTaskArgsSchema,
  isPhase7ActionType,
  PreparePullRequestArgsSchema,
  RunTestsArgsSchema,
  type Phase7ActionType,
} from "./action-schemas.js";
import { ExecutionError } from "./errors.js";
import { fingerprintValue, stepIdempotencyKey } from "./idempotency.js";
import { ExecutionTargetValidator } from "./target-validator.js";
import type { TestProfileRegistry } from "./test-profiles.js";

export const CompiledExecutionStepSchema = z
  .object({
    stepId: z.string().min(1),
    capabilityId: z.string().min(1),
    actionType: z.enum([
      "CREATE_LOCAL_PATCH",
      "RUN_TESTS",
      "CREATE_TASK",
      "PREPARE_PULL_REQUEST",
    ]),
    validatedTargets: z.array(z.string()),
    normalizedArguments: z.record(z.string(), z.unknown()),
    preconditions: z.array(z.string()),
    expectedPostconditions: z.array(z.string()),
    verificationRequirements: z.array(z.string()),
    rollbackReference: z
      .object({
        strategy: z.enum(["NONE", "COMPENSATING_ACTION", "MANUAL"]),
        compensatingStepIds: z.array(z.string()).optional(),
        instructions: z.array(z.string()).optional(),
      })
      .strict(),
    idempotencyKey: z.string().min(1),
    dependsOn: z.array(z.string()),
  })
  .strict();

export type CompiledExecutionStep = z.infer<typeof CompiledExecutionStepSchema>;

const FORBIDDEN_ARG_KEYS = new Set([
  "shell",
  "command",
  "cmd",
  "script",
  "url",
  "http",
  "https",
  "endpoint",
  "network",
]);

/**
 * Converts an authorized ExecutionPlan into deterministic actuator instructions.
 * Does not execute. Rejects unsupported actions, shell strings, absolute paths,
 * unregistered test profiles, and out-of-schema arguments.
 */
export class DryRunCompiler {
  private readonly targets = new ExecutionTargetValidator();

  constructor(private readonly testProfiles: TestProfileRegistry) {}

  compile(input: {
    plan: ExecutionPlan;
    workspaceRoot: string;
    capabilityIdsByAction: ReadonlyMap<string, string>;
  }): CompiledExecutionStep[] {
    const compiled: CompiledExecutionStep[] = [];
    for (const step of input.plan.steps) {
      compiled.push(this.compileStep(step, input));
    }
    return compiled;
  }

  compileStep(
    step: ExecutionStep,
    input: {
      plan: ExecutionPlan;
      workspaceRoot: string;
      capabilityIdsByAction: ReadonlyMap<string, string>;
    },
  ): CompiledExecutionStep {
    if (!isPhase7ActionType(step.actionType)) {
      throw new ExecutionError(
        "EXECUTION_UNSUPPORTED_ACTION",
        `Action type ${step.actionType} is not supported in Phase 7`,
        { stepId: step.stepId, actionType: step.actionType },
      );
    }

    const capabilityId =
      input.capabilityIdsByAction.get(step.actionType) ?? step.actionType;

    this.rejectForbiddenFreeForm(step);

    const normalizedArguments = this.normalizeArguments(
      step,
      step.actionType,
      input.workspaceRoot,
    );
    const schema = CapabilityExecutionSchemaMap[step.actionType];
    const parsed = schema.safeParse(normalizedArguments);
    if (!parsed.success) {
      throw new ExecutionError(
        "EXECUTION_ARGUMENT_INVALID",
        `Arguments for ${step.actionType} failed schema validation`,
        { stepId: step.stepId, issues: parsed.error.issues },
      );
    }

    let validatedTargets: string[] = [];
    if (step.actionType === "CREATE_LOCAL_PATCH") {
      const args = CreateLocalPatchArgsSchema.parse(parsed.data);
      validatedTargets = this.targets.validateTargets(
        input.workspaceRoot,
        args.targetPaths,
      );
    } else if (step.actionType === "RUN_TESTS") {
      const args = RunTestsArgsSchema.parse(parsed.data);
      if (!this.testProfiles.isRegistered(args.testProfileId)) {
        throw new ExecutionError(
          "EXECUTION_ARGUMENT_INVALID",
          `Unregistered test profile: ${args.testProfileId}`,
          { stepId: step.stepId, testProfileId: args.testProfileId },
        );
      }
      validatedTargets = [args.testProfileId];
    } else {
      validatedTargets = step.targetIds
        .filter((t) => t !== "workspace")
        .map((t) => {
          try {
            return this.targets.normalizeRelative(t);
          } catch {
            return t;
          }
        });
    }

    const targetFingerprint = fingerprintValue(validatedTargets);
    const argumentFingerprint = fingerprintValue(parsed.data);
    const idempotencyKey = stepIdempotencyKey({
      planHash: input.plan.planHash,
      stepId: step.stepId,
      capabilityId,
      targetFingerprint,
      argumentFingerprint,
    });

    const rollbackReference: CompiledExecutionStep["rollbackReference"] = {
      strategy: step.rollback.strategy,
      ...(step.rollback.compensatingStepIds !== undefined
        ? { compensatingStepIds: [...step.rollback.compensatingStepIds] }
        : {}),
      ...(step.rollback.instructions !== undefined
        ? { instructions: [...step.rollback.instructions] }
        : {}),
    };

    return CompiledExecutionStepSchema.parse({
      stepId: step.stepId,
      capabilityId,
      actionType: step.actionType,
      validatedTargets,
      normalizedArguments: parsed.data as Record<string, unknown>,
      preconditions: [...step.preconditions],
      expectedPostconditions: [...step.expectedPostconditions],
      verificationRequirements: [...step.validation.checks],
      rollbackReference,
      idempotencyKey,
      dependsOn: [...step.dependsOn],
    });
  }

  private rejectForbiddenFreeForm(step: ExecutionStep): void {
    const haystacks = [
      step.description,
      ...step.preconditions,
      ...step.expectedPostconditions,
      ...step.validation.checks,
      ...(step.rollback.instructions ?? []),
    ];
    for (const text of haystacks) {
      if (/\b(curl|wget|bash\s+-c|sh\s+-c|powershell)\b/i.test(text)) {
        throw new ExecutionError(
          "EXECUTION_ARGUMENT_INVALID",
          "Plan text contains forbidden shell/network invocation patterns",
          { stepId: step.stepId },
        );
      }
      if (/https?:\/\//i.test(text) && step.actionType !== "PREPARE_PULL_REQUEST") {
        throw new ExecutionError(
          "EXECUTION_ARGUMENT_INVALID",
          "Plan text contains arbitrary URL/network target",
          { stepId: step.stepId },
        );
      }
    }
    for (const target of step.targetIds) {
      if (pathLooksAbsolute(target) || target.includes("..")) {
        throw new ExecutionError(
          "EXECUTION_TARGET_INVALID",
          `Absolute or traversing target rejected: ${target}`,
          { stepId: step.stepId, target },
        );
      }
    }
  }

  private normalizeArguments(
    step: ExecutionStep,
    actionType: Phase7ActionType,
    workspaceRoot: string,
  ): Record<string, unknown> {
    void workspaceRoot;
    switch (actionType) {
      case "CREATE_LOCAL_PATCH": {
        const targetPaths = step.targetIds.filter((t) => t !== "workspace");
        if (targetPaths.length === 0) {
          throw new ExecutionError(
            "EXECUTION_ARGUMENT_INVALID",
            "CREATE_LOCAL_PATCH requires at least one relative target path",
            { stepId: step.stepId },
          );
        }
        for (const p of targetPaths) {
          if (pathLooksAbsolute(p)) {
            throw new ExecutionError(
              "EXECUTION_TARGET_INVALID",
              `Absolute path rejected: ${p}`,
              { stepId: step.stepId },
            );
          }
        }
        return CreateLocalPatchArgsSchema.parse({
          targetPaths,
          patchContent: `--- a/${targetPaths[0]}\n+++ b/${targetPaths[0]}\n@@ Phase 7 local patch artifact for ${step.stepId} @@\n`,
          patchSummary: step.description,
        });
      }
      case "RUN_TESTS": {
        const profileCandidate =
          step.targetIds.find((t) =>
            this.testProfiles.isRegistered(t),
          ) ?? step.targetIds.find((t) => t !== "workspace");
        if (!profileCandidate) {
          throw new ExecutionError(
            "EXECUTION_ARGUMENT_INVALID",
            "RUN_TESTS requires a registered testProfileId in targetIds",
            { stepId: step.stepId },
          );
        }
        if (!this.testProfiles.isRegistered(profileCandidate)) {
          throw new ExecutionError(
            "EXECUTION_ARGUMENT_INVALID",
            `Unregistered test profile: ${profileCandidate}`,
            { stepId: step.stepId, testProfileId: profileCandidate },
          );
        }
        return RunTestsArgsSchema.parse({ testProfileId: profileCandidate });
      }
      case "CREATE_TASK": {
        return CreateTaskArgsSchema.parse({
          title: step.description.slice(0, 500),
          description: step.description,
          tags: step.targetIds.filter((t) => t !== "workspace").slice(0, 20),
        });
      }
      case "PREPARE_PULL_REQUEST": {
        return PreparePullRequestArgsSchema.parse({
          title: step.description.slice(0, 500),
          body: [
            step.description,
            "",
            "Expected postconditions:",
            ...step.expectedPostconditions.map((p) => `- ${p}`),
          ].join("\n"),
          baseBranch: "main",
          proposedHeadBranchName: `orchestrator/${step.stepId}`,
          associatedPatchReferences: step.dependsOn,
        });
      }
      default: {
        const _exhaustive: never = actionType;
        throw new ExecutionError(
          "EXECUTION_UNSUPPORTED_ACTION",
          `Unhandled action ${_exhaustive}`,
        );
      }
    }
  }
}

function pathLooksAbsolute(value: string): boolean {
  return (
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[A-Za-z]:[\\/]/.test(value)
  );
}

export type { Phase7ActionType };
export { FORBIDDEN_ARG_KEYS };
