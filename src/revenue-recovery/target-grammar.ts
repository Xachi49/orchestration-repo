/**
 * Canonical recovery outreach target grammar.
 *
 * ```text
 * rr_case:<recoveryCaseId>
 * rr_lead:<leadId>
 * rr_template:<templateId>@<version>
 * rr_note:<note>   (optional; callback only)
 * ```
 *
 * Single parser for PlanCompiler gates, execution readiness, and DryRunCompiler.
 * MODEL PROPOSAL != TARGET AUTHORITY — this module only parses; binders own identity.
 */

export const RECOVERY_TARGET_PREFIX = {
  case: "rr_case:",
  lead: "rr_lead:",
  template: "rr_template:",
  note: "rr_note:",
} as const;

export type RecoveryTargetParseFailureCode =
  | "RECOVERY_TARGETS_MISSING"
  | "RECOVERY_TEMPLATE_MALFORMED"
  | "RECOVERY_TEMPLATE_REQUIRED"
  | "RECOVERY_TEMPLATE_VERSION_INVALID";

export type ParsedRecoveryOutreachTargets = {
  recoveryCaseId: string;
  leadId: string;
  templateId?: string;
  templateVersion?: number;
  note?: string;
};

export type RecoveryTargetParseResult =
  | { ok: true; value: ParsedRecoveryOutreachTargets }
  | {
      ok: false;
      code: RecoveryTargetParseFailureCode;
      message: string;
      details: Readonly<Record<string, unknown>>;
    };

export type RecoveryTargetContract = {
  /** EMAIL and SMS actuation require a bound template identity. */
  requireTemplate: boolean;
};

/**
 * Deterministic parse of recovery targetIds. Does not resolve recipients.
 */
export function parseRecoveryOutreachTargets(
  targetIds: readonly string[],
  contract: RecoveryTargetContract = { requireTemplate: false },
): RecoveryTargetParseResult {
  const caseId = targetIds
    .find((t) => t.startsWith(RECOVERY_TARGET_PREFIX.case))
    ?.slice(RECOVERY_TARGET_PREFIX.case.length);
  const leadId = targetIds
    .find((t) => t.startsWith(RECOVERY_TARGET_PREFIX.lead))
    ?.slice(RECOVERY_TARGET_PREFIX.lead.length);
  const templateRaw = targetIds
    .find((t) => t.startsWith(RECOVERY_TARGET_PREFIX.template))
    ?.slice(RECOVERY_TARGET_PREFIX.template.length);
  const note = targetIds
    .find((t) => t.startsWith(RECOVERY_TARGET_PREFIX.note))
    ?.slice(RECOVERY_TARGET_PREFIX.note.length);

  if (!caseId || !leadId) {
    return {
      ok: false,
      code: "RECOVERY_TARGETS_MISSING",
      message: "Recovery action requires rr_case: and rr_lead: targetIds",
      details: { targetIds: [...targetIds] },
    };
  }

  let templateId: string | undefined;
  let templateVersion: number | undefined;
  if (templateRaw) {
    const at = templateRaw.lastIndexOf("@");
    if (at <= 0) {
      return {
        ok: false,
        code: "RECOVERY_TEMPLATE_MALFORMED",
        message: "rr_template must be templateId@version",
        details: { templateRaw },
      };
    }
    templateId = templateRaw.slice(0, at);
    templateVersion = Number(templateRaw.slice(at + 1));
    if (!Number.isInteger(templateVersion) || templateVersion < 1) {
      return {
        ok: false,
        code: "RECOVERY_TEMPLATE_VERSION_INVALID",
        message: "Invalid recovery template version",
        details: { templateRaw },
      };
    }
  } else if (contract.requireTemplate) {
    return {
      ok: false,
      code: "RECOVERY_TEMPLATE_REQUIRED",
      message: "Recovery outreach requires rr_template:templateId@version",
      details: { targetIds: [...targetIds] },
    };
  }

  return {
    ok: true,
    value: {
      recoveryCaseId: caseId,
      leadId,
      ...(templateId !== undefined ? { templateId } : {}),
      ...(templateVersion !== undefined ? { templateVersion } : {}),
      ...(note !== undefined ? { note } : {}),
    },
  };
}

export function formatRecoveryCaseTarget(recoveryCaseId: string): string {
  return `${RECOVERY_TARGET_PREFIX.case}${recoveryCaseId}`;
}

export function formatRecoveryLeadTarget(leadId: string): string {
  return `${RECOVERY_TARGET_PREFIX.lead}${leadId}`;
}

export function formatRecoveryTemplateTarget(
  templateId: string,
  templateVersion: number,
): string {
  return `${RECOVERY_TARGET_PREFIX.template}${templateId}@${templateVersion}`;
}

export function recoveryTargetContractForAction(
  actionType: string,
): RecoveryTargetContract | null {
  switch (actionType) {
    case "SEND_RECOVERY_EMAIL":
    case "SEND_RECOVERY_SMS":
      return { requireTemplate: true };
    case "CREATE_CALLBACK_TASK":
      return { requireTemplate: false };
    default:
      return null;
  }
}

/**
 * Validate every recovery step on a compiled or proposed step list.
 */
export function validateRecoveryStepsTargetGrammar(
  steps: readonly { stepId: string; actionType: string; targetIds: readonly string[] }[],
): RecoveryTargetParseResult & { stepId?: string } {
  for (const step of steps) {
    const contract = recoveryTargetContractForAction(step.actionType);
    if (!contract) {
      continue;
    }
    const parsed = parseRecoveryOutreachTargets(step.targetIds, contract);
    if (!parsed.ok) {
      return {
        ...parsed,
        details: { ...parsed.details, stepId: step.stepId, actionType: step.actionType },
        stepId: step.stepId,
      };
    }
  }
  return {
    ok: true,
    value: {
      recoveryCaseId: "",
      leadId: "",
    },
  };
}
