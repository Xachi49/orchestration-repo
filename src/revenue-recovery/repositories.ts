import type { Lead } from "./lead.js";
import type { LeadEvent } from "./recovery-event.js";
import type { RecoveryCase } from "./recovery-case.js";
import type { RecoveryConfiguration } from "./recovery-config.js";
import type { RecoveryAttempt } from "./recovery-attempt.js";
import type { RevenueAttribution } from "./revenue-attribution.js";
import type { RevenueRecoveryRecord } from "./recovery-record.js";
import type { RecoveryMessageTemplate } from "./recovery-template.js";
import type { ProductAuditEvent } from "./audit.js";

export interface LeadRepository {
  getById(leadId: string): Promise<Lead | null>;
  getBySourceIdentity(input: {
    customerAccountId: string;
    source: string;
    externalLeadId: string;
  }): Promise<Lead | null>;
  save(lead: Lead): Promise<void>;
  listByProject(input: {
    customerAccountId: string;
    projectId: string;
  }): Promise<readonly Lead[]>;
}

export interface LeadEventRepository {
  getById(eventId: string): Promise<LeadEvent | null>;
  getBySourceIdentity(input: {
    customerAccountId: string;
    leadId: string;
    source: string;
    externalEventId: string;
  }): Promise<LeadEvent | null>;
  append(event: LeadEvent): Promise<void>;
  listByLead(leadId: string): Promise<readonly LeadEvent[]>;
}

export interface RecoveryCaseRepository {
  getById(recoveryCaseId: string): Promise<RecoveryCase | null>;
  getByGapIdentity(gapIdentityKey: string): Promise<RecoveryCase | null>;
  listOpenByLead(leadId: string): Promise<readonly RecoveryCase[]>;
  listByProject(input: {
    customerAccountId: string;
    projectId: string;
  }): Promise<readonly RecoveryCase[]>;
  save(recoveryCase: RecoveryCase): Promise<void>;
}

export interface RecoveryConfigRepository {
  getLatest(input: {
    customerAccountId: string;
    projectId: string;
  }): Promise<RecoveryConfiguration | null>;
  getByVersion(input: {
    customerAccountId: string;
    projectId: string;
    configVersion: number;
  }): Promise<RecoveryConfiguration | null>;
  save(config: RecoveryConfiguration): Promise<void>;
}

export interface RecoveryAttemptRepository {
  getById(attemptId: string): Promise<RecoveryAttempt | null>;
  /** Durable Phase7 step identity lookup — the outreach replay key. */
  getByExecutionActionIdentity(
    identity: string,
  ): Promise<RecoveryAttempt | null>;
  listByCase(recoveryCaseId: string): Promise<readonly RecoveryAttempt[]>;
  save(attempt: RecoveryAttempt): Promise<void>;
}

export interface RevenueAttributionRepository {
  getById(attributionId: string): Promise<RevenueAttribution | null>;
  listByCase(recoveryCaseId: string): Promise<readonly RevenueAttribution[]>;
  save(attribution: RevenueAttribution): Promise<void>;
}

export interface RevenueRecoveryRecordRepository {
  getByCase(recoveryCaseId: string): Promise<RevenueRecoveryRecord | null>;
  save(record: RevenueRecoveryRecord): Promise<void>;
}

export interface RecoveryTemplateRepository {
  get(input: {
    templateId: string;
    version: number;
  }): Promise<RecoveryMessageTemplate | null>;
  listEnabled(input: {
    customerAccountId: string;
    projectId: string;
    channel: "SMS" | "EMAIL";
  }): Promise<readonly RecoveryMessageTemplate[]>;
  save(template: RecoveryMessageTemplate): Promise<void>;
}

export interface ProductAuditRepository {
  append(event: ProductAuditEvent): Promise<void>;
  listByCase(recoveryCaseId: string): Promise<readonly ProductAuditEvent[]>;
}
