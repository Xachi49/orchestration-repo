import type { ConstitutionalChangeOperation } from "./operations.js";
import type { ConstitutionalActivationCapability } from "./activation-capability.js";
import type { GovernanceOrchestrationService } from "../governance/service.js";
import type { GovernanceMandate } from "../governance/mandate.js";
import { ConstitutionalError } from "./errors.js";
import { assertExhaustiveOperationKind } from "./mutation-plan.js";

export interface ApplyMutationPlanDeps {
  nowIso: () => string;
  governance: GovernanceOrchestrationService;
}

export async function applyConstitutionalMutationPlan(input: {
  operations: readonly ConstitutionalChangeOperation[];
  capability: ConstitutionalActivationCapability;
  activatedByPrincipalId: string;
  deps: ApplyMutationPlanDeps;
  /** Invoked after material governance writes, before activation record persistence. */
  afterMaterialWrites?: () => void;
}): Promise<void> {
  const { capability, deps } = input;
  const now = deps.nowIso();

  for (const op of input.operations) {
    assertExhaustiveOperationKind(op);
    await applyOperation(op, {
      capability,
      activatedByPrincipalId: input.activatedByPrincipalId,
      now,
      governance: deps.governance,
    });
  }

  input.afterMaterialWrites?.();
}

async function applyOperation(
  op: ConstitutionalChangeOperation,
  ctx: {
    capability: ConstitutionalActivationCapability;
    activatedByPrincipalId: string;
    now: string;
    governance: GovernanceOrchestrationService;
  },
): Promise<void> {
  const cap = { activationCapability: ctx.capability };

  switch (op.kind) {
    case "CHANGE_MANDATE_QUORUM":
      await applyMandatePatch(ctx, op.mandateId, {
        quorumRequirement: op.quorumRequirement,
      }, cap);
      return;
    case "CHANGE_MANDATE_SEPARATION_OF_DUTIES":
      await applyMandatePatch(ctx, op.mandateId, {
        separationOfDutyRules: [...op.separationOfDutyRules],
      }, cap);
      return;
    case "CHANGE_MANDATE_SCOPE":
      await applyMandatePatch(ctx, op.mandateId, {
        projectScope: [...op.projectScope],
        environmentScope: [...op.environmentScope],
      }, cap);
      return;
    case "CHANGE_DELEGATION_LIMITS":
      await applyMandatePatch(ctx, op.mandateId, {
        maximumDelegationDepth: op.maximumDelegationDepth,
        ...(op.delegationPolicy !== undefined
          ? { delegationPolicy: op.delegationPolicy }
          : {}),
      }, cap);
      return;
    case "CREATE_MANDATE_VERSION":
      await createAndActivateMandate(
        ctx,
        mandateCreateInput(
          {
            institutionId: op.institutionId,
            subjectClasses: [...op.subjectClasses],
            requiredAuthorities: [...op.requiredAuthorities],
            projectScope: [...op.projectScope],
            environmentScope: [...op.environmentScope],
            separationOfDutyRules: [...op.separationOfDutyRules],
          },
          {
            ...(op.quorumRequirement !== undefined
              ? { quorumRequirement: op.quorumRequirement }
              : {}),
            ...(op.delegationPolicy !== undefined
              ? { delegationPolicy: op.delegationPolicy }
              : {}),
            ...(op.maximumDelegationDepth !== undefined
              ? { maximumDelegationDepth: op.maximumDelegationDepth }
              : {}),
            ...(op.mandateVersion !== undefined
              ? { mandateVersion: op.mandateVersion }
              : {}),
            ...(op.effectiveFrom !== undefined ? { effectiveFrom: op.effectiveFrom } : {}),
            ...(op.effectiveUntil !== undefined ? { effectiveUntil: op.effectiveUntil } : {}),
          },
        ),
        cap,
      );
      return;
    case "SUPERSEDE_MANDATE_VERSION": {
      const current = await requireMandate(ctx.governance, op.mandateId);
      await createAndActivateMandate(
        ctx,
        mandateCreateInput(
          {
            institutionId: current.institutionId,
            subjectClasses: [...op.subjectClasses],
            requiredAuthorities: [...op.requiredAuthorities],
            projectScope: [...op.projectScope],
            environmentScope: [...op.environmentScope],
            separationOfDutyRules: [...op.separationOfDutyRules],
          },
          {
            mandateVersion: op.newMandateVersion,
            ...(op.quorumRequirement !== undefined
              ? { quorumRequirement: op.quorumRequirement }
              : {}),
            ...(op.delegationPolicy !== undefined
              ? { delegationPolicy: op.delegationPolicy }
              : {}),
            ...(op.maximumDelegationDepth !== undefined
              ? { maximumDelegationDepth: op.maximumDelegationDepth }
              : {}),
            ...(op.effectiveFrom !== undefined ? { effectiveFrom: op.effectiveFrom } : {}),
            ...(op.effectiveUntil !== undefined ? { effectiveUntil: op.effectiveUntil } : {}),
          },
        ),
        cap,
      );
      await ctx.governance.supersedeMandate(
        { mandateId: op.mandateId, actorPrincipalId: ctx.activatedByPrincipalId },
        cap,
      );
      return;
    }
    case "CHANGE_GOVERNANCE_ADMIN_SCOPE":
      await ctx.governance.updateInstitutionProjectScope(
        {
          institutionId: op.institutionId,
          projectScope: [...op.projectScope],
          actorPrincipalId: ctx.activatedByPrincipalId,
        },
        cap,
      );
      return;
    case "CREATE_ORGANIZATIONAL_UNIT":
      await ctx.governance.createOrganizationalUnit(
        {
          institutionId: op.institutionId,
          name: op.name,
          description: op.description,
          projectScope: [...op.projectScope],
          ...(op.parentUnitId !== undefined ? { parentUnitId: op.parentUnitId } : {}),
        },
        cap,
      );
      return;
    case "CHANGE_ORGANIZATIONAL_UNIT_RELATIONSHIP":
      await ctx.governance.updateOrganizationalUnit(
        {
          organizationalUnitId: op.organizationalUnitId,
          ...(op.parentUnitId !== undefined ? { parentUnitId: op.parentUnitId } : {}),
          actorPrincipalId: ctx.activatedByPrincipalId,
        },
        cap,
      );
      return;
    case "RETIRE_ORGANIZATIONAL_UNIT":
      await ctx.governance.retireOrganizationalUnit(
        {
          organizationalUnitId: op.organizationalUnitId,
          actorPrincipalId: ctx.activatedByPrincipalId,
        },
        cap,
      );
      return;
    default: {
      const _never: never = op;
      throw new ConstitutionalError(
        "CONSTITUTIONAL_OPERATION_INVALID",
        `Unhandled operation ${(_never as { kind: string }).kind}`,
      );
    }
  }
}

