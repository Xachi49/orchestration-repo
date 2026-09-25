/**
 * Deterministic Revenue Recovery target binder.
 *
 * OpenAI may propose SEND_RECOVERY_* action semantics.
 * This binder owns canonical case / lead / template targetIds from persisted records.
 *
 * MODEL PROPOSAL != TARGET AUTHORITY
 * CANONICAL BUSINESS RECORD != MODEL-GENERATED IDENTITY
 */

import type { ObjectiveRepository } from "../admission/objective-repository.js";
import type { RunRepository } from "../admission/run-repository.js";
import { isRecoveryPhase7ActionType } from "../execution/action-schemas.js";
import type { PlanProposal } from "../planning/proposal.js";
import {
  formatRecoveryCaseTarget,
  formatRecoveryLeadTarget,
  formatRecoveryTemplateTarget,
  parseRecoveryOutreachTargets,
  RECOVERY_TARGET_PREFIX,
} from "./target-grammar.js";
import type {
  LeadRepository,
  RecoveryCaseRepository,
  RecoveryTemplateRepository,
} from "./repositories.js";
import type { RecoveryCase } from "./recovery-case.js";
import type { RecoveryMessageTemplate } from "./recovery-template.js";

export type RecoveryTargetBinderErrorCode =
  | "RECOVERY_CASE_NOT_BOUND"
  | "RECOVERY_CASE_OBJECTIVE_MISMATCH"
  | "RECOVERY_LEAD_MISMATCH"
  | "RECOVERY_LEAD_NOT_FOUND"
  | "RECOVERY_TEMPLATE_UNRESOLVED"
  | "RECOVERY_TEMPLATE_AMBIGUOUS"
  | "RECOVERY_TEMPLATE_DISABLED"
  | "RECOVERY_TEMPLATE_TENANT_MISMATCH"
  | "MODEL_TARGET_CONFLICT"
  | "UNSUPPORTED_RECOVERY_ACTION";

export class RecoveryTargetBinderError extends Error {
  readonly code: RecoveryTargetBinderErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: RecoveryTargetBinderErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "RecoveryTargetBinderError";
    this.code = code;
    this.details = details;
  }
}

export function isRecoveryTargetBinderError(
  error: unknown,
): error is RecoveryTargetBinderError {
  return error instanceof RecoveryTargetBinderError;
}

export type CanonicalRecoveryTargetBinding = {
  recoveryCaseId: string;
  leadId: string;
  templateId: string;
  templateVersion: number;
  channel: "EMAIL" | "SMS";
};

export interface RevenueRecoveryTargetBinderDeps {
  runs: RunRepository;
  objectives: ObjectiveRepository;
  cases: RecoveryCaseRepository;
  leads: LeadRepository;
  templates: RecoveryTemplateRepository;
}

function expectedObjectiveId(recoveryCaseId: string): string {
  return `obj_rr_${recoveryCaseId}`;
}

function channelForAction(
  actionType: string,
): "EMAIL" | "SMS" | null {
  if (actionType === "SEND_RECOVERY_EMAIL") return "EMAIL";
  if (actionType === "SEND_RECOVERY_SMS") return "SMS";
  return null;
}

export class RevenueRecoveryTargetBinder {
  constructor(private readonly deps: RevenueRecoveryTargetBinderDeps) {}

  /**
   * Resolve canonical case + lead for a run (no template).
   */
  async resolveCaseAndLead(runId: string): Promise<{
    recoveryCase: RecoveryCase;
    leadId: string;
  }> {
    const run = await this.deps.runs.getById(runId);
    if (!run) {
      throw new RecoveryTargetBinderError(
        "RECOVERY_CASE_NOT_BOUND",
        `Run not found: ${runId}`,
        { runId },
      );
    }

    const recoveryCase = await this.resolveCaseForRun(run.runId, run.objectiveId);
    const lead = await this.deps.leads.getById(recoveryCase.leadId);
    if (!lead) {
      throw new RecoveryTargetBinderError(
        "RECOVERY_LEAD_NOT_FOUND",
        `Canonical lead missing for case ${recoveryCase.recoveryCaseId}`,
        { leadId: recoveryCase.leadId },
      );
    }
    if (
      lead.leadId !== recoveryCase.leadId ||
      lead.customerAccountId !== recoveryCase.customerAccountId ||
      lead.projectId !== recoveryCase.projectId
    ) {
      throw new RecoveryTargetBinderError(
        "RECOVERY_LEAD_MISMATCH",
        "Lead identity does not match recovery case",
        {
          caseLeadId: recoveryCase.leadId,
          leadId: lead.leadId,
        },
      );
    }
    return { recoveryCase, leadId: recoveryCase.leadId };
  }

