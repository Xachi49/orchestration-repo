import type { AdmissionRequest } from "../admission/request.js";
import type { ObjectiveAdmissionService } from "../admission/service.js";
import { RevenueRecoveryError } from "./errors.js";
import {
  leadMaterialFingerprint,
  newLeadId,
  parseLeadIngest,
  type Lead,
  type LeadIngestInput,
} from "./lead.js";
import {
  newLeadEventId,
  parseLeadEventIngest,
  type LeadEvent,
  type LeadEventIngestInput,
} from "./recovery-event.js";
import {
  assertValidTimezone,
  newRecoveryConfigId,
  parseRecoveryConfigurationInput,
  recoveryConfigFingerprint,
  type RecoveryChannel,
  type RecoveryConfiguration,
  type RecoveryConfigurationInput,
} from "./recovery-config.js";
import { detectResponseGap } from "./response-gap.js";
import {
  ACTIVE_RECOVERY_CASE_STATUSES,
  newRecoveryCaseId,
  type RecoveryCase,
} from "./recovery-case.js";
import {
  evaluateContactPolicy,
  type ContactPolicyResult,
} from "./contact-policy.js";
import {
  mapRecoveryCaseToAdmissionRequest,
  recoveryPlanningContext,
} from "./objective-mapping.js";
import {
  CreateCallbackTaskSchema,
  SendRecoveryEmailSchema,
  SendRecoverySmsSchema,
} from "./recovery-action.js";
import {
  newRecoveryAttemptId,
  recoveryExecutionActionIdentity,
  type RecoveryAttempt,
} from "./recovery-attempt.js";
import {
  ATTRIBUTION_RULE_VERSION,
  isAttestedAttribution,
  isConfirmedBookedAttribution,
  isConfirmedCollectedAttribution,
  newAttributionId,
  withinAttributionWindow,
  type RevenueAttribution,
} from "./revenue-attribution.js";
import {
  GENERIC_EVENT_API_PROVENANCE,
  isFakeTestAllowed,
  resolveConfidenceFromProvenance,
  type ProductRuntimeEnvironment,
  type TrustProvenanceClass,
} from "./provenance.js";
import { evaluateRecoveryOutcome } from "./recovery-outcome.js";
import {
  computeRecoveryRecordHash,
  newRecoveryRecordId,
  type RevenueRecoveryRecord,
} from "./recovery-record.js";
import {
  newTemplateId,
  renderTemplate,
  type RecoveryMessageTemplate,
} from "./recovery-template.js";
import { newAuditEventId, type ProductAuditEvent } from "./audit.js";
import type { RecoveryMessagingProvider } from "./messaging.js";
import type {
  LeadEventRepository,
  LeadRepository,
  ProductAuditRepository,
  RecoveryAttemptRepository,
  RecoveryCaseRepository,
  RecoveryConfigRepository,
  RecoveryTemplateRepository,
  RevenueAttributionRepository,
  RevenueRecoveryRecordRepository,
} from "./repositories.js";
import { maskEmail, maskPhone } from "./hash.js";
import { REVENUE_RECOVERY_DOCTRINE } from "./doctrine.js";

export type RevenueRecoveryServiceDeps = {
  nowIso: () => string;
  leads: LeadRepository;
  leadEvents: LeadEventRepository;
  cases: RecoveryCaseRepository;
  configs: RecoveryConfigRepository;
  attempts: RecoveryAttemptRepository;
  attributions: RevenueAttributionRepository;
  records: RevenueRecoveryRecordRepository;
  templates: RecoveryTemplateRepository;
  audits: ProductAuditRepository;
  messaging: RecoveryMessagingProvider;
  /**
   * Economic provenance environment. Defaults to DEVELOPMENT (fail closed on
   * FAKE_TEST) when a composer does not declare it. The memory harness passes
   * TEST; production/staging factories pass PRODUCTION / STAGING explicitly.
   */
  runtimeEnvironment?: ProductRuntimeEnvironment;
  /** Optional — when present, materializeRecoveryObjective may admit via Phase2. */
  admission?: ObjectiveAdmissionService;
};

/**
 * Operational recovery-engine lead events (LEAD_CREATED, OUTBOUND_ATTEMPT) are
 * non-economic: no attributable event kind is ever engine-generated, so this
 * class can never mint booked or collected revenue. It is recorded so every
 * LeadEvent carries an explicit, server-assigned provenance.
 */
const ENGINE_OPERATIONAL_EVENT_PROVENANCE: TrustProvenanceClass =
  "MANUAL_ATTESTATION";

/**
 * Continuum Revenue Recovery Engine orchestration service.
 * Domain adapter around Phases 0–24 — does not create approval/execution authority.
 */
export class RevenueRecoveryService {
  private readonly runtimeEnvironment: ProductRuntimeEnvironment;

  constructor(private readonly deps: RevenueRecoveryServiceDeps) {
    this.runtimeEnvironment = deps.runtimeEnvironment ?? "DEVELOPMENT";
  }

  async putConfiguration(
    input: RecoveryConfigurationInput,
  ): Promise<RecoveryConfiguration> {
    const parsed = parseRecoveryConfigurationInput(input);
    assertValidTimezone(parsed.timezone);
    const latest = await this.deps.configs.getLatest({
      customerAccountId: parsed.customerAccountId,
      projectId: parsed.projectId,
    });
    const configVersion = (latest?.configVersion ?? 0) + 1;
    const config: RecoveryConfiguration = {
      ...parsed,
      configId: newRecoveryConfigId({
        customerAccountId: parsed.customerAccountId,
        projectId: parsed.projectId,
        configVersion,
      }),
      configVersion,
      configFingerprint: recoveryConfigFingerprint(parsed),
      createdAt: this.deps.nowIso(),
    };
    await this.deps.configs.save(config);
    return config;
  }