async function requireMandate(
  governance: GovernanceOrchestrationService,
  mandateId: string,
): Promise<GovernanceMandate> {
  const m = await governance.getMandate(mandateId);
  if (!m) {
    throw new ConstitutionalError(
      "CONSTITUTIONAL_OPERATION_INVALID",
      `Mandate ${mandateId} not found`,
    );
  }
  return m;
}

async function applyMandatePatch(
  ctx: {
    capability: ConstitutionalActivationCapability;
    activatedByPrincipalId: string;
    now: string;
    governance: GovernanceOrchestrationService;
  },
  mandateId: string,
  patch: Partial<GovernanceMandate>,
  cap: { activationCapability: ConstitutionalActivationCapability },
): Promise<void> {
  const current = await requireMandate(ctx.governance, mandateId);
  const nextVersion = current.mandateVersion + 1;
  await createAndActivateMandate(
    ctx,
    mandateCreateInput(
      {
        institutionId: current.institutionId,
        subjectClasses: [...current.subjectClasses],
        requiredAuthorities: [...current.requiredAuthorities],
        projectScope: patch.projectScope
          ? [...patch.projectScope]
          : [...current.projectScope],
        environmentScope: patch.environmentScope
          ? [...patch.environmentScope]
          : [...current.environmentScope],
        separationOfDutyRules: patch.separationOfDutyRules
          ? [...patch.separationOfDutyRules]
          : [...(current.separationOfDutyRules ?? [])],
      },
      {
        ...(patch.quorumRequirement !== undefined
          ? { quorumRequirement: patch.quorumRequirement }
          : current.quorumRequirement !== undefined
            ? { quorumRequirement: current.quorumRequirement }
            : {}),
        ...(patch.delegationPolicy !== undefined
          ? { delegationPolicy: patch.delegationPolicy }
          : { delegationPolicy: current.delegationPolicy }),
        ...(patch.maximumDelegationDepth !== undefined
          ? { maximumDelegationDepth: patch.maximumDelegationDepth }
          : current.maximumDelegationDepth !== undefined
            ? { maximumDelegationDepth: current.maximumDelegationDepth }
            : {}),
        mandateVersion: nextVersion,
        effectiveFrom: current.effectiveFrom,
        ...(current.effectiveUntil !== undefined
          ? { effectiveUntil: current.effectiveUntil }
          : {}),
      },
    ),
    cap,
  );
  await ctx.governance.supersedeMandate(
    { mandateId, actorPrincipalId: ctx.activatedByPrincipalId },
    cap,
  );
}