  /**
   * Resolve canonical case/lead/template for a run. Fail closed on ambiguity.
   */
  async resolveCanonicalBinding(input: {
    runId: string;
    channel: "EMAIL" | "SMS";
  }): Promise<CanonicalRecoveryTargetBinding> {
    const { recoveryCase, leadId } = await this.resolveCaseAndLead(input.runId);
    const template = await this.resolveUniqueEnabledTemplate({
      recoveryCase,
      channel: input.channel,
    });

    return {
      recoveryCaseId: recoveryCase.recoveryCaseId,
      leadId,
      templateId: template.templateId,
      templateVersion: template.version,
      channel: input.channel,
    };
  }

  /**
   * Bind proposal steps: fill missing recovery targets; reject model conflicts.
   */
  async bindProposalSteps(input: {
    runId: string;
    steps: PlanProposal["steps"];
  }): Promise<PlanProposal["steps"]> {
    const hasRecovery = input.steps.some((s) =>
      isRecoveryPhase7ActionType(s.actionType),
    );
    if (!hasRecovery) {
      return input.steps;
    }

    const bound: PlanProposal["steps"] = [];
    for (const step of input.steps) {
      if (!isRecoveryPhase7ActionType(step.actionType)) {
        bound.push(step);
        continue;
      }

      const channel = channelForAction(step.actionType);
      if (step.actionType === "CREATE_CALLBACK_TASK") {
        const { recoveryCase, leadId } = await this.resolveCaseAndLead(
          input.runId,
        );
        bound.push({
          ...step,
          targetIds: this.mergeCallbackTargets(step.targetIds, {
            recoveryCaseId: recoveryCase.recoveryCaseId,
            leadId,
            templateId: "",
            templateVersion: 0,
            channel: "EMAIL",
          }),
        });
        continue;
      }

      if (!channel) {
        throw new RecoveryTargetBinderError(
          "UNSUPPORTED_RECOVERY_ACTION",
          `Unsupported recovery action ${step.actionType}`,
        );
      }

      const binding = await this.resolveCanonicalBinding({
        runId: input.runId,
        channel,
      });
      bound.push({
        ...step,
        targetIds: this.mergeOutreachTargets(step.targetIds, binding, {
          requireTemplate: true,
        }),
      });
    }
    return bound;
  }

  /**
   * Bind execution-plan style steps (repair path). Same conflict policy.
   */
  async bindPlanSteps(input: {
    runId: string;
    steps: readonly {
      stepId: string;
      actionType: string;
      targetIds: readonly string[];
      [key: string]: unknown;
    }[];
  }): Promise<
    {
      stepId: string;
      actionType: string;
      targetIds: string[];
      [key: string]: unknown;
    }[]
  > {
    const proposalLike = input.steps.map((s) => ({
      ...s,
      targetIds: [...s.targetIds],
    })) as PlanProposal["steps"];
    const bound = await this.bindProposalSteps({
      runId: input.runId,
      steps: proposalLike,
    });
    return input.steps.map((original, i) => ({
      ...original,
      targetIds: [...bound[i]!.targetIds],
    }));
  }

  private async resolveCaseForRun(
    runId: string,
    objectiveId: string,
  ): Promise<RecoveryCase> {
    const byRun = await this.deps.cases.getByOrchestratorRunId(runId);
    if (byRun) {
      const expected = expectedObjectiveId(byRun.recoveryCaseId);
      if (objectiveId !== expected) {
        throw new RecoveryTargetBinderError(
          "RECOVERY_CASE_OBJECTIVE_MISMATCH",
          "Run objective does not match bound RecoveryCase",
          { runObjectiveId: objectiveId, expected },
        );
      }
      if (byRun.objectiveId && byRun.objectiveId !== objectiveId) {
        throw new RecoveryTargetBinderError(
          "RECOVERY_CASE_OBJECTIVE_MISMATCH",
          "RecoveryCase.objectiveId disagrees with run objective",
          {
            runObjectiveId: objectiveId,
            caseObjectiveId: byRun.objectiveId,
          },
        );
      }
      return byRun;
    }

    // Consistency fallback: objective encodes case id — verify repository record.
    if (objectiveId.startsWith("obj_rr_")) {
      const caseId = objectiveId.slice("obj_rr_".length);
      const fromObjective = await this.deps.cases.getById(caseId);
      if (!fromObjective) {
        throw new RecoveryTargetBinderError(
          "RECOVERY_CASE_NOT_BOUND",
          `No RecoveryCase for objective ${objectiveId}`,
          { runId, objectiveId },
        );
      }
      if (
        fromObjective.orchestratorRunId &&
        fromObjective.orchestratorRunId !== runId
      ) {
        throw new RecoveryTargetBinderError(
          "RECOVERY_CASE_NOT_BOUND",
          "RecoveryCase is bound to a different orchestrator run",
          {
            runId,
            orchestratorRunId: fromObjective.orchestratorRunId,
          },
        );
      }
      return fromObjective;
    }

    throw new RecoveryTargetBinderError(
      "RECOVERY_CASE_NOT_BOUND",
      `No RecoveryCase bound to run ${runId}`,
      { runId, objectiveId },
    );
  }