  async saveTemplate(
    input: Omit<RecoveryMessageTemplate, "templateId" | "createdAt"> & {
      templateId?: string;
    },
  ): Promise<RecoveryMessageTemplate> {
    const template: RecoveryMessageTemplate = {
      templateId:
        input.templateId ??
        newTemplateId({
          customerAccountId: input.customerAccountId,
          channel: input.channel,
          version: input.version,
        }),
      customerAccountId: input.customerAccountId,
      projectId: input.projectId,
      channel: input.channel,
      version: input.version,
      body: input.body,
      allowedVariables: input.allowedVariables,
      enabled: input.enabled,
      createdAt: this.deps.nowIso(),
    };
    await this.deps.templates.save(template);
    return template;
  }

  async ingestLead(raw: unknown): Promise<{ lead: Lead; created: boolean }> {
    const input = parseLeadIngest(raw);
    const existing = await this.deps.leads.getBySourceIdentity({
      customerAccountId: input.customerAccountId,
      source: input.source,
      externalLeadId: input.externalLeadId,
    });
    const fingerprint = leadMaterialFingerprint(input);
    if (existing) {
      if (existing.materialFingerprint !== fingerprint) {
        throw new RevenueRecoveryError(
          "LEAD_SOURCE_CONFLICT",
          "Material lead fields conflict for the same source identity",
          {
            leadId: existing.leadId,
            existingFingerprint: existing.materialFingerprint,
            incomingFingerprint: fingerprint,
          },
        );
      }
      return { lead: existing, created: false };
    }

    const now = this.deps.nowIso();
    const lead: Lead = {
      ...input,
      leadId: newLeadId({
        customerAccountId: input.customerAccountId,
        source: input.source,
        externalLeadId: input.externalLeadId,
      }),
      materialFingerprint: fingerprint,
      recordRevision: 1,
      ingestedAt: now,
    };
    await this.deps.leads.save(lead);
    await this.appendLeadEventInternal(
      {
        customerAccountId: lead.customerAccountId,
        projectId: lead.projectId,
        leadId: lead.leadId,
        kind: "LEAD_CREATED",
        occurredAt: lead.createdAt,
        externalEventId: `created:${lead.externalLeadId}`,
        source: lead.source,
      },
      ENGINE_OPERATIONAL_EVENT_PROVENANCE,
    );
    await this.audit({
      kind: "LEAD_INGESTED",
      customerAccountId: lead.customerAccountId,
      projectId: lead.projectId,
      leadId: lead.leadId,
      payload: { source: lead.source, created: true },
    });
    return { lead, created: true };
  }

  /**
   * Generic ingest path (HTTP / operator). Provenance is server-assigned and
   * never caller-elevated: MANUAL_ATTESTATION can only produce ATTESTED_*
   * attributions, never CONFIRMED_SALE / CONFIRMED_PAYMENT.
   */
  async appendLeadEvent(
    raw: unknown,
  ): Promise<{ event: LeadEvent; created: boolean }> {
    const input = parseLeadEventIngest(raw);
    return this.appendLeadEventInternal(input, GENERIC_EVENT_API_PROVENANCE);
  }

  /**
   * Trusted-adapter / test seam. Not reachable from the public HTTP ingest
   * schema: only in-process composers (CRM adapters, fixtures) may declare a
   * provenance class other than MANUAL_ATTESTATION.
   */
  async appendLeadEventWithProvenance(
    input: LeadEventIngestInput & { trustProvenance: TrustProvenanceClass },
  ): Promise<{ event: LeadEvent; created: boolean }> {
    const { trustProvenance, ...rest } = input;
    return this.appendLeadEventInternal(
      parseLeadEventIngest(rest),
      trustProvenance,
    );
  }

  private async appendLeadEventInternal(
    input: LeadEventIngestInput,
    trustProvenance: TrustProvenanceClass,
  ): Promise<{ event: LeadEvent; created: boolean }> {
    if (
      trustProvenance === "FAKE_TEST" &&
      !isFakeTestAllowed(this.runtimeEnvironment)
    ) {
      throw new RevenueRecoveryError(
        "PROVENANCE_NOT_PERMITTED",
        "FAKE_TEST lead event provenance is rejected outside the TEST runtime environment",
        { runtimeEnvironment: this.runtimeEnvironment },
      );
    }

    const lead = await this.requireLead(input.leadId);
    this.assertTenant(lead, input.customerAccountId, input.projectId);
    // Canonical persisted lead scope wins over request-body scope.
    const customerAccountId = lead.customerAccountId;
    const projectId = lead.projectId;

    const existing = await this.deps.leadEvents.getBySourceIdentity({
      customerAccountId,
      leadId: input.leadId,
      source: input.source,
      externalEventId: input.externalEventId,
    });
    if (existing) {
      if (existing.kind !== input.kind) {
        throw new RevenueRecoveryError(
          "LEAD_EVENT_CONFLICT",
          "Lead event identity reused with conflicting kind",
        );
      }
      if (existing.trustProvenance !== trustProvenance) {
        throw new RevenueRecoveryError(
          "LEAD_EVENT_CONFLICT",
          "Lead event identity reused with conflicting trust provenance",
          {
            existingProvenance: existing.trustProvenance,
            incomingProvenance: trustProvenance,
          },
        );
      }
      return { event: existing, created: false };
    }

    const now = this.deps.nowIso();
    const event: LeadEvent = {
      ...input,
      customerAccountId,
      projectId,
      eventId: newLeadEventId({
        customerAccountId,
        leadId: input.leadId,
        source: input.source,
        externalEventId: input.externalEventId,
      }),
      trustProvenance,
      recordRevision: 1,
      recordedAt: now,
    };
    await this.deps.leadEvents.append(event);

    const openCases = await this.deps.cases.listOpenByLead(lead.leadId);
    for (const recoveryCase of openCases) {
      await this.refreshCaseFromEvents(recoveryCase.recoveryCaseId);
    }

    if (input.kind === "INBOUND_MESSAGE") {
      await this.audit({
        kind: "RECOVERY_RESPONSE_RECEIVED",
        customerAccountId,
        projectId,
        leadId: input.leadId,
        recoveryCaseId: openCases[0]?.recoveryCaseId,
      });
    }
    if (input.kind === "APPOINTMENT_BOOKED") {
      await this.audit({
        kind: "RECOVERY_APPOINTMENT_BOOKED",
        customerAccountId,
        projectId,
        leadId: input.leadId,
        recoveryCaseId: openCases[0]?.recoveryCaseId,
      });
    }
    if (input.kind === "SALE_RECORDED") {
      await this.audit({
        kind: "RECOVERY_SALE_RECORDED",
        customerAccountId,
        projectId,
        leadId: input.leadId,
        recoveryCaseId: openCases[0]?.recoveryCaseId,
        payload: {
          amount: input.amount ?? null,
          trustProvenance,
        },
      });
    }

    return { event, created: true };
  }

