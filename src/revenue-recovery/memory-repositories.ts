import { parseLead, type Lead } from "./lead.js";
import { parseLeadEvent, type LeadEvent } from "./recovery-event.js";
import { parseRecoveryCase, type RecoveryCase } from "./recovery-case.js";
import {
  parseRecoveryConfiguration,
  type RecoveryConfiguration,
} from "./recovery-config.js";
import { parseRecoveryAttempt, type RecoveryAttempt } from "./recovery-attempt.js";
import {
  parseRevenueAttribution,
  type RevenueAttribution,
} from "./revenue-attribution.js";
import {
  parseRevenueRecoveryRecord,
  type RevenueRecoveryRecord,
} from "./recovery-record.js";
import {
  parseRecoveryMessageTemplate,
  type RecoveryMessageTemplate,
} from "./recovery-template.js";
import type { ProductAuditEvent } from "./audit.js";
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
import type { RecoveryProviderEventRepository } from "./provider-events.js";
import {
  parseRecoveryProviderEvent,
  type RecoveryProviderEvent,
} from "./provider-events.js";

export class InMemoryLeadRepository implements LeadRepository {
  private readonly byId = new Map<string, Lead>();
  private readonly bySource = new Map<string, string>();

  async getById(leadId: string): Promise<Lead | null> {
    return this.byId.get(leadId) ?? null;
  }

  async getBySourceIdentity(input: {
    customerAccountId: string;
    source: string;
    externalLeadId: string;
  }): Promise<Lead | null> {
    const key = `${input.customerAccountId}|${input.source}|${input.externalLeadId}`;
    const id = this.bySource.get(key);
    return id ? (this.byId.get(id) ?? null) : null;
  }

  async save(lead: Lead): Promise<void> {
    const parsed = parseLead(lead);
    this.byId.set(parsed.leadId, parsed);
    this.bySource.set(
      `${parsed.customerAccountId}|${parsed.source}|${parsed.externalLeadId}`,
      parsed.leadId,
    );
  }

  async listByProject(input: {
    customerAccountId: string;
    projectId: string;
  }): Promise<readonly Lead[]> {
    return [...this.byId.values()].filter(
      (l) =>
        l.customerAccountId === input.customerAccountId &&
        l.projectId === input.projectId,
    );
  }
}

export class InMemoryLeadEventRepository implements LeadEventRepository {
  private readonly byId = new Map<string, LeadEvent>();
  private readonly bySource = new Map<string, string>();
  private readonly byLead = new Map<string, string[]>();

  async getById(eventId: string): Promise<LeadEvent | null> {
    return this.byId.get(eventId) ?? null;
  }

  async getBySourceIdentity(input: {
    customerAccountId: string;
    leadId: string;
    source: string;
    externalEventId: string;
  }): Promise<LeadEvent | null> {
    const key = `${input.customerAccountId}|${input.leadId}|${input.source}|${input.externalEventId}`;
    const id = this.bySource.get(key);
    return id ? (this.byId.get(id) ?? null) : null;
  }

  async append(event: LeadEvent): Promise<void> {
    const parsed = parseLeadEvent(event);
    this.byId.set(parsed.eventId, parsed);
    this.bySource.set(
      `${parsed.customerAccountId}|${parsed.leadId}|${parsed.source}|${parsed.externalEventId}`,
      parsed.eventId,
    );
    const list = this.byLead.get(parsed.leadId) ?? [];
    list.push(parsed.eventId);
    this.byLead.set(parsed.leadId, list);
  }

  async listByLead(leadId: string): Promise<readonly LeadEvent[]> {
    const ids = this.byLead.get(leadId) ?? [];
    return ids
      .map((id) => this.byId.get(id)!)
      .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  }
}

export class InMemoryRecoveryCaseRepository implements RecoveryCaseRepository {
  private readonly byId = new Map<string, RecoveryCase>();
  private readonly byGap = new Map<string, string>();

  async getById(recoveryCaseId: string): Promise<RecoveryCase | null> {
    return this.byId.get(recoveryCaseId) ?? null;
  }

