import { FederationError } from "./errors.js";
import {
  FederationAgreementSchema,
  type FederationAgreement,
} from "./agreement.js";
import {
  FederationActivationRecordSchema,
  type FederationActivationRecord,
} from "./agreement-activation.js";
import type { FederationAuditEvent } from "./audit.js";
import {
  FederatedEvidenceEnvelopeSchema,
  type FederatedEvidenceEnvelope,
} from "./evidence-envelope.js";
import {
  FederationParticipationChangeSchema,
  type FederationParticipationChange,
} from "./participation.js";
import {
  FederationRatificationSchema,
  type FederationRatification,
} from "./ratification.js";
import {
  FederatedWorkAcceptanceSchema,
  type FederatedWorkAcceptance,
} from "./work-acceptance.js";
import {
  FederatedWorkIntentSchema,
  type FederatedWorkIntent,
} from "./work-intent.js";
import {
  FederatedMaterializationRecordSchema,
  materializationIdempotencyKey,
  type FederatedMaterializationRecord,
} from "./work-materialization.js";
import type {
  FederationActivationRecordRepository,
  FederationAgreementRepository,
  FederationAuditRepository,
  FederationParticipationChangeRepository,
  FederationRatificationRepository,
  FederatedEvidenceEnvelopeRepository,
  FederatedMaterializationRepository,
  FederatedWorkAcceptanceRepository,
  FederatedWorkIntentRepository,
} from "./repositories.js";

function assertCas(input: {
  entity: string;
  id: string;
  existingStatus: string;
  fromStatus: string;
  existingRevision: number;
  expectedRevision: number;
}): void {
  if (input.existingStatus !== input.fromStatus) {
    throw new FederationError(
      "FEDERATION_CAS_CONFLICT",
      `${input.entity} ${input.id} status mismatch`,
      {
        fromStatus: input.fromStatus,
        actualStatus: input.existingStatus,
      },
    );
  }
  if (input.existingRevision !== input.expectedRevision) {
    throw new FederationError(
      "FEDERATION_CAS_CONFLICT",
      `${input.entity} ${input.id} revision mismatch`,
      {
        expectedRevision: input.expectedRevision,
        actualRevision: input.existingRevision,
      },
    );
  }
}

export class InMemoryFederationAgreementRepository
  implements FederationAgreementRepository
{
  readonly byId = new Map<string, FederationAgreement>();

  async save(agreement: FederationAgreement): Promise<FederationAgreement> {
    const parsed = FederationAgreementSchema.parse(agreement);
    this.byId.set(parsed.agreementId, parsed);
    return parsed;
  }

  async getById(agreementId: string): Promise<FederationAgreement | null> {
    return this.byId.get(agreementId) ?? null;
  }

  async getByFederationId(
    federationId: string,
  ): Promise<FederationAgreement | null> {
    const all = [...this.byId.values()]
      .filter((a) => a.federationId === federationId)
      .sort((a, b) => b.agreementVersion - a.agreementVersion);
    return all[0] ?? null;
  }

  async listByFederation(
    federationId: string,
  ): Promise<FederationAgreement[]> {
    return [...this.byId.values()]
      .filter((a) => a.federationId === federationId)
      .sort((a, b) => a.agreementVersion - b.agreementVersion);
  }

  async getActiveByFederation(
    federationId: string,
  ): Promise<FederationAgreement | null> {
    return (
      [...this.byId.values()].find(
        (a) => a.federationId === federationId && a.status === "ACTIVE",
      ) ?? null
    );
  }

  async transition(
    agreementId: string,
    fromStatus: FederationAgreement["status"],
    expectedRevision: number,
    toStatus: FederationAgreement["status"],
    _updatedAt: string,
    patch?: Partial<FederationAgreement>,
  ): Promise<FederationAgreement> {
    const existing = this.byId.get(agreementId);
    if (!existing) {
      throw new FederationError(
        "FEDERATION_NOT_FOUND",
        `Agreement ${agreementId} not found`,
      );
    }
    assertCas({
      entity: "agreement",
      id: agreementId,
      existingStatus: existing.status,
      fromStatus,
      existingRevision: existing.recordRevision,
      expectedRevision,
    });
    const next = FederationAgreementSchema.parse({
      ...existing,
      ...patch,
      status: toStatus,
      recordRevision: existing.recordRevision + 1,
    });
    this.byId.set(agreementId, next);
    return next;
  }
}