  async detectAndOpenRecoveryCase(input: {
    leadId: string;
    customerAccountId: string;
    projectId: string;
  }): Promise<{
    gap: ReturnType<typeof detectResponseGap>;
    recoveryCase: RecoveryCase | null;
  }> {
    const lead = await this.requireLead(input.leadId);
    this.assertTenant(lead, input.customerAccountId, input.projectId);
    const config = await this.deps.configs.getLatest({
      customerAccountId: input.customerAccountId,
      projectId: input.projectId,
    });
    const events = await this.deps.leadEvents.listByLead(lead.leadId);
    const gap = detectResponseGap({
      lead,
      events,
      config,
      nowIso: this.deps.nowIso(),
    });
    if (!gap.eligible || !gap.gapIdentityKey || !gap.gapDetectedAt || !config) {
      return { gap, recoveryCase: null };
    }

    const existing = await this.deps.cases.getByGapIdentity(gap.gapIdentityKey);
    if (existing) {
      return { gap, recoveryCase: existing };
    }

    const open = await this.deps.cases.listOpenByLead(lead.leadId);
    if (open.length > 0) {
      throw new RevenueRecoveryError(
        "RECOVERY_CASE_ALREADY_OPEN",
        "Lead already has an open recovery case",
        { recoveryCaseId: open[0]!.recoveryCaseId },
      );
    }

    const now = this.deps.nowIso();
    const recoveryCase: RecoveryCase = {
      recoveryCaseId: newRecoveryCaseId(gap.gapIdentityKey),
      gapIdentityKey: gap.gapIdentityKey,
      leadId: lead.leadId,
      customerAccountId: lead.customerAccountId,
      projectId: lead.projectId,
      gapDetectedAt: gap.gapDetectedAt,
      reasonCode: gap.reasonCode,
      estimatedRecoverableValue: lead.estimatedValue,
      currency: lead.currency ?? config.currency,
      status: "OPEN",
      configId: config.configId,
      configVersion: config.configVersion,
      configFingerprint: config.configFingerprint,
      createdAt: now,
      updatedAt: now,
      recordRevision: 1,
    };
    await this.deps.cases.save(recoveryCase);
    await this.audit({
      kind: "RESPONSE_GAP_DETECTED",
      customerAccountId: lead.customerAccountId,
      projectId: lead.projectId,
      leadId: lead.leadId,
      recoveryCaseId: recoveryCase.recoveryCaseId,
      payload: { thresholdMinutes: gap.thresholdMinutes ?? null },
    });
    await this.audit({
      kind: "RECOVERY_CASE_OPENED",
      customerAccountId: lead.customerAccountId,
      projectId: lead.projectId,
      leadId: lead.leadId,
      recoveryCaseId: recoveryCase.recoveryCaseId,
    });
    return { gap, recoveryCase };
  }

  async evaluateCaseContactPolicy(recoveryCaseId: string) {
    const recoveryCase = await this.requireCase(recoveryCaseId);
    const lead = await this.requireLead(recoveryCase.leadId);
    const config = await this.requireConfigVersion(recoveryCase);
    const events = await this.deps.leadEvents.listByLead(lead.leadId);
    const attempts = await this.deps.attempts.listByCase(recoveryCaseId);
    return evaluateContactPolicy({
      lead,
      events,
      attempts,
      config,
      nowIso: this.deps.nowIso(),
      gapDetectedAt: recoveryCase.gapDetectedAt,
      // Time-of-action law: a response, appointment, conversion, or an inactive
      // case stops further outreach even after approval.
      suppressFollowUpOnResponse: true,
      caseStatus: recoveryCase.status,
    });
  }

  async prepareRecoveryObjective(input: {
    recoveryCaseId: string;
    requesterId: string;
    requestedEnvironment: string;
    admit?: boolean;
  }): Promise<{
    admissionRequest: AdmissionRequest;
    planningContext: Record<string, unknown>;
    contactPolicy: Awaited<ReturnType<typeof evaluateContactPolicy>>;
    admissionResult?: unknown;
  }> {
    const recoveryCase = await this.requireCase(input.recoveryCaseId);
    if (recoveryCase.status === "SUPPRESSED") {
      throw new RevenueRecoveryError(
        "RECOVERY_SUPPRESSED",
        "Recovery case is suppressed",
      );
    }
    const lead = await this.requireLead(recoveryCase.leadId);
    const config = await this.requireConfigVersion(recoveryCase);
    const contactPolicy = await this.evaluateCaseContactPolicy(
      recoveryCase.recoveryCaseId,
    );
    const attempts = await this.deps.attempts.listByCase(
      recoveryCase.recoveryCaseId,
    );
    const objectiveVersion = recoveryCase.recoveryObjectiveVersion ?? 1;
    const admissionRequest = mapRecoveryCaseToAdmissionRequest({
      recoveryCase,
      lead,
      config,
      contactPolicy,
      requesterId: input.requesterId,
      requestedEnvironment: input.requestedEnvironment,
      submittedAt: this.deps.nowIso(),
      objectiveVersion,
    });
    const planningContext = recoveryPlanningContext({
      lead,
      recoveryCase,
      config,
      contactPolicy,
      priorAttemptCount: attempts.length,
    });

    let admissionResult: unknown;
    if (input.admit) {
      if (!this.deps.admission) {
        throw new RevenueRecoveryError(
          "RECOVERY_STATE_CONFLICT",
          "Objective admission service not configured",
        );
      }
      admissionResult = await this.deps.admission.admit(admissionRequest);
      const runId =
        admissionResult &&
        typeof admissionResult === "object" &&
        "runId" in admissionResult
          ? String((admissionResult as { runId: string }).runId)
          : undefined;
      await this.deps.cases.save({
        ...recoveryCase,
        status: "IN_ORCHESTRATION",
        objectiveId: admissionRequest.objectiveId,
        recoveryObjectiveVersion: objectiveVersion,
        ...(runId ? { orchestratorRunId: runId } : {}),
        updatedAt: this.deps.nowIso(),
        recordRevision: recoveryCase.recordRevision + 1,
      });
      await this.audit({
        kind: "RECOVERY_OBJECTIVE_ADMITTED",
        customerAccountId: recoveryCase.customerAccountId,
        projectId: recoveryCase.projectId,
        leadId: recoveryCase.leadId,
        recoveryCaseId: recoveryCase.recoveryCaseId,
        payload: { runId: runId ?? null },
      });
    } else {
      await this.deps.cases.save({
        ...recoveryCase,
        status: "READY_FOR_ORCHESTRATION",
        objectiveId: admissionRequest.objectiveId,
        recoveryObjectiveVersion: objectiveVersion,
        updatedAt: this.deps.nowIso(),
        recordRevision: recoveryCase.recordRevision + 1,
      });
    }

    return { admissionRequest, planningContext, contactPolicy, admissionResult };
  }