async function createAndActivateMandate(
  ctx: {
    activatedByPrincipalId: string;
    governance: GovernanceOrchestrationService;
  },
  input: MandateCreateInput,
  cap: { activationCapability: ConstitutionalActivationCapability },
): Promise<GovernanceMandate> {
  const draft = await ctx.governance.createMandate(
    { ...input, createdBy: ctx.activatedByPrincipalId },
    cap,
  );
  return ctx.governance.activateMandate(
    { mandateId: draft.mandateId, actorPrincipalId: ctx.activatedByPrincipalId },
    cap,
  );
}

type MandateCreateInput = Omit<
  Parameters<GovernanceOrchestrationService["createMandate"]>[0],
  "createdBy"
>;

function mandateCreateInput(
  required: {
    institutionId: string;
    subjectClasses: string[];
    requiredAuthorities: string[];
    projectScope: string[];
    environmentScope: string[];
    separationOfDutyRules: NonNullable<
      MandateCreateInput["separationOfDutyRules"]
    >;
  },
  optional: Partial<
    Pick<
      MandateCreateInput,
      | "quorumRequirement"
      | "delegationPolicy"
      | "maximumDelegationDepth"
      | "mandateVersion"
      | "effectiveFrom"
      | "effectiveUntil"
    >
  > = {},
): MandateCreateInput {
  const input: MandateCreateInput = {
    institutionId: required.institutionId,
    subjectClasses: required.subjectClasses,
    requiredAuthorities: required.requiredAuthorities,
    projectScope: required.projectScope,
    environmentScope: required.environmentScope,
    separationOfDutyRules: required.separationOfDutyRules,
  };
  if (optional.quorumRequirement !== undefined) {
    input.quorumRequirement = optional.quorumRequirement;
  }
  if (optional.delegationPolicy !== undefined) {
    input.delegationPolicy = optional.delegationPolicy;
  }
  if (optional.maximumDelegationDepth !== undefined) {
    input.maximumDelegationDepth = optional.maximumDelegationDepth;
  }
  if (optional.mandateVersion !== undefined) {
    input.mandateVersion = optional.mandateVersion;
  }
  if (optional.effectiveFrom !== undefined) {
    input.effectiveFrom = optional.effectiveFrom;
  }
  if (optional.effectiveUntil !== undefined) {
    input.effectiveUntil = optional.effectiveUntil;
  }
  return input;
}