  async getByGapIdentity(gapIdentityKey: string): Promise<RecoveryCase | null> {
    const id = this.byGap.get(gapIdentityKey);
    return id ? (this.byId.get(id) ?? null) : null;
  }

  async listOpenByLead(leadId: string): Promise<readonly RecoveryCase[]> {
    return [...this.byId.values()].filter(
      (c) =>
        c.leadId === leadId &&
        !["CLOSED_UNRECOVERED", "SUPPRESSED", "CONVERTED"].includes(c.status),
    );
  }

  async listByProject(input: {
    customerAccountId: string;
    projectId: string;
  }): Promise<readonly RecoveryCase[]> {
    return [...this.byId.values()].filter(
      (c) =>
        c.customerAccountId === input.customerAccountId &&
        c.projectId === input.projectId,
    );
  }

  async save(recoveryCase: RecoveryCase): Promise<void> {
    const parsed = parseRecoveryCase(recoveryCase);
    this.byId.set(parsed.recoveryCaseId, parsed);
    this.byGap.set(parsed.gapIdentityKey, parsed.recoveryCaseId);
  }
}

export class InMemoryRecoveryConfigRepository
  implements RecoveryConfigRepository
{
  private readonly rows: RecoveryConfiguration[] = [];

  async getLatest(input: {
    customerAccountId: string;
    projectId: string;
  }): Promise<RecoveryConfiguration | null> {
    const matches = this.rows.filter(
      (c) =>
        c.customerAccountId === input.customerAccountId &&
        c.projectId === input.projectId,
    );
    return (
      matches.sort((a, b) => b.configVersion - a.configVersion)[0] ?? null
    );
  }

  async getByVersion(input: {
    customerAccountId: string;
    projectId: string;
    configVersion: number;
  }): Promise<RecoveryConfiguration | null> {
    return (
      this.rows.find(
        (c) =>
          c.customerAccountId === input.customerAccountId &&
          c.projectId === input.projectId &&
          c.configVersion === input.configVersion,
      ) ?? null
    );
  }

  async save(config: RecoveryConfiguration): Promise<void> {
    this.rows.push(parseRecoveryConfiguration(config));
  }
}

export class InMemoryRecoveryAttemptRepository
  implements RecoveryAttemptRepository
{
  private readonly byId = new Map<string, RecoveryAttempt>();
  private readonly byExecutionActionIdentity = new Map<string, string>();
  private readonly byProviderMessageId = new Map<string, string>();

  async getById(attemptId: string): Promise<RecoveryAttempt | null> {
    return this.byId.get(attemptId) ?? null;
  }

  async getByExecutionActionIdentity(
    identity: string,
  ): Promise<RecoveryAttempt | null> {
    const id = this.byExecutionActionIdentity.get(identity);
    return id ? (this.byId.get(id) ?? null) : null;
  }

  async getByProviderMessageId(
    providerMessageId: string,
  ): Promise<RecoveryAttempt | null> {
    const id = this.byProviderMessageId.get(providerMessageId);
    return id ? (this.byId.get(id) ?? null) : null;
  }

  async listByCase(recoveryCaseId: string): Promise<readonly RecoveryAttempt[]> {
    return [...this.byId.values()]
      .filter((a) => a.recoveryCaseId === recoveryCaseId)
      .sort((a, b) => a.sentAt.localeCompare(b.sentAt));
  }

  async save(attempt: RecoveryAttempt): Promise<void> {
    const parsed = parseRecoveryAttempt(attempt);
    this.byId.set(parsed.attemptId, parsed);
    this.byExecutionActionIdentity.set(
      parsed.executionActionIdentity,
      parsed.attemptId,
    );
    if (parsed.providerMessageId) {
      this.byProviderMessageId.set(parsed.providerMessageId, parsed.attemptId);
    }
  }
}