  /**
   * Phase7-only domain actuation of bounded recovery outreach.
   *
   * CALLER ASSERTION != AUTHORIZATION. This method takes no authorization
   * argument and checks none: the canonical chain (Phase6 AuthorizationRecord
   * → Phase7 readiness → preflight → SafeActuator) must already have proven
   * authority before the product actuator reaches here. It re-proves only what
   * is domain truth at time-of-action: suppression, contact policy, target
   * containment, template binding, and step idempotency.
   */
  async actuateRecoveryOutreachFromPhase7(input: {
    actionType:
      | "SEND_RECOVERY_SMS"
      | "SEND_RECOVERY_EMAIL"
      | "CREATE_CALLBACK_TASK";
    args: {
      recoveryCaseId: string;
      leadId: string;
      templateId?: string | undefined;
      templateVersion?: number | undefined;
      note?: string | undefined;
    };
    runId: string;
    executionAttemptId: string;
    stepId: string;
    stepIdempotencyKey: string;
  }): Promise<{ attempt: RecoveryAttempt; replayed: boolean }> {
    const executionActionIdentity = recoveryExecutionActionIdentity({
      executionAttemptId: input.executionAttemptId,
      stepIdempotencyKey: input.stepIdempotencyKey,
      actionType: input.actionType,
    });

    const replayed = await this.deps.attempts.getByExecutionActionIdentity(
      executionActionIdentity,
    );
    if (replayed) {
      if (
        replayed.recoveryCaseId !== input.args.recoveryCaseId ||
        replayed.leadId !== input.args.leadId
      ) {
        throw new RevenueRecoveryError(
          "EXECUTION_ACTION_CONFLICT",
          "Execution action identity reused with a different material target",
          {
            executionActionIdentity,
            existingRecoveryCaseId: replayed.recoveryCaseId,
            existingLeadId: replayed.leadId,
          },
        );
      }
      // One authorized step yields at most one outreach: no provider call.
      return { attempt: replayed, replayed: true };
    }

    const recoveryCase = await this.requireCase(input.args.recoveryCaseId);
    if (recoveryCase.status === "SUPPRESSED") {
      throw new RevenueRecoveryError(
        "RECOVERY_SUPPRESSED",
        "Cannot send outreach on suppressed recovery case",
      );
    }
    const lead = await this.requireLead(input.args.leadId);
    if (
      lead.leadId !== recoveryCase.leadId ||
      input.args.leadId !== recoveryCase.leadId
    ) {
      throw new RevenueRecoveryError(
        "RECOVERY_ACTION_TARGET_MISMATCH",
        "Action leadId does not match the recovery case lead",
        { leadId: input.args.leadId, caseLeadId: recoveryCase.leadId },
      );
    }
    this.assertTenant(
      lead,
      recoveryCase.customerAccountId,
      recoveryCase.projectId,
    );
    const config = await this.requireConfigVersion(recoveryCase);

    let template: RecoveryMessageTemplate | undefined;
    if (input.actionType !== "CREATE_CALLBACK_TASK") {
      template = await this.requireBoundTemplate({
        recoveryCase,
        templateId: input.args.templateId,
        templateVersion: input.args.templateVersion,
      });
    }

    const policy = await this.evaluateCaseContactPolicy(
      recoveryCase.recoveryCaseId,
    );
    if (!policy.eligible) {
      throw new RevenueRecoveryError(
        policy.reasonCodes.includes("CONTACT_WINDOW_CLOSED")
          ? "CONTACT_WINDOW_CLOSED"
          : "CONTACT_NOT_PERMITTED",
        "Contact policy denied outreach at time of actuation",
        { reasonCodes: policy.reasonCodes },
      );
    }

    const now = this.deps.nowIso();
    const templateValues: Record<string, string> = {
      firstName: lead.firstName ?? "",
      lastName: lead.lastName ?? "",
      businessName: config.businessName,
      serviceRequested: lead.serviceRequested ?? "",
      serviceArea: lead.serviceArea ?? "",
      bookingLink: config.bookingLink ?? "",
    };

    let channel: RecoveryAttempt["channel"];
    let recipientRef: string;
    let delivery;

    if (input.actionType === "SEND_RECOVERY_SMS") {
      // Recipient resolves from the canonical lead only — never from the plan.
      if (!lead.phone) {
        throw new RevenueRecoveryError(
          "RECOVERY_ACTION_TARGET_MISMATCH",
          "Canonical lead has no phone for SMS outreach",
        );
      }
      this.assertChannelPermitted(policy, "SMS");
      channel = "SMS";
      recipientRef = maskPhone(lead.phone) ?? "phone";
      delivery = await this.deps.messaging.sendSms({
        action: SendRecoverySmsSchema.parse({
          actionType: "SEND_RECOVERY_SMS",
          recoveryCaseId: recoveryCase.recoveryCaseId,
          leadId: lead.leadId,
          recipientPhone: lead.phone,
          templateId: template!.templateId,
          templateVersion: template!.version,
          renderedMessage: this.renderBoundedMessage(template!, templateValues),
        }),
        nowIso: now,
      });
    } else if (input.actionType === "SEND_RECOVERY_EMAIL") {
      if (!lead.email) {
        throw new RevenueRecoveryError(
          "RECOVERY_ACTION_TARGET_MISMATCH",
          "Canonical lead has no email for email outreach",
        );
      }
      this.assertChannelPermitted(policy, "EMAIL");
      channel = "EMAIL";
      recipientRef = maskEmail(lead.email) ?? "email";
      delivery = await this.deps.messaging.sendEmail({
        action: SendRecoveryEmailSchema.parse({
          actionType: "SEND_RECOVERY_EMAIL",
          recoveryCaseId: recoveryCase.recoveryCaseId,
          leadId: lead.leadId,
          recipientEmail: lead.email,
          templateId: template!.templateId,
          templateVersion: template!.version,
          renderedSubject: `${config.businessName} — following up on your request`.slice(
            0,
            200,
          ),
          renderedMessage: this.renderBoundedMessage(template!, templateValues),
        }),
        nowIso: now,
      });
    } else {
      if (!lead.phone) {
        throw new RevenueRecoveryError(
          "RECOVERY_ACTION_TARGET_MISMATCH",
          "Canonical lead has no phone for a callback task",
        );
      }
      this.assertChannelPermitted(policy, "CALL_TASK");
      channel = "CALL_TASK";
      recipientRef = maskPhone(lead.phone) ?? "phone";
      delivery = await this.deps.messaging.createCallbackTask({
        action: CreateCallbackTaskSchema.parse({
          actionType: "CREATE_CALLBACK_TASK",
          recoveryCaseId: recoveryCase.recoveryCaseId,
          leadId: lead.leadId,
          recipientPhone: lead.phone,
          ...(input.args.note ? { note: input.args.note } : {}),
        }),
        nowIso: now,
      });
    }

    const attempt: RecoveryAttempt = {
      attemptId: newRecoveryAttemptId(executionActionIdentity),
      recoveryCaseId: recoveryCase.recoveryCaseId,
      customerAccountId: recoveryCase.customerAccountId,
      projectId: recoveryCase.projectId,
      leadId: lead.leadId,
      runId: input.runId,
      executionAttemptId: input.executionAttemptId,
      stepId: input.stepId,
      executionActionIdentity,
      providerIdempotencyKey: executionActionIdentity,
      channel,
      ...(template
        ? { templateId: template.templateId, templateVersion: template.version }
        : {}),
      recipientRef,
      sentAt: now,
      deliveryOutcome: delivery.outcome,
      providerMessageId: delivery.providerMessageId,
      recordRevision: 1,
    };
    await this.deps.attempts.save(attempt);
    await this.appendLeadEventInternal(
      {
        customerAccountId: lead.customerAccountId,
        projectId: lead.projectId,
        leadId: lead.leadId,
        kind: "OUTBOUND_ATTEMPT",
        occurredAt: now,
        externalEventId: `attempt:${attempt.attemptId}`,
        source: "RECOVERY_ENGINE",
        channel: channel === "CALL_TASK" ? "CALL" : channel,
        recoveryAttemptId: attempt.attemptId,
      },
      ENGINE_OPERATIONAL_EVENT_PROVENANCE,
    );
    await this.audit({
      kind: "RECOVERY_ATTEMPT_SENT",
      customerAccountId: recoveryCase.customerAccountId,
      projectId: recoveryCase.projectId,
      leadId: lead.leadId,
      recoveryCaseId: recoveryCase.recoveryCaseId,
      payload: {
        channel,
        attemptId: attempt.attemptId,
        runId: input.runId,
        executionAttemptId: input.executionAttemptId,
        stepId: input.stepId,
      },
    });
    return { attempt, replayed: false };
  }