export class InMemoryFederationRatificationRepository
  implements FederationRatificationRepository
{
  readonly byId = new Map<string, FederationRatification>();

  async save(r: FederationRatification): Promise<FederationRatification> {
    const parsed = FederationRatificationSchema.parse(r);
    this.byId.set(parsed.ratificationId, parsed);
    return parsed;
  }

  async getById(
    ratificationId: string,
  ): Promise<FederationRatification | null> {
    return this.byId.get(ratificationId) ?? null;
  }

  async listByAgreement(
    agreementId: string,
  ): Promise<FederationRatification[]> {
    return [...this.byId.values()]
      .filter((r) => r.agreementId === agreementId)
      .sort((a, b) => a.institutionId.localeCompare(b.institutionId));
  }

  async getByAgreementAndInstitution(
    agreementId: string,
    institutionId: string,
  ): Promise<FederationRatification | null> {
    return (
      [...this.byId.values()].find(
        (r) =>
          r.agreementId === agreementId && r.institutionId === institutionId,
      ) ?? null
    );
  }
}

export class InMemoryFederationActivationRecordRepository
  implements FederationActivationRecordRepository
{
  readonly byId = new Map<string, FederationActivationRecord>();
  readonly byAgreement = new Map<string, FederationActivationRecord>();

  async save(
    r: FederationActivationRecord,
  ): Promise<FederationActivationRecord> {
    const parsed = FederationActivationRecordSchema.parse(r);
    const existing = this.byAgreement.get(parsed.agreementId);
    if (
      existing &&
      existing.activationRecordId !== parsed.activationRecordId
    ) {
      throw new FederationError(
        "FEDERATION_CAS_CONFLICT",
        `Activation record already exists for ${parsed.agreementId}`,
      );
    }
    this.byId.set(parsed.activationRecordId, parsed);
    this.byAgreement.set(parsed.agreementId, parsed);
    return parsed;
  }

  async getById(id: string): Promise<FederationActivationRecord | null> {
    return this.byId.get(id) ?? null;
  }

  async getByAgreement(
    agreementId: string,
  ): Promise<FederationActivationRecord | null> {
    return this.byAgreement.get(agreementId) ?? null;
  }
}

export class InMemoryFederationParticipationChangeRepository
  implements FederationParticipationChangeRepository
{
  readonly byId = new Map<string, FederationParticipationChange>();

  async save(
    c: FederationParticipationChange,
  ): Promise<FederationParticipationChange> {
    const parsed = FederationParticipationChangeSchema.parse(c);
    this.byId.set(parsed.changeId, parsed);
    return parsed;
  }

  async listByAgreement(
    agreementId: string,
  ): Promise<FederationParticipationChange[]> {
    return [...this.byId.values()]
      .filter((c) => c.agreementId === agreementId)
      .sort((a, b) => a.effectiveAt.localeCompare(b.effectiveAt));
  }
}

export class InMemoryFederatedWorkIntentRepository
  implements FederatedWorkIntentRepository
{
  readonly byId = new Map<string, FederatedWorkIntent>();

  async save(intent: FederatedWorkIntent): Promise<FederatedWorkIntent> {
    const parsed = FederatedWorkIntentSchema.parse(intent);
    this.byId.set(parsed.intentId, parsed);
    return parsed;
  }

  async getById(intentId: string): Promise<FederatedWorkIntent | null> {
    return this.byId.get(intentId) ?? null;
  }

  async updateStatus(
    intentId: string,
    fromStatus: FederatedWorkIntent["status"],
    toStatus: FederatedWorkIntent["status"],
  ): Promise<FederatedWorkIntent> {
    const existing = this.byId.get(intentId);
    if (!existing) {
      throw new FederationError(
        "FEDERATED_INTENT_INVALID",
        `Intent ${intentId} not found`,
      );
    }
    if (existing.status !== fromStatus) {
      throw new FederationError(
        "FEDERATION_CAS_CONFLICT",
        `Intent ${intentId} status mismatch`,
      );
    }
    const next = FederatedWorkIntentSchema.parse({
      ...existing,
      status: toStatus,
    });
    this.byId.set(intentId, next);
    return next;
  }
}