  private async resolveUniqueEnabledTemplate(input: {
    recoveryCase: RecoveryCase;
    channel: "EMAIL" | "SMS";
  }): Promise<RecoveryMessageTemplate> {
    const enabled = await this.deps.templates.listEnabled({
      customerAccountId: input.recoveryCase.customerAccountId,
      projectId: input.recoveryCase.projectId,
      channel: input.channel,
    });
    const eligible = enabled.filter(
      (t) =>
        t.enabled &&
        t.customerAccountId === input.recoveryCase.customerAccountId &&
        t.projectId === input.recoveryCase.projectId &&
        t.channel === input.channel,
    );
    if (eligible.length === 0) {
      throw new RecoveryTargetBinderError(
        "RECOVERY_TEMPLATE_UNRESOLVED",
        `No enabled ${input.channel} template for recovery case tenant/project`,
        {
          customerAccountId: input.recoveryCase.customerAccountId,
          projectId: input.recoveryCase.projectId,
          channel: input.channel,
        },
      );
    }
    if (eligible.length > 1) {
      // Prefer single templateId with highest version if all share one id.
      const ids = new Set(eligible.map((t) => t.templateId));
      if (ids.size === 1) {
        return eligible.sort((a, b) => b.version - a.version)[0]!;
      }
      throw new RecoveryTargetBinderError(
        "RECOVERY_TEMPLATE_AMBIGUOUS",
        `Multiple enabled ${input.channel} templates qualify; refuse arbitrary choice`,
        {
          templateIds: [...ids],
          count: eligible.length,
        },
      );
    }
    const template = eligible[0]!;
    if (!template.enabled) {
      throw new RecoveryTargetBinderError(
        "RECOVERY_TEMPLATE_DISABLED",
        "Resolved template is disabled",
        { templateId: template.templateId },
      );
    }
    return template;
  }

  private mergeOutreachTargets(
    modelTargets: readonly string[],
    binding: CanonicalRecoveryTargetBinding,
    contract: { requireTemplate: boolean },
  ): string[] {
    this.assertNoModelConflict(modelTargets, binding, contract.requireTemplate);
    const note = modelTargets.find((t) =>
      t.startsWith(RECOVERY_TARGET_PREFIX.note),
    );
    const targets = [
      formatRecoveryCaseTarget(binding.recoveryCaseId),
      formatRecoveryLeadTarget(binding.leadId),
      formatRecoveryTemplateTarget(binding.templateId, binding.templateVersion),
    ];
    if (note) {
      targets.push(note);
    }
    return targets;
  }

  private mergeCallbackTargets(
    modelTargets: readonly string[],
    binding: CanonicalRecoveryTargetBinding,
  ): string[] {
    this.assertNoModelConflict(modelTargets, binding, false);
    const note = modelTargets.find((t) =>
      t.startsWith(RECOVERY_TARGET_PREFIX.note),
    );
    const targets = [
      formatRecoveryCaseTarget(binding.recoveryCaseId),
      formatRecoveryLeadTarget(binding.leadId),
    ];
    if (note) {
      targets.push(note);
    }
    return targets;
  }

  private assertNoModelConflict(
    modelTargets: readonly string[],
    binding: CanonicalRecoveryTargetBinding,
    checkTemplate: boolean,
  ): void {
    const parsed = parseRecoveryOutreachTargets(modelTargets, {
      requireTemplate: false,
    });
    // Empty / incomplete model targets are filled — not a conflict.
    if (!parsed.ok) {
      if (parsed.code === "RECOVERY_TARGETS_MISSING") {
        return;
      }
      throw new RecoveryTargetBinderError(
        "MODEL_TARGET_CONFLICT",
        parsed.message,
        parsed.details,
      );
    }

    if (parsed.value.recoveryCaseId !== binding.recoveryCaseId) {
      throw new RecoveryTargetBinderError(
        "MODEL_TARGET_CONFLICT",
        "Model rr_case: conflicts with canonical RecoveryCase",
        {
          model: parsed.value.recoveryCaseId,
          canonical: binding.recoveryCaseId,
        },
      );
    }
    if (parsed.value.leadId !== binding.leadId) {
      throw new RecoveryTargetBinderError(
        "MODEL_TARGET_CONFLICT",
        "Model rr_lead: conflicts with canonical Lead",
        {
          model: parsed.value.leadId,
          canonical: binding.leadId,
        },
      );
    }
    if (checkTemplate && parsed.value.templateId !== undefined) {
      if (
        parsed.value.templateId !== binding.templateId ||
        parsed.value.templateVersion !== binding.templateVersion
      ) {
        throw new RecoveryTargetBinderError(
          "MODEL_TARGET_CONFLICT",
          "Model rr_template: conflicts with canonical template binding",
          {
            model: `${parsed.value.templateId}@${parsed.value.templateVersion}`,
            canonical: `${binding.templateId}@${binding.templateVersion}`,
          },
        );
      }
    }
  }
}