  async attributeFromEvent(input: {
    recoveryCaseId: string;
    eventId: string;
  }): Promise<RevenueAttribution> {
    const recoveryCase = await this.requireCase(input.recoveryCaseId);
    const config = await this.requireConfigVersion(recoveryCase);
    const event = await this.deps.leadEvents.getById(input.eventId);
    if (!event || event.leadId !== recoveryCase.leadId) {
      throw new RevenueRecoveryError(
        "ATTRIBUTION_INVALID",
        "Source event not found for recovery case",
      );
    }
    const events = await this.deps.leadEvents.listByLead(recoveryCase.leadId);
    const engagement = events.find(
      (e) => e.kind === "INBOUND_MESSAGE" || e.kind === "CALL_CONNECTED",
    );
    const engagementAt =
      engagement?.occurredAt ?? recoveryCase.gapDetectedAt;
    if (
      !withinAttributionWindow({
        engagementAt,
        eventAt: event.occurredAt,
        windowDays: config.attributionWindowDays,
      })
    ) {
      throw new RevenueRecoveryError(
        "ATTRIBUTION_INVALID",
        "Event outside attribution window",
      );
    }

    if (
      event.kind !== "APPOINTMENT_BOOKED" &&
      event.kind !== "SALE_RECORDED" &&
      event.kind !== "PAYMENT_RECORDED"
    ) {
      throw new RevenueRecoveryError(
        "ATTRIBUTION_INVALID",
        `Event kind ${event.kind} is not attributable`,
      );
    }

    // EVENT KIND != TRUST PROVENANCE. Confidence is derived from the
    // server-assigned provenance class, never from the caller's event label.
    const resolved = resolveConfidenceFromProvenance({
      eventKind: event.kind,
      trustProvenance: event.trustProvenance,
      runtimeEnvironment: this.runtimeEnvironment,
    });
    if ("deny" in resolved) {
      throw new RevenueRecoveryError("ATTRIBUTION_INVALID", resolved.reason, {
        eventKind: event.kind,
        trustProvenance: event.trustProvenance,
        runtimeEnvironment: this.runtimeEnvironment,
      });
    }
    const { attributionType, confidenceClass } = resolved;
    const amount =
      event.kind === "APPOINTMENT_BOOKED"
        ? (event.amount ?? recoveryCase.estimatedRecoverableValue ?? 0)
        : (event.amount ?? 0);
    if (amount < 0) {
      throw new RevenueRecoveryError(
        "ATTRIBUTION_INVALID",
        "Attribution amount must be non-negative",
      );
    }

    const attribution: RevenueAttribution = {
      attributionId: newAttributionId({
        recoveryCaseId: recoveryCase.recoveryCaseId,
        sourceEventId: event.eventId,
        attributionType,
      }),
      recoveryCaseId: recoveryCase.recoveryCaseId,
      leadId: recoveryCase.leadId,
      customerAccountId: recoveryCase.customerAccountId,
      projectId: recoveryCase.projectId,
      attributionType,
      amount,
      currency: event.currency ?? recoveryCase.currency ?? config.currency,
      sourceEventId: event.eventId,
      sourceIdentity: event.source,
      trustProvenance: event.trustProvenance,
      confidenceClass,
      attributionWindowDays: config.attributionWindowDays,
      attributionRuleVersion: ATTRIBUTION_RULE_VERSION,
      attributedAt: this.deps.nowIso(),
      recordRevision: 1,
    };
    await this.deps.attributions.save(attribution);
    await this.audit({
      kind: "RECOVERED_REVENUE_ATTRIBUTED",
      customerAccountId: recoveryCase.customerAccountId,
      projectId: recoveryCase.projectId,
      leadId: recoveryCase.leadId,
      recoveryCaseId: recoveryCase.recoveryCaseId,
      payload: {
        attributionType,
        confidenceClass,
        amount,
        sourceIdentity: event.source,
        trustProvenance: event.trustProvenance,
      },
    });
    return attribution;
  }