export class InMemoryFederatedWorkAcceptanceRepository
  implements FederatedWorkAcceptanceRepository
{
  readonly byId = new Map<string, FederatedWorkAcceptance>();
  readonly byIntent = new Map<string, FederatedWorkAcceptance>();

  async save(a: FederatedWorkAcceptance): Promise<FederatedWorkAcceptance> {
    const parsed = FederatedWorkAcceptanceSchema.parse(a);
    this.byId.set(parsed.acceptanceId, parsed);
    this.byIntent.set(parsed.intentId, parsed);
    return parsed;
  }

  async getByIntent(
    intentId: string,
  ): Promise<FederatedWorkAcceptance | null> {
    return this.byIntent.get(intentId) ?? null;
  }
}

export class InMemoryFederatedMaterializationRepository
  implements FederatedMaterializationRepository
{
  readonly byId = new Map<string, FederatedMaterializationRecord>();
  readonly byIntent = new Map<string, FederatedMaterializationRecord>();
  readonly byIdempotency = new Map<string, FederatedMaterializationRecord>();

  async save(
    r: FederatedMaterializationRecord,
  ): Promise<FederatedMaterializationRecord> {
    const parsed = FederatedMaterializationRecordSchema.parse(r);
    const key = materializationIdempotencyKey({
      intentId: parsed.intentId,
      intentHash: parsed.intentHash,
      targetProjectId: parsed.targetProjectId,
      environment: parsed.environment,
    });
    this.byId.set(parsed.materializationId, parsed);
    this.byIntent.set(parsed.intentId, parsed);
    this.byIdempotency.set(key, parsed);
    return parsed;
  }

  async getByIntent(
    intentId: string,
  ): Promise<FederatedMaterializationRecord | null> {
    return this.byIntent.get(intentId) ?? null;
  }

  async getByIdempotencyKey(
    key: string,
  ): Promise<FederatedMaterializationRecord | null> {
    return this.byIdempotency.get(key) ?? null;
  }
}

export class InMemoryFederatedEvidenceEnvelopeRepository
  implements FederatedEvidenceEnvelopeRepository
{
  readonly byId = new Map<string, FederatedEvidenceEnvelope>();

  async save(
    e: FederatedEvidenceEnvelope,
  ): Promise<FederatedEvidenceEnvelope> {
    const parsed = FederatedEvidenceEnvelopeSchema.parse(e);
    this.byId.set(parsed.envelopeId, parsed);
    return parsed;
  }

  async getById(
    envelopeId: string,
  ): Promise<FederatedEvidenceEnvelope | null> {
    return this.byId.get(envelopeId) ?? null;
  }

  async listByDestination(
    destinationInstitutionId: string,
    destinationProjectId: string,
  ): Promise<FederatedEvidenceEnvelope[]> {
    return [...this.byId.values()].filter(
      (e) =>
        e.destinationInstitutionId === destinationInstitutionId &&
        e.destinationProjectId === destinationProjectId,
    );
  }
}

export class InMemoryFederationAuditRepository
  implements FederationAuditRepository
{
  readonly events: FederationAuditEvent[] = [];

  async append(event: FederationAuditEvent): Promise<FederationAuditEvent> {
    this.events.push(event);
    return event;
  }

  async listByFederation(
    federationId: string,
  ): Promise<FederationAuditEvent[]> {
    return this.events.filter((e) => e.federationId === federationId);
  }

  async listByAgreement(agreementId: string): Promise<FederationAuditEvent[]> {
    return this.events.filter((e) => e.agreementId === agreementId);
  }
}