export class InMemoryRevenueAttributionRepository
  implements RevenueAttributionRepository
{
  private readonly byId = new Map<string, RevenueAttribution>();

  async getById(attributionId: string): Promise<RevenueAttribution | null> {
    return this.byId.get(attributionId) ?? null;
  }

  async listByCase(
    recoveryCaseId: string,
  ): Promise<readonly RevenueAttribution[]> {
    return [...this.byId.values()].filter(
      (a) => a.recoveryCaseId === recoveryCaseId,
    );
  }

  async save(attribution: RevenueAttribution): Promise<void> {
    this.byId.set(
      attribution.attributionId,
      parseRevenueAttribution(attribution),
    );
  }
}

export class InMemoryRevenueRecoveryRecordRepository
  implements RevenueRecoveryRecordRepository
{
  private readonly byCase = new Map<string, RevenueRecoveryRecord>();

  async getByCase(
    recoveryCaseId: string,
  ): Promise<RevenueRecoveryRecord | null> {
    return this.byCase.get(recoveryCaseId) ?? null;
  }

  async save(record: RevenueRecoveryRecord): Promise<void> {
    this.byCase.set(
      record.recoveryCaseId,
      parseRevenueRecoveryRecord(record),
    );
  }
}

export class InMemoryRecoveryTemplateRepository
  implements RecoveryTemplateRepository
{
  private readonly rows: RecoveryMessageTemplate[] = [];

  async get(input: {
    templateId: string;
    version: number;
  }): Promise<RecoveryMessageTemplate | null> {
    return (
      this.rows.find(
        (t) => t.templateId === input.templateId && t.version === input.version,
      ) ?? null
    );
  }

  async listEnabled(input: {
    customerAccountId: string;
    projectId: string;
    channel: "SMS" | "EMAIL";
  }): Promise<readonly RecoveryMessageTemplate[]> {
    return this.rows.filter(
      (t) =>
        t.customerAccountId === input.customerAccountId &&
        t.projectId === input.projectId &&
        t.channel === input.channel &&
        t.enabled,
    );
  }

  async save(template: RecoveryMessageTemplate): Promise<void> {
    this.rows.push(parseRecoveryMessageTemplate(template));
  }
}

export class InMemoryProductAuditRepository implements ProductAuditRepository {
  private readonly rows: ProductAuditEvent[] = [];

  async append(event: ProductAuditEvent): Promise<void> {
    this.rows.push(event);
  }

  async listByCase(
    recoveryCaseId: string,
  ): Promise<readonly ProductAuditEvent[]> {
    return this.rows.filter((e) => e.recoveryCaseId === recoveryCaseId);
  }

  /** Test helper — all audits including web-ingress/Resend product observations. */
  listAll(): readonly ProductAuditEvent[] {
    return [...this.rows];
  }
}

export class InMemoryRecoveryProviderEventRepository
  implements RecoveryProviderEventRepository
{
  private readonly byKey = new Map<string, RecoveryProviderEvent>();

  async getByProviderEventKey(input: {
    providerName: string;
    providerEventKey: string;
  }): Promise<RecoveryProviderEvent | null> {
    return (
      this.byKey.get(`${input.providerName}|${input.providerEventKey}`) ?? null
    );
  }

  async save(event: RecoveryProviderEvent): Promise<void> {
    const parsed = parseRecoveryProviderEvent(event);
    this.byKey.set(
      `${parsed.providerName}|${parsed.providerEventKey}`,
      parsed,
    );
  }
}

export function createInMemoryRevenueRecoveryRepos() {
  return {
    leads: new InMemoryLeadRepository(),
    leadEvents: new InMemoryLeadEventRepository(),
    cases: new InMemoryRecoveryCaseRepository(),
    configs: new InMemoryRecoveryConfigRepository(),
    attempts: new InMemoryRecoveryAttemptRepository(),
    attributions: new InMemoryRevenueAttributionRepository(),
    records: new InMemoryRevenueRecoveryRecordRepository(),
    templates: new InMemoryRecoveryTemplateRepository(),
    audits: new InMemoryProductAuditRepository(),
    providerEvents: new InMemoryRecoveryProviderEventRepository(),
  };
}