  async sealRecoveryRecord(input: {
    recoveryCaseId: string;
    completionRecordId?: string;
  }): Promise<RevenueRecoveryRecord> {
    const existing = await this.deps.records.getByCase(input.recoveryCaseId);
    if (existing) {
      throw new RevenueRecoveryError(
        "RECOVERY_RECORD_CONFLICT",
        "Recovery record already sealed",
      );
    }
    const recoveryCase = await this.requireCase(input.recoveryCaseId);
    const events = await this.deps.leadEvents.listByLead(recoveryCase.leadId);
    const attempts = await this.deps.attempts.listByCase(input.recoveryCaseId);
    const attributions = await this.deps.attributions.listByCase(
      input.recoveryCaseId,
    );
    const { outcome } = evaluateRecoveryOutcome({ recoveryCase, events });
    const engagement = events.find((e) => e.kind === "INBOUND_MESSAGE");
    const appointment = events.find((e) => e.kind === "APPOINTMENT_BOOKED");
    // Only CONFIRMED_* provenance becomes booked/collected money. Attested
    // values are sealed separately and never promoted.
    const economic = attributions.filter((a) => this.countsAsEconomics(a));
    const sale = economic.find(isConfirmedBookedAttribution);
    const payment = economic.find(isConfirmedCollectedAttribution);
    const attested = economic.filter(isAttestedAttribution);
    const currency =
      recoveryCase.currency ?? sale?.currency ?? payment?.currency ?? "USD";
    const draft: Omit<RevenueRecoveryRecord, "recordHash"> = {
      recoveryRecordId: newRecoveryRecordId(recoveryCase.recoveryCaseId),
      recoveryCaseId: recoveryCase.recoveryCaseId,
      leadId: recoveryCase.leadId,
      customerAccountId: recoveryCase.customerAccountId,
      projectId: recoveryCase.projectId,
      ...(recoveryCase.orchestratorRunId
        ? { orchestratorRunId: recoveryCase.orchestratorRunId }
        : {}),
      ...(input.completionRecordId
        ? { completionRecordId: input.completionRecordId }
        : {}),
      initialGapDetectedAt: recoveryCase.gapDetectedAt,
      outreachAttemptIds: attempts.map((a) => a.attemptId),
      ...(engagement ? { engagementEventId: engagement.eventId } : {}),
      ...(appointment ? { appointmentEventId: appointment.eventId } : {}),
      ...(sale ? { saleAttributionId: sale.attributionId } : {}),
      ...(payment ? { paymentAttributionId: payment.attributionId } : {}),
      estimatedRecoverableValue: recoveryCase.estimatedRecoverableValue,
      bookedRecoveredRevenue: sale?.amount,
      confirmedCollectedRevenue: payment?.amount,
      ...(attested.length > 0
        ? {
            operatorAttestedRevenue: attested.reduce(
              (sum, a) => sum + a.amount,
              0,
            ),
          }
        : {}),
      attributionLineage: attributions.map((a) => ({
        attributionId: a.attributionId,
        sourceEventId: a.sourceEventId,
        sourceIdentity: a.sourceIdentity,
        trustProvenance: a.trustProvenance,
        confidenceClass: a.confidenceClass,
        attributionType: a.attributionType,
        amount: a.amount,
        attributionRuleVersion: a.attributionRuleVersion,
      })),
      currency,
      outcome,
      evidenceRefs: [
        ...attempts.map((a) => a.attemptId),
        ...attributions.map((a) => a.attributionId),
      ],
      createdAt: this.deps.nowIso(),
    };
    const record: RevenueRecoveryRecord = {
      ...draft,
      recordHash: computeRecoveryRecordHash(draft),
    };
    await this.deps.records.save(record);
    await this.audit({
      kind: "RECOVERY_CLOSED",
      customerAccountId: recoveryCase.customerAccountId,
      projectId: recoveryCase.projectId,
      leadId: recoveryCase.leadId,
      recoveryCaseId: recoveryCase.recoveryCaseId,
      payload: { outcome, recordHash: record.recordHash },
    });
    return record;
  }

  async getCaseDetail(input: {
    recoveryCaseId: string;
    customerAccountId: string;
    projectId: string;
  }) {
    const recoveryCase = await this.requireCase(input.recoveryCaseId);
    this.assertTenant(
      recoveryCase,
      input.customerAccountId,
      input.projectId,
    );
    const lead = await this.requireLead(recoveryCase.leadId);
    const events = await this.deps.leadEvents.listByLead(lead.leadId);
    const attempts = await this.deps.attempts.listByCase(
      recoveryCase.recoveryCaseId,
    );
    const attributions = await this.deps.attributions.listByCase(
      recoveryCase.recoveryCaseId,
    );
    const record = await this.deps.records.getByCase(
      recoveryCase.recoveryCaseId,
    );
    const contactPolicy = await this.evaluateCaseContactPolicy(
      recoveryCase.recoveryCaseId,
    );
    return {
      doctrine: REVENUE_RECOVERY_DOCTRINE,
      recoveryCase,
      lead: this.sanitizeLead(lead),
      contactPolicy,
      attempts,
      events: events.map((e) => ({
        eventId: e.eventId,
        kind: e.kind,
        occurredAt: e.occurredAt,
        amount: e.amount,
        currency: e.currency,
        channel: e.channel,
      })),
      attributions,
      recoveryRecord: record,
      economics: this.caseEconomics(recoveryCase, attributions),
    };
  }

  /**
   * ESTIMATED != CONFIRMED_SALE != CONFIRMED_PAYMENT.
   * Confirmed totals carry only CONFIRMED_* confidence from provenance that is
   * valid for this runtime environment; operator attestation is reported on its
   * own line and never added to booked or collected money.
   */
  private caseEconomics(
    recoveryCase: RecoveryCase,
    attributions: readonly RevenueAttribution[],
  ) {
    const economic = attributions.filter((a) => this.countsAsEconomics(a));
    const attested = economic.filter(isAttestedAttribution);
    return {
      estimatedRecoverableValue: recoveryCase.estimatedRecoverableValue ?? null,
      bookedRecoveredRevenue:
        economic.find(isConfirmedBookedAttribution)?.amount ?? null,
      confirmedCollectedRevenue:
        economic.find(isConfirmedCollectedAttribution)?.amount ?? null,
      operatorAttestedRevenue:
        attested.length > 0
          ? attested.reduce((sum, a) => sum + a.amount, 0)
          : null,
      excludedNonEconomicAttributions:
        attributions.length - economic.length,
      currency: recoveryCase.currency ?? "USD",
    };
  }

  /**
   * FAKE_TEST attributions are visible in TEST runtimes only. Production,
   * staging, and development economics never display test-minted money.
   */
  private countsAsEconomics(attribution: RevenueAttribution): boolean {
    return (
      attribution.trustProvenance !== "FAKE_TEST" ||
      isFakeTestAllowed(this.runtimeEnvironment)
    );
  }

  async getDashboard(input: {
    customerAccountId: string;
    projectId: string;
  }) {
    const cases = await this.deps.cases.listByProject(input);
    let awaitingApproval = 0;
    let engaged = 0;
    let appointments = 0;
    let confirmedRevenue = 0;
    let bookedRevenue = 0;
    let attestedRevenue = 0;
    let estimatedPipeline = 0;
    for (const c of cases) {
      if (c.status === "IN_ORCHESTRATION") awaitingApproval += 1;
      if (c.status === "ENGAGED") engaged += 1;
      if (c.status === "APPOINTMENT_BOOKED" || c.status === "CONVERTED") {
        appointments += 1;
      }
      estimatedPipeline += c.estimatedRecoverableValue ?? 0;
      const attributions = await this.deps.attributions.listByCase(
        c.recoveryCaseId,
      );
      for (const a of attributions) {
        if (!this.countsAsEconomics(a)) continue;
        if (isConfirmedBookedAttribution(a)) bookedRevenue += a.amount;
        if (isConfirmedCollectedAttribution(a)) confirmedRevenue += a.amount;
        if (isAttestedAttribution(a)) attestedRevenue += a.amount;
      }
    }
    const open = cases.filter((c) =>
      ACTIVE_RECOVERY_CASE_STATUSES.includes(c.status),
    ).length;
    return {
      doctrine: {
        estimatedNotBooked: REVENUE_RECOVERY_DOCTRINE.estimatedNotBooked,
        bookedNotCollected: REVENUE_RECOVERY_DOCTRINE.bookedNotCollected,
        gapNotAuthorization: REVENUE_RECOVERY_DOCTRINE.gapNotAuthorization,
        attestedNotConfirmed: REVENUE_RECOVERY_DOCTRINE.attestedNotConfirmed,
      },
      runtimeEnvironment: this.runtimeEnvironment,
      funnel: {
        openRecoveryCases: open,
        casesAwaitingApproval: awaitingApproval,
        engagedLeads: engaged,
        appointmentsRecovered: appointments,
        confirmedRecoveredRevenue: confirmedRevenue,
        bookedRecoveredRevenue: bookedRevenue,
        operatorAttestedRevenue: attestedRevenue,
        estimatedPipelineRecovered: estimatedPipeline,
      },
      cases: cases.map((c) => ({
        recoveryCaseId: c.recoveryCaseId,
        leadId: c.leadId,
        status: c.status,
        estimatedRecoverableValue: c.estimatedRecoverableValue ?? null,
        currency: c.currency ?? null,
        gapDetectedAt: c.gapDetectedAt,
        orchestratorRunId: c.orchestratorRunId ?? null,
      })),
    };
  }

  /** Helper for tests — render template with allowed variables only. */
  renderApprovedMessage(
    template: RecoveryMessageTemplate,
    values: Record<string, string>,
  ): string {
    return renderTemplate(template.body, template.allowedVariables, values);
  }

  private async requireBoundTemplate(input: {
    recoveryCase: RecoveryCase;
    templateId?: string | undefined;
    templateVersion?: number | undefined;
  }): Promise<RecoveryMessageTemplate> {
    if (!input.templateId || !input.templateVersion) {
      throw new RevenueRecoveryError(
        "TEMPLATE_NOT_FOUND",
        "Outreach send requires a bound templateId and templateVersion",
      );
    }
    const template = await this.deps.templates.get({
      templateId: input.templateId,
      version: input.templateVersion,
    });
    if (!template) {
      throw new RevenueRecoveryError(
        "TEMPLATE_NOT_FOUND",
        `Unknown template ${input.templateId}@${input.templateVersion}`,
      );
    }
    if (!template.enabled) {
      throw new RevenueRecoveryError(
        "TEMPLATE_DISABLED",
        "Bound message template is disabled",
      );
    }
    if (
      template.customerAccountId !== input.recoveryCase.customerAccountId ||
      template.projectId !== input.recoveryCase.projectId
    ) {
      throw new RevenueRecoveryError(
        "TENANT_ISOLATION_VIOLATION",
        "Template belongs to a different customer account or project",
      );
    }
    return template;
  }

  private assertChannelPermitted(
    policy: ContactPolicyResult,
    channel: RecoveryChannel,
  ): void {
    const resolved = policy.channels.find((c) => c.channel === channel);
    if (!resolved?.permitted) {
      throw new RevenueRecoveryError(
        resolved?.reasonCodes.includes("CONTACT_WINDOW_CLOSED")
          ? "CONTACT_WINDOW_CLOSED"
          : "CONTACT_NOT_PERMITTED",
        `${channel} channel not permitted at time of actuation`,
        { reasonCodes: resolved?.reasonCodes ?? ["CHANNEL_NOT_ALLOWED"] },
      );
    }
  }

  private renderBoundedMessage(
    template: RecoveryMessageTemplate,
    values: Record<string, string>,
  ): string {
    const rendered = renderTemplate(
      template.body,
      template.allowedVariables,
      values,
    );
    if (rendered.trim().length === 0) {
      throw new RevenueRecoveryError(
        "TEMPLATE_DISABLED",
        "Bound template rendered an empty message",
        { templateId: template.templateId, version: template.version },
      );
    }
    return rendered;
  }

  private async refreshCaseFromEvents(recoveryCaseId: string): Promise<void> {
    const recoveryCase = await this.requireCase(recoveryCaseId);
    const events = await this.deps.leadEvents.listByLead(recoveryCase.leadId);
    const { nextStatus, suppressionReason } = evaluateRecoveryOutcome({
      recoveryCase,
      events,
    });
    if (nextStatus === recoveryCase.status) return;
    await this.deps.cases.save({
      ...recoveryCase,
      status: nextStatus,
      ...(suppressionReason ? { suppressionReason } : {}),
      updatedAt: this.deps.nowIso(),
      recordRevision: recoveryCase.recordRevision + 1,
    });
  }

  private sanitizeLead(lead: Lead) {
    return {
      leadId: lead.leadId,
      customerAccountId: lead.customerAccountId,
      projectId: lead.projectId,
      externalLeadId: lead.externalLeadId,
      source: lead.source,
      createdAt: lead.createdAt,
      firstName: lead.firstName,
      serviceRequested: lead.serviceRequested,
      serviceArea: lead.serviceArea,
      estimatedValue: lead.estimatedValue,
      currency: lead.currency,
      phoneMasked: maskPhone(lead.phone),
      emailMasked: maskEmail(lead.email),
      hasPhone: Boolean(lead.phone),
      hasEmail: Boolean(lead.email),
      consent: {
        doNotContact: lead.consent?.doNotContact ?? false,
        smsOptIn: lead.consent?.smsOptIn,
        emailOptIn: lead.consent?.emailOptIn,
      },
    };
  }

  private assertTenant(
    row: { customerAccountId: string; projectId: string },
    customerAccountId: string,
    projectId: string,
  ): void {
    if (
      row.customerAccountId !== customerAccountId ||
      row.projectId !== projectId
    ) {
      throw new RevenueRecoveryError(
        "TENANT_ISOLATION_VIOLATION",
        "Cross-tenant access denied",
      );
    }
  }

  private async requireLead(leadId: string): Promise<Lead> {
    const lead = await this.deps.leads.getById(leadId);
    if (!lead) {
      throw new RevenueRecoveryError("LEAD_NOT_FOUND", `Unknown lead ${leadId}`);
    }
    return lead;
  }

  private async requireCase(recoveryCaseId: string): Promise<RecoveryCase> {
    const recoveryCase = await this.deps.cases.getById(recoveryCaseId);
    if (!recoveryCase) {
      throw new RevenueRecoveryError(
        "RECOVERY_CASE_NOT_FOUND",
        `Unknown recovery case ${recoveryCaseId}`,
      );
    }
    return recoveryCase;
  }

  private async requireConfigVersion(
    recoveryCase: RecoveryCase,
  ): Promise<RecoveryConfiguration> {
    const config = await this.deps.configs.getByVersion({
      customerAccountId: recoveryCase.customerAccountId,
      projectId: recoveryCase.projectId,
      configVersion: recoveryCase.configVersion,
    });
    if (!config) {
      throw new RevenueRecoveryError(
        "RECOVERY_CONFIG_MISSING",
        "Bound recovery configuration version not found",
      );
    }
    return config;
  }

  private async audit(
    input: Omit<ProductAuditEvent, "eventId" | "occurredAt"> & {
      occurredAt?: string;
    },
  ): Promise<void> {
    const occurredAt = input.occurredAt ?? this.deps.nowIso();
    await this.deps.audits.append({
      eventId: newAuditEventId({
        kind: input.kind,
        occurredAt,
        ...(input.recoveryCaseId
          ? { recoveryCaseId: input.recoveryCaseId }
          : {}),
        ...(input.leadId ? { leadId: input.leadId } : {}),
      }),
      kind: input.kind,
      customerAccountId: input.customerAccountId,
      projectId: input.projectId,
      ...(input.leadId ? { leadId: input.leadId } : {}),
      ...(input.recoveryCaseId ? { recoveryCaseId: input.recoveryCaseId } : {}),
      occurredAt,
      ...(input.payload ? { payload: input.payload } : {}),
    });
  }
}
