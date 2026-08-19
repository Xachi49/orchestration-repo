import type { ApprovalRequest } from "../../domain/authorization/index.js";
import { isTerminalApprovalRequestStatus } from "../../domain/authorization/index.js";
import type { ApprovalRequestRepository } from "../../authorization/approval-request-repository.js";
import { AuthorizationError } from "../../authorization/errors.js";
import { hashDecisionNonce } from "../../authorization/decision-card-hasher.js";
import type { AuthorizationCoordinator } from "../../authorization/coordinator.js";
import {
  IngestionFenceSchema,
  type BeginIngestionResult,
  type IngestionFence,
  type RepositoryIngestionCoordinator,
} from "../../ingestion/coordinator.js";
import { IngestionError } from "../../ingestion/errors.js";
import {
  PlanningFenceSchema,
  type BeginPlanningResult,
  type PlanningCoordinator,
  type PlanningFence,
} from "../../planning/coordinator.js";
import { PlanningError } from "../../planning/errors.js";
import {
  ValidationFenceSchema,
  validationFenceKey,
  type BeginValidationResult,
  type ValidationCoordinator,
  type ValidationFence,
  type ValidationFenceKey,
} from "../../validation/coordinator.js";
import { ValidationError } from "../../validation/errors.js";
import { ValidationDecisionClassSchema } from "../../domain/validation/index.js";
import type { z } from "zod";
import {
  ExecutionFenceSchema,
  executionFenceKey,
  type BeginExecutionResult,
  type ExecutionCoordinator,
  type ExecutionFence,
  type ExecutionFenceKey,
  type ExecutionFenceStatus,
} from "../../execution/coordinator.js";
import { ExecutionError } from "../../execution/errors.js";
import {
  parseExecutionResult,
  type ExecutionResult,
} from "../../domain/execution/index.js";
import {
  VerificationFenceSchema,
  verificationFenceKey,
  type BeginVerificationResult,
  type VerificationCoordinator,
  type VerificationFence,
  type VerificationFenceKey,
  type VerificationFenceStatus,
} from "../../verification/coordinator.js";
import { VerificationError } from "../../verification/errors.js";
import {
  parseVerificationResult,
  type VerificationResult,
} from "../../domain/verification/index.js";
import {
  LearningFenceSchema,
  learningFenceKey,
  type BeginLearningResult,
  type LearningCoordinator,
  type LearningFence,
  type LearningFenceKey,
  type LearningFenceStatus,
} from "../../memory/coordinator.js";
import { MemoryError } from "../../memory/errors.js";
import { DurabilityError } from "../../durability/errors.js";
import type { CoordinatorLease } from "../../domain/durability/index.js";
import type { PostgresDatabase } from "./database.js";
import { PostgresJsonDocuments } from "./documents.js";
import { hydrateRecord } from "./hydrate.js";
import type { PostgresLeaseStore } from "./leases.js";
import { PostgresExecutionResultRepository } from "./repositories/phase-stores.js";

const BINDINGS_COLLECTION = "authorization_bindings";
const VERIFICATION_RESULTS_COLLECTION = "verification_results";

function makeOwnerToken(instanceId: string, fenceToken: number): string {
  return `${instanceId}:${fenceToken}`;
}

function parseOwnerToken(instanceId: string, ownerToken: string): number {
  const prefix = `${instanceId}:`;
  if (!ownerToken.startsWith(prefix)) {
    throw new DurabilityError(
      "STALE_FENCE_TOKEN",
      `Owner token does not match instance ${instanceId}`,
    );
  }
  const token = Number(ownerToken.slice(prefix.length));
  if (!Number.isInteger(token) || token < 1) {
    throw new DurabilityError(
      "STALE_FENCE_TOKEN",
      `Invalid fence token in owner token`,
    );
  }
  return token;
}

function isLeaseHeld(error: unknown): boolean {
  return error instanceof DurabilityError && error.code === "LEASE_ALREADY_HELD";
}

function isStaleFence(error: unknown): boolean {
  return error instanceof DurabilityError && error.code === "STALE_FENCE_TOKEN";
}

async function tryAcquire(
  leaseStore: PostgresLeaseStore,
  input: { coordinationKey: string; phase: string; ownerId: string },
): Promise<CoordinatorLease | "HELD"> {
  try {
    return await leaseStore.acquire(input);
  } catch (error) {
    if (isLeaseHeld(error)) {
      return "HELD";
    }
    throw error;
  }
}

async function loadFencePayload<T>(
  db: PostgresDatabase,
  coordinationKey: string,
  parse: (input: unknown) => T,
): Promise<T | null> {
  const result = await db.query<{ payload: unknown }>(
    `SELECT payload FROM coordinator_fences WHERE coordination_key = $1`,
    [coordinationKey],
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return hydrateRecord(parse, row.payload, `coordinator_fences:${coordinationKey}`);
}

async function upsertFence(db: PostgresDatabase, input: {
  coordinationKey: string;
  phase: string;
  runId: string;
  fenceToken: number;
  ownerId: string;
  ownerToken: string;
  status: string;
  payload: unknown;
}): Promise<void> {
  await db.query(
    `INSERT INTO coordinator_fences (
       coordination_key, phase, run_id, fence_token, owner_id, owner_token, status, payload
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
     ON CONFLICT (coordination_key) DO UPDATE
     SET phase = EXCLUDED.phase,
         run_id = EXCLUDED.run_id,
         fence_token = EXCLUDED.fence_token,
         owner_id = EXCLUDED.owner_id,
         owner_token = EXCLUDED.owner_token,
         status = EXCLUDED.status,
         payload = EXCLUDED.payload,
         record_revision = coordinator_fences.record_revision + 1,
         updated_at = NOW()`,
    [
      input.coordinationKey,
      input.phase,
      input.runId,
      input.fenceToken,
      input.ownerId,
      input.ownerToken,
      input.status,
      JSON.stringify(input.payload),
    ],
  );
}

async function updateFenceByOwnerToken<T>(
  db: PostgresDatabase,
  coordinationKey: string,
  ownerToken: string,
  status: string,
  payload: T,
  parse: (input: unknown) => T,
): Promise<T | null> {
  const result = await db.query<{ payload: unknown }>(
    `UPDATE coordinator_fences
     SET status = $3,
         payload = $4::jsonb,
         record_revision = record_revision + 1,
         updated_at = NOW()
     WHERE coordination_key = $1 AND owner_token = $2
     RETURNING payload`,
    [coordinationKey, ownerToken, status, JSON.stringify(payload)],
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return hydrateRecord(parse, row.payload, `coordinator_fences:${coordinationKey}`);
}

function nextAttempt(current: { status: string; attempt: number } | null): number {
  if (!current) {
    return 1;
  }
  if (current.status === "FAILED" || current.status === "IN_PROGRESS") {
    return current.attempt + 1;
  }
  return 1;
}

export class PostgresRepositoryIngestionCoordinator
  implements RepositoryIngestionCoordinator
{
  constructor(
    private readonly db: PostgresDatabase,
    private readonly leaseStore: PostgresLeaseStore,
    private readonly instanceId: string,
  ) {}

  private coordinationKey(runId: string): string {
    return `ingestion:${runId}`;
  }

  async get(runId: string): Promise<IngestionFence | null> {
    return loadFencePayload(
      this.db,
      this.coordinationKey(runId),
      (input) => IngestionFenceSchema.parse(input),
    );
  }

  async begin(runId: string, nowIso: string): Promise<BeginIngestionResult> {
    return this.db.withTransaction(async () => {
      const current = await this.get(runId);
      if (current?.status === "VERIFIED") {
        return { outcome: "ALREADY_VERIFIED", fence: current };
      }
      if (current?.status === "FAILED" && current.retryable === false) {
        throw new IngestionError(
          "INVALID_INGESTION_STATE",
          `Ingestion for run ${runId} failed and is not retryable`,
          { runId, failureCode: current.failureCode },
        );
      }
      const coordinationKey = this.coordinationKey(runId);
      const lease = await tryAcquire(this.leaseStore, {
        coordinationKey,
        phase: "ingestion",
        ownerId: this.instanceId,
      });
      if (lease === "HELD") {
        throw new IngestionError(
          "INGESTION_IN_PROGRESS",
          `Ingestion is already in progress for run ${runId}`,
          { runId, attempt: current?.attempt },
        );
      }
      const ownerToken = makeOwnerToken(this.instanceId, lease.fenceToken);
      const fence = IngestionFenceSchema.parse({
        runId,
        status: "IN_PROGRESS",
        attempt: nextAttempt(current),
        ownerToken,
        lastUpdatedAt: nowIso,
        retryable: true,
      });
      await upsertFence(this.db, {
        coordinationKey,
        phase: "ingestion",
        runId,
        fenceToken: lease.fenceToken,
        ownerId: this.instanceId,
        ownerToken,
        status: fence.status,
        payload: fence,
      });
      return { outcome: "STARTED", fence, ownerToken };
    });
  }

  async markVerified(
    runId: string,
    ownerToken: string,
    nowIso: string,
  ): Promise<IngestionFence> {
    const current = await this.requireWritableInProgress(runId, ownerToken);
    const fence = IngestionFenceSchema.parse({
      runId,
      status: "VERIFIED",
      attempt: current.attempt,
      lastUpdatedAt: nowIso,
      verifiedAt: nowIso,
      retryable: false,
    });
    return this.persistOwned(runId, ownerToken, fence);
  }

  async markFailed(
    runId: string,
    ownerToken: string,
    failure: {
      failureCode: string;
      failedAt: string;
      retryable: boolean;
    },
  ): Promise<IngestionFence> {
    const current = await this.requireWritableInProgress(runId, ownerToken);
    const fence = IngestionFenceSchema.parse({
      runId,
      status: "FAILED",
      attempt: current.attempt,
      lastUpdatedAt: failure.failedAt,
      failureCode: failure.failureCode,
      failedAt: failure.failedAt,
      retryable: failure.retryable,
    });
    return this.persistOwned(runId, ownerToken, fence);
  }

  async reconcileVerified(runId: string, nowIso: string): Promise<IngestionFence> {
    const current = await this.get(runId);
    if (current?.status === "VERIFIED") {
      return current;
    }
    const fence = IngestionFenceSchema.parse({
      runId,
      status: "VERIFIED",
      attempt: current?.attempt ?? 1,
      lastUpdatedAt: nowIso,
      verifiedAt: nowIso,
      retryable: false,
    });
    await upsertFence(this.db, {
      coordinationKey: this.coordinationKey(runId),
      phase: "ingestion",
      runId,
      fenceToken: 0,
      ownerId: this.instanceId,
      ownerToken: makeOwnerToken(this.instanceId, 0),
      status: fence.status,
      payload: fence,
    });
    return fence;
  }

  private async requireWritableInProgress(
    runId: string,
    ownerToken: string,
  ): Promise<IngestionFence> {
    try {
      const fenceToken = parseOwnerToken(this.instanceId, ownerToken);
      await this.leaseStore.assertWritable({
        coordinationKey: this.coordinationKey(runId),
        ownerId: this.instanceId,
        fenceToken,
      });
    } catch (error) {
      if (isStaleFence(error)) {
        throw new IngestionError(
          "INVALID_INGESTION_STATE",
          `Ingestion ownership mismatch for run ${runId}`,
          { runId },
        );
      }
      throw error;
    }
    const current = await this.get(runId);
    if (!current || current.status !== "IN_PROGRESS") {
      throw new IngestionError(
        "INVALID_INGESTION_STATE",
        `Ingestion fence for run ${runId} is not IN_PROGRESS`,
        { runId, status: current?.status },
      );
    }
    return current;
  }

  private async persistOwned(
    runId: string,
    ownerToken: string,
    fence: IngestionFence,
  ): Promise<IngestionFence> {
    const updated = await updateFenceByOwnerToken(
      this.db,
      this.coordinationKey(runId),
      ownerToken,
      fence.status,
      fence,
      (input) => IngestionFenceSchema.parse(input),
    );
    if (!updated) {
      throw new IngestionError(
        "INVALID_INGESTION_STATE",
        `Ingestion ownership mismatch for run ${runId}`,
        { runId },
      );
    }
    return updated;
  }
}

export class PostgresPlanningCoordinator implements PlanningCoordinator {
  constructor(
    private readonly db: PostgresDatabase,
    private readonly leaseStore: PostgresLeaseStore,
    private readonly instanceId: string,
  ) {}

  private coordinationKey(runId: string): string {
    return `planning:${runId}`;
  }

  async get(runId: string): Promise<PlanningFence | null> {
    return loadFencePayload(
      this.db,
      this.coordinationKey(runId),
      (input) => PlanningFenceSchema.parse(input),
    );
  }

  async begin(runId: string, nowIso: string): Promise<BeginPlanningResult> {
    return this.db.withTransaction(async () => {
      const current = await this.get(runId);
      if (current?.status === "PLANNED") {
        return { outcome: "ALREADY_PLANNED", fence: current };
      }
      if (current?.status === "FAILED" && current.retryable === false) {
        throw new PlanningError(
          "INVALID_PLANNING_STATE",
          `Planning for run ${runId} failed and is not retryable`,
          { runId, failureCode: current.failureCode },
        );
      }
      const coordinationKey = this.coordinationKey(runId);
      const lease = await tryAcquire(this.leaseStore, {
        coordinationKey,
        phase: "planning",
        ownerId: this.instanceId,
      });
      if (lease === "HELD") {
        throw new PlanningError(
          "PLANNING_IN_PROGRESS",
          `Planning is already in progress for run ${runId}`,
          { runId, attempt: current?.attempt },
        );
      }
      const ownerToken = makeOwnerToken(this.instanceId, lease.fenceToken);
      const fence = PlanningFenceSchema.parse({
        runId,
        status: "IN_PROGRESS",
        attempt: nextAttempt(current),
        ownerToken,
        lastUpdatedAt: nowIso,
        retryable: true,
      });
      await upsertFence(this.db, {
        coordinationKey,
        phase: "planning",
        runId,
        fenceToken: lease.fenceToken,
        ownerId: this.instanceId,
        ownerToken,
        status: fence.status,
        payload: fence,
      });
      return { outcome: "STARTED", fence, ownerToken };
    });
  }

  async markPlanned(
    runId: string,
    ownerToken: string,
    nowIso: string,
    planId: string,
  ): Promise<PlanningFence> {
    const current = await this.requireWritableInProgress(runId, ownerToken);
    const fence = PlanningFenceSchema.parse({
      runId,
      status: "PLANNED",
      attempt: current.attempt,
      lastUpdatedAt: nowIso,
      plannedAt: nowIso,
      planId,
      retryable: false,
    });
    return this.persistOwned(runId, ownerToken, fence);
  }

  async markFailed(
    runId: string,
    ownerToken: string,
    failure: {
      failureCode: string;
      failedAt: string;
      retryable: boolean;
    },
  ): Promise<PlanningFence> {
    const current = await this.requireWritableInProgress(runId, ownerToken);
    const fence = PlanningFenceSchema.parse({
      runId,
      status: "FAILED",
      attempt: current.attempt,
      lastUpdatedAt: failure.failedAt,
      failureCode: failure.failureCode,
      failedAt: failure.failedAt,
      retryable: failure.retryable,
    });
    return this.persistOwned(runId, ownerToken, fence);
  }

  async reconcilePlanned(
    runId: string,
    nowIso: string,
    planId: string,
  ): Promise<PlanningFence> {
    const current = await this.get(runId);
    if (current?.status === "PLANNED") {
      return current;
    }
    const fence = PlanningFenceSchema.parse({
      runId,
      status: "PLANNED",
      attempt: current?.attempt ?? 1,
      lastUpdatedAt: nowIso,
      plannedAt: nowIso,
      planId,
      retryable: false,
    });
    await upsertFence(this.db, {
      coordinationKey: this.coordinationKey(runId),
      phase: "planning",
      runId,
      fenceToken: 0,
      ownerId: this.instanceId,
      ownerToken: makeOwnerToken(this.instanceId, 0),
      status: fence.status,
      payload: fence,
    });
    return fence;
  }

  private async requireWritableInProgress(
    runId: string,
    ownerToken: string,
  ): Promise<PlanningFence> {
    try {
      const fenceToken = parseOwnerToken(this.instanceId, ownerToken);
      await this.leaseStore.assertWritable({
        coordinationKey: this.coordinationKey(runId),
        ownerId: this.instanceId,
        fenceToken,
      });
    } catch (error) {
      if (isStaleFence(error)) {
        throw new PlanningError(
          "INVALID_PLANNING_STATE",
          `Planning ownership mismatch for run ${runId}`,
          { runId },
        );
      }
      throw error;
    }
    const current = await this.get(runId);
    if (!current || current.status !== "IN_PROGRESS") {
      throw new PlanningError(
        "INVALID_PLANNING_STATE",
        `Planning fence for run ${runId} is not IN_PROGRESS`,
        { runId, status: current?.status },
      );
    }
    return current;
  }

  private async persistOwned(
    runId: string,
    ownerToken: string,
    fence: PlanningFence,
  ): Promise<PlanningFence> {
    const updated = await updateFenceByOwnerToken(
      this.db,
      this.coordinationKey(runId),
      ownerToken,
      fence.status,
      fence,
      (input) => PlanningFenceSchema.parse(input),
    );
    if (!updated) {
      throw new PlanningError(
        "INVALID_PLANNING_STATE",
        `Planning ownership mismatch for run ${runId}`,
        { runId },
      );
    }
    return updated;
  }
}

export class PostgresValidationCoordinator implements ValidationCoordinator {
  constructor(
    private readonly db: PostgresDatabase,
    private readonly leaseStore: PostgresLeaseStore,
    private readonly instanceId: string,
  ) {}

  private coordinationKey(key: ValidationFenceKey): string {
    return `validation:${validationFenceKey(key)}`;
  }

  async get(key: ValidationFenceKey): Promise<ValidationFence | null> {
    return loadFencePayload(
      this.db,
      this.coordinationKey(key),
      (input) => ValidationFenceSchema.parse(input),
    );
  }

  async begin(
    key: ValidationFenceKey,
    nowIso: string,
  ): Promise<BeginValidationResult> {
    return this.db.withTransaction(async () => {
      const current = await this.get(key);
      if (current?.status === "DECIDED") {
        return { outcome: "ALREADY_DECIDED", fence: current };
      }
      if (current?.status === "FAILED" && current.retryable === false) {
        throw new ValidationError(
          "INVALID_VALIDATION_STATE",
          `Validation for plan ${key.planId} failed and is not retryable`,
          { runId: key.runId, failureCode: current.failureCode },
        );
      }
      const coordinationKey = this.coordinationKey(key);
      const lease = await tryAcquire(this.leaseStore, {
        coordinationKey,
        phase: "validation",
        ownerId: this.instanceId,
      });
      if (lease === "HELD") {
        throw new ValidationError(
          "VALIDATION_IN_PROGRESS",
          `Validation is already in progress for plan ${key.planId} v${key.planVersion}`,
          { runId: key.runId, planId: key.planId, attempt: current?.attempt },
        );
      }
      const ownerToken = makeOwnerToken(this.instanceId, lease.fenceToken);
      const fence = ValidationFenceSchema.parse({
        fenceKey: validationFenceKey(key),
        runId: key.runId,
        planId: key.planId,
        planVersion: key.planVersion,
        planHash: key.planHash,
        status: "IN_PROGRESS",
        attempt: nextAttempt(current),
        ownerToken,
        lastUpdatedAt: nowIso,
        retryable: true,
      });
      await upsertFence(this.db, {
        coordinationKey,
        phase: "validation",
        runId: key.runId,
        fenceToken: lease.fenceToken,
        ownerId: this.instanceId,
        ownerToken,
        status: fence.status,
        payload: fence,
      });
      return { outcome: "STARTED", fence, ownerToken };
    });
  }

  async markDecided(
    key: ValidationFenceKey,
    ownerToken: string,
    nowIso: string,
    decision: {
      validationDecisionId: string;
      decision: z.infer<typeof ValidationDecisionClassSchema>;
    },
  ): Promise<ValidationFence> {
    const current = await this.requireWritableInProgress(key, ownerToken);
    const fence = ValidationFenceSchema.parse({
      fenceKey: validationFenceKey(key),
      runId: key.runId,
      planId: key.planId,
      planVersion: key.planVersion,
      planHash: key.planHash,
      status: "DECIDED",
      attempt: current.attempt,
      lastUpdatedAt: nowIso,
      decidedAt: nowIso,
      validationDecisionId: decision.validationDecisionId,
      decision: decision.decision,
      retryable: false,
    });
    return this.persistOwned(key, ownerToken, fence);
  }

  async markFailed(
    key: ValidationFenceKey,
    ownerToken: string,
    failure: {
      failureCode: string;
      failedAt: string;
      retryable: boolean;
    },
  ): Promise<ValidationFence> {
    const current = await this.requireWritableInProgress(key, ownerToken);
    const fence = ValidationFenceSchema.parse({
      fenceKey: validationFenceKey(key),
      runId: key.runId,
      planId: key.planId,
      planVersion: key.planVersion,
      planHash: key.planHash,
      status: "FAILED",
      attempt: current.attempt,
      lastUpdatedAt: failure.failedAt,
      failureCode: failure.failureCode,
      failedAt: failure.failedAt,
      retryable: failure.retryable,
    });
    return this.persistOwned(key, ownerToken, fence);
  }

  async reconcileDecided(
    key: ValidationFenceKey,
    nowIso: string,
    decision: {
      validationDecisionId: string;
      decision: z.infer<typeof ValidationDecisionClassSchema>;
    },
  ): Promise<ValidationFence> {
    const current = await this.get(key);
    if (current?.status === "DECIDED") {
      return current;
    }
    const fence = ValidationFenceSchema.parse({
      fenceKey: validationFenceKey(key),
      runId: key.runId,
      planId: key.planId,
      planVersion: key.planVersion,
      planHash: key.planHash,
      status: "DECIDED",
      attempt: current?.attempt ?? 1,
      lastUpdatedAt: nowIso,
      decidedAt: nowIso,
      validationDecisionId: decision.validationDecisionId,
      decision: decision.decision,
      retryable: false,
    });
    await upsertFence(this.db, {
      coordinationKey: this.coordinationKey(key),
      phase: "validation",
      runId: key.runId,
      fenceToken: 0,
      ownerId: this.instanceId,
      ownerToken: makeOwnerToken(this.instanceId, 0),
      status: fence.status,
      payload: fence,
    });
    return fence;
  }

  async listByRunId(runId: string): Promise<readonly ValidationFence[]> {
    const result = await this.db.query<{ payload: unknown; coordination_key: string }>(
      `SELECT coordination_key, payload FROM coordinator_fences
       WHERE run_id = $1 AND phase = 'validation'
       ORDER BY updated_at ASC`,
      [runId],
    );
    const fences = result.rows.map((row) =>
      hydrateRecord(
        (input) => ValidationFenceSchema.parse(input),
        row.payload,
        `coordinator_fences:${row.coordination_key}`,
      ),
    );
    return fences.sort((a, b) => a.planVersion - b.planVersion);
  }

  private async requireWritableInProgress(
    key: ValidationFenceKey,
    ownerToken: string,
  ): Promise<ValidationFence> {
    try {
      const fenceToken = parseOwnerToken(this.instanceId, ownerToken);
      await this.leaseStore.assertWritable({
        coordinationKey: this.coordinationKey(key),
        ownerId: this.instanceId,
        fenceToken,
      });
    } catch (error) {
      if (isStaleFence(error)) {
        throw new ValidationError(
          "INVALID_VALIDATION_STATE",
          `Validation ownership mismatch for plan ${key.planId}`,
          { runId: key.runId },
        );
      }
      throw error;
    }
    const current = await this.get(key);
    if (!current || current.status !== "IN_PROGRESS") {
      throw new ValidationError(
        "INVALID_VALIDATION_STATE",
        `Validation fence for plan ${key.planId} is not IN_PROGRESS`,
        { runId: key.runId, status: current?.status },
      );
    }
    return current;
  }

  private async persistOwned(
    key: ValidationFenceKey,
    ownerToken: string,
    fence: ValidationFence,
  ): Promise<ValidationFence> {
    const updated = await updateFenceByOwnerToken(
      this.db,
      this.coordinationKey(key),
      ownerToken,
      fence.status,
      fence,
      (input) => ValidationFenceSchema.parse(input),
    );
    if (!updated) {
      throw new ValidationError(
        "INVALID_VALIDATION_STATE",
        `Validation ownership mismatch for plan ${key.planId}`,
        { runId: key.runId },
      );
    }
    return updated;
  }
}

export class PostgresAuthorizationCoordinator
  implements AuthorizationCoordinator
{
  private readonly docs: PostgresJsonDocuments;

  constructor(
    private readonly db: PostgresDatabase,
    _leaseStore: PostgresLeaseStore,
    _instanceId: string,
    private readonly requests: ApprovalRequestRepository,
  ) {
    this.docs = new PostgresJsonDocuments(db);
  }

  async findActiveByBinding(
    bindingKey: string,
  ): Promise<ApprovalRequest | null> {
    const binding = await this.docs.getByUniqueKey(
      BINDINGS_COLLECTION,
      bindingKey,
      parseBindingDocument,
    );
    if (!binding) {
      return null;
    }
    const request = await this.requests.getById(binding.approvalRequestId);
    if (!request || request.status !== "PENDING") {
      await this.deleteBinding(bindingKey);
      return null;
    }
    return request;
  }

  async registerPending(
    request: ApprovalRequest,
    bindingKey: string,
  ): Promise<void> {
    const existing = await this.docs.getByUniqueKey(
      BINDINGS_COLLECTION,
      bindingKey,
      parseBindingDocument,
    );
    if (existing && existing.approvalRequestId !== request.approvalRequestId) {
      throw new AuthorizationError(
        "APPROVAL_REQUEST_ALREADY_EXISTS",
        "A PENDING approval request already exists for this exact binding",
        { bindingKey, existingId: existing.approvalRequestId },
      );
    }
    if (existing) {
      return;
    }
    try {
      await this.docs.insert({
        collection: BINDINGS_COLLECTION,
        documentId: bindingKey,
        uniqueKey: bindingKey,
        runId: request.runId,
        projectId: request.projectId,
        payload: {
          bindingKey,
          approvalRequestId: request.approvalRequestId,
        },
      });
    } catch (error) {
      if (error instanceof DurabilityError && error.code === "DURABLE_CONFLICT") {
        const raced = await this.docs.getByUniqueKey(
          BINDINGS_COLLECTION,
          bindingKey,
          parseBindingDocument,
        );
        if (raced && raced.approvalRequestId !== request.approvalRequestId) {
          throw new AuthorizationError(
            "APPROVAL_REQUEST_ALREADY_EXISTS",
            "A PENDING approval request already exists for this exact binding",
            { bindingKey, existingId: raced.approvalRequestId },
          );
        }
        return;
      }
      throw error;
    }
  }

  async beginDecision(
    approvalRequestId: string,
    decisionNonce: string,
  ): Promise<{ nonceHash: string }> {
    const request = await this.requests.getById(approvalRequestId);
    if (!request) {
      throw new AuthorizationError(
        "APPROVAL_REQUEST_NOT_FOUND",
        `Unknown approval request: ${approvalRequestId}`,
      );
    }
    if (isTerminalApprovalRequestStatus(request.status) || request.status !== "PENDING") {
      throw new AuthorizationError(
        "APPROVAL_REQUEST_NOT_PENDING",
        `Approval request is ${request.status}; nonce is invalid`,
        { approvalRequestId, status: request.status },
      );
    }
    const nonceHash = hashDecisionNonce(decisionNonce);
    const consumed = await this.db.query<{ approval_request_id: string }>(
      `UPDATE nonce_state
       SET status = 'CONSUMED', consumed_at = NOW()
       WHERE approval_request_id = $1
         AND status = 'PENDING'
         AND nonce_hash = $2
       RETURNING approval_request_id`,
      [approvalRequestId, nonceHash],
    );
    if (consumed.rows.length === 0) {
      if (nonceHash !== request.decisionNonceHash) {
        throw new AuthorizationError(
          "INVALID_DECISION_NONCE",
          "Submitted decision nonce does not match the system-issued nonce for this request",
          { approvalRequestId },
        );
      }
      throw new AuthorizationError(
        "AUTHORIZATION_DECISION_REPLAYED",
        "Decision nonce was already consumed or invalidated",
        { approvalRequestId },
      );
    }
    return { nonceHash };
  }

  async completeDecision(approvalRequestId: string): Promise<void> {
    await this.clearBindingsForRequest(approvalRequestId);
  }

  async failDecision(_approvalRequestId: string): Promise<void> {
    // Nonce remains CONSUMED so a failed mid-flight attempt cannot be replayed.
  }

  async isNonceConsumed(approvalRequestId: string): Promise<boolean> {
    const result = await this.db.query<{ status: string }>(
      `SELECT status FROM nonce_state WHERE approval_request_id = $1`,
      [approvalRequestId],
    );
    const status = result.rows[0]?.status;
    return status === "CONSUMED" || status === "INVALIDATED";
  }

  async invalidateNonce(approvalRequestId: string): Promise<void> {
    await this.db.query(
      `UPDATE nonce_state
       SET status = 'INVALIDATED'
       WHERE approval_request_id = $1 AND status = 'PENDING'`,
      [approvalRequestId],
    );
    await this.clearBindingsForRequest(approvalRequestId);
  }

  async supersedePendingForRun(
    runId: string,
    exceptRequestId: string | null,
    reasonCode: string,
  ): Promise<readonly ApprovalRequest[]> {
    const list = await this.requests.listByRun(runId);
    const superseded: ApprovalRequest[] = [];
    for (const request of list) {
      if (request.status !== "PENDING") {
        continue;
      }
      if (exceptRequestId && request.approvalRequestId === exceptRequestId) {
        continue;
      }
      const updated = await this.requests.updateStatus(
        request.approvalRequestId,
        "SUPERSEDED",
        { failureReasonCode: reasonCode },
      );
      await this.invalidateNonce(request.approvalRequestId);
      superseded.push(updated);
    }
    return superseded;
  }

  private async clearBindingsForRequest(approvalRequestId: string): Promise<void> {
    await this.db.query(
      `DELETE FROM json_documents
       WHERE collection = $1 AND payload->>'approvalRequestId' = $2`,
      [BINDINGS_COLLECTION, approvalRequestId],
    );
  }

  private async deleteBinding(bindingKey: string): Promise<void> {
    await this.db.query(
      `DELETE FROM json_documents
       WHERE collection = $1 AND unique_key = $2`,
      [BINDINGS_COLLECTION, bindingKey],
    );
  }
}

function parseBindingDocument(input: unknown): {
  bindingKey: string;
  approvalRequestId: string;
} {
  if (typeof input !== "object" || input === null) {
    throw new Error("Authorization binding is not an object");
  }
  const doc = input as { bindingKey?: unknown; approvalRequestId?: unknown };
  if (
    typeof doc.bindingKey !== "string" ||
    typeof doc.approvalRequestId !== "string"
  ) {
    throw new Error("Authorization binding invalid");
  }
  return {
    bindingKey: doc.bindingKey,
    approvalRequestId: doc.approvalRequestId,
  };
}

export class PostgresExecutionCoordinator implements ExecutionCoordinator {
  private readonly results: PostgresExecutionResultRepository;

  constructor(
    private readonly db: PostgresDatabase,
    private readonly leaseStore: PostgresLeaseStore,
    private readonly instanceId: string,
  ) {
    this.results = new PostgresExecutionResultRepository(db);
  }

  private coordinationKey(key: ExecutionFenceKey): string {
    return `execution:${executionFenceKey(key)}`;
  }

  async get(key: ExecutionFenceKey): Promise<ExecutionFence | null> {
    return loadFencePayload(
      this.db,
      this.coordinationKey(key),
      (input) => ExecutionFenceSchema.parse(input),
    );
  }

  async begin(
    key: ExecutionFenceKey,
    nowIso: string,
  ): Promise<BeginExecutionResult> {
    return this.db.withTransaction(async () => {
      const existing = await this.get(key);
      if (existing?.status === "COMPLETED" || existing?.status === "CONTAINED") {
        const stored = await this.getResult(key);
        if (stored) {
          return { outcome: "ALREADY_COMPLETED", fence: existing, result: stored };
        }
        return { outcome: "ALREADY_COMPLETED", fence: existing };
      }
      const coordinationKey = this.coordinationKey(key);
      const lease = await tryAcquire(this.leaseStore, {
        coordinationKey,
        phase: "execution",
        ownerId: this.instanceId,
      });
      if (lease === "HELD") {
        const live = existing ?? (await this.get(key));
        if (!live) {
          throw new ExecutionError(
            "EXECUTION_FENCE_FAILED",
            "Lease held but execution fence is missing",
          );
        }
        return { outcome: "IN_PROGRESS", fence: live };
      }
      const ownerToken = makeOwnerToken(this.instanceId, lease.fenceToken);
      const fence: ExecutionFence = {
        fenceKey: executionFenceKey(key),
        runId: key.runId,
        planId: key.planId,
        planVersion: key.planVersion,
        planHash: key.planHash,
        authorizationRecordId: key.authorizationRecordId,
        status: "IN_PROGRESS",
        attempt: (existing?.attempt ?? 0) + 1,
        lastUpdatedAt: nowIso,
        ownerToken,
      };
      await upsertFence(this.db, {
        coordinationKey,
        phase: "execution",
        runId: key.runId,
        fenceToken: lease.fenceToken,
        ownerId: this.instanceId,
        ownerToken,
        status: fence.status,
        payload: fence,
      });
      return { outcome: "STARTED", fence, ownerToken };
    });
  }

  async markCompleted(
    key: ExecutionFenceKey,
    ownerToken: string,
    nowIso: string,
    meta: { executionAttemptId: string; resultStatus: string },
  ): Promise<ExecutionFence> {
    return this.transition(key, ownerToken, nowIso, "COMPLETED", meta);
  }

  async markFailed(
    key: ExecutionFenceKey,
    ownerToken: string,
    nowIso: string,
    failureCode: string,
  ): Promise<ExecutionFence> {
    return this.transition(key, ownerToken, nowIso, "FAILED", { failureCode });
  }

  async markContained(
    key: ExecutionFenceKey,
    ownerToken: string,
    nowIso: string,
    failureCode: string,
  ): Promise<ExecutionFence> {
    return this.transition(key, ownerToken, nowIso, "CONTAINED", {
      failureCode,
    });
  }

  async storeResult(
    key: ExecutionFenceKey,
    result: ExecutionResult,
  ): Promise<void> {
    await this.results.store(executionFenceKey(key), parseExecutionResult(result));
  }

  async getResult(key: ExecutionFenceKey): Promise<ExecutionResult | null> {
    return this.results.get(executionFenceKey(key));
  }

  private async transition(
    key: ExecutionFenceKey,
    ownerToken: string,
    nowIso: string,
    status: ExecutionFenceStatus,
    extras: {
      executionAttemptId?: string;
      resultStatus?: string;
      failureCode?: string;
    },
  ): Promise<ExecutionFence> {
    try {
      const fenceToken = parseOwnerToken(this.instanceId, ownerToken);
      await this.leaseStore.assertWritable({
        coordinationKey: this.coordinationKey(key),
        ownerId: this.instanceId,
        fenceToken,
      });
    } catch (error) {
      if (isStaleFence(error)) {
        throw new ExecutionError(
          "EXECUTION_FENCE_FAILED",
          "Fence owner token mismatch",
        );
      }
      throw error;
    }
    const existing = await this.get(key);
    if (!existing) {
      throw new ExecutionError(
        "EXECUTION_FENCE_FAILED",
        "No fence to transition",
      );
    }
    if (existing.status !== "IN_PROGRESS") {
      throw new ExecutionError(
        "EXECUTION_FENCE_FAILED",
        `Fence is ${existing.status}, expected IN_PROGRESS`,
      );
    }
    const next: ExecutionFence = {
      ...existing,
      status,
      lastUpdatedAt: nowIso,
      ...(extras.executionAttemptId !== undefined
        ? { executionAttemptId: extras.executionAttemptId }
        : {}),
      ...(extras.resultStatus !== undefined
        ? { resultStatus: extras.resultStatus }
        : {}),
      ...(extras.failureCode !== undefined
        ? { failureCode: extras.failureCode }
        : {}),
    };
    const updated = await updateFenceByOwnerToken(
      this.db,
      this.coordinationKey(key),
      ownerToken,
      next.status,
      next,
      (input) => ExecutionFenceSchema.parse(input),
    );
    if (!updated) {
      throw new ExecutionError(
        "EXECUTION_FENCE_FAILED",
        "Fence owner token mismatch",
      );
    }
    return updated;
  }
}

export class PostgresVerificationCoordinator
  implements VerificationCoordinator
{
  private readonly docs: PostgresJsonDocuments;

  constructor(
    private readonly db: PostgresDatabase,
    private readonly leaseStore: PostgresLeaseStore,
    private readonly instanceId: string,
  ) {
    this.docs = new PostgresJsonDocuments(db);
  }

  private coordinationKey(key: VerificationFenceKey): string {
    return `verification:${verificationFenceKey(key)}`;
  }

  async get(key: VerificationFenceKey): Promise<VerificationFence | null> {
    return loadFencePayload(
      this.db,
      this.coordinationKey(key),
      (input) => VerificationFenceSchema.parse(input),
    );
  }

  async begin(
    key: VerificationFenceKey,
    nowIso: string,
  ): Promise<BeginVerificationResult> {
    return this.db.withTransaction(async () => {
      const existing = await this.get(key);
      if (existing?.status === "DECIDED") {
        const stored = await this.getResult(key);
        return {
          outcome: "ALREADY_DECIDED",
          fence: existing,
          ...(stored !== undefined && stored !== null ? { result: stored } : {}),
        };
      }
      const coordinationKey = this.coordinationKey(key);
      const lease = await tryAcquire(this.leaseStore, {
        coordinationKey,
        phase: "verification",
        ownerId: this.instanceId,
      });
      if (lease === "HELD") {
        const live = existing ?? (await this.get(key));
        if (!live) {
          throw new VerificationError(
            "VERIFICATION_FENCE_FAILED",
            "Lease held but verification fence is missing",
            { fenceKey: verificationFenceKey(key) },
          );
        }
        if (live.status !== "FAILED") {
          return { outcome: "IN_PROGRESS", fence: live };
        }
        // FAILED fence with held lease: same owner can re-acquire (bumps fence token)
      }
      const freshLease = lease === "HELD"
        ? await this.leaseStore.acquire({ coordinationKey, phase: "verification", ownerId: this.instanceId })
        : lease;
      const ownerToken = makeOwnerToken(this.instanceId, freshLease.fenceToken);
      const fence: VerificationFence = {
        fenceKey: verificationFenceKey(key),
        runId: key.runId,
        executionAttemptId: key.executionAttemptId,
        planId: key.planId,
        planVersion: key.planVersion,
        planHash: key.planHash,
        status: "IN_PROGRESS",
        attempt: (existing?.attempt ?? 0) + 1,
        lastUpdatedAt: nowIso,
        ownerToken,
      };
      await upsertFence(this.db, {
        coordinationKey,
        phase: "verification",
        runId: key.runId,
        fenceToken: freshLease.fenceToken,
        ownerId: this.instanceId,
        ownerToken,
        status: fence.status,
        payload: fence,
      });
      return { outcome: "STARTED", fence, ownerToken };
    });
  }

  async markDecided(
    key: VerificationFenceKey,
    ownerToken: string,
    nowIso: string,
    meta: { outcomeVerificationId: string; outcome: string },
  ): Promise<VerificationFence> {
    return this.transition(key, ownerToken, nowIso, "DECIDED", meta);
  }

  async markFailed(
    key: VerificationFenceKey,
    ownerToken: string,
    nowIso: string,
    failureCode: string,
  ): Promise<VerificationFence> {
    return this.transition(key, ownerToken, nowIso, "FAILED", { failureCode });
  }

  async storeResult(
    key: VerificationFenceKey,
    result: VerificationResult,
  ): Promise<void> {
    const parsed = parseVerificationResult(result);
    const fenceKey = verificationFenceKey(key);
    await this.docs.upsert({
      collection: VERIFICATION_RESULTS_COLLECTION,
      documentId: fenceKey,
      uniqueKey: fenceKey,
      runId: parsed.runId,
      payload: parsed,
    });
  }

  async getResult(
    key: VerificationFenceKey,
  ): Promise<VerificationResult | null> {
    return this.docs.getByUniqueKey(
      VERIFICATION_RESULTS_COLLECTION,
      verificationFenceKey(key),
      parseVerificationResult,
    );
  }

  private async transition(
    key: VerificationFenceKey,
    ownerToken: string,
    nowIso: string,
    status: VerificationFenceStatus,
    extras: {
      outcomeVerificationId?: string;
      outcome?: string;
      failureCode?: string;
    },
  ): Promise<VerificationFence> {
    const fenceKey = verificationFenceKey(key);
    try {
      const fenceToken = parseOwnerToken(this.instanceId, ownerToken);
      await this.leaseStore.assertWritable({
        coordinationKey: this.coordinationKey(key),
        ownerId: this.instanceId,
        fenceToken,
      });
    } catch (error) {
      if (isStaleFence(error)) {
        throw new VerificationError(
          "VERIFICATION_FENCE_FAILED",
          "Verification fence owner token mismatch",
          { fenceKey },
        );
      }
      throw error;
    }
    const existing = await this.get(key);
    if (!existing) {
      throw new VerificationError(
        "VERIFICATION_FENCE_FAILED",
        "Verification fence not found",
        { fenceKey },
      );
    }
    if (existing.status !== "IN_PROGRESS") {
      throw new VerificationError(
        "INVALID_VERIFICATION_STATE",
        `Cannot transition fence from ${existing.status} to ${status}`,
        { fenceKey, from: existing.status, to: status },
      );
    }
    const next: VerificationFence = {
      ...existing,
      status,
      lastUpdatedAt: nowIso,
      ...(extras.outcomeVerificationId !== undefined
        ? { outcomeVerificationId: extras.outcomeVerificationId }
        : {}),
      ...(extras.outcome !== undefined ? { outcome: extras.outcome } : {}),
      ...(extras.failureCode !== undefined
        ? { failureCode: extras.failureCode }
        : {}),
    };
    const updated = await updateFenceByOwnerToken(
      this.db,
      this.coordinationKey(key),
      ownerToken,
      next.status,
      next,
      (input) => VerificationFenceSchema.parse(input),
    );
    if (!updated) {
      throw new VerificationError(
        "VERIFICATION_FENCE_FAILED",
        "Verification fence owner token mismatch",
        { fenceKey },
      );
    }
    return updated;
  }
}

export class PostgresLearningCoordinator implements LearningCoordinator {
  constructor(
    private readonly db: PostgresDatabase,
    private readonly leaseStore: PostgresLeaseStore,
    private readonly instanceId: string,
  ) {}

  private coordinationKey(key: LearningFenceKey): string {
    return `learning:${learningFenceKey(key)}`;
  }

  async get(key: LearningFenceKey): Promise<LearningFence | null> {
    return loadFencePayload(
      this.db,
      this.coordinationKey(key),
      (input) => LearningFenceSchema.parse(input),
    );
  }

  async begin(
    key: LearningFenceKey,
    nowIso: string,
  ): Promise<BeginLearningResult> {
    return this.db.withTransaction(async () => {
      const existing = await this.get(key);
      if (existing?.status === "PROCESSED") {
        return { outcome: "ALREADY_PROCESSED", fence: existing };
      }
      const coordinationKey = this.coordinationKey(key);
      const lease = await tryAcquire(this.leaseStore, {
        coordinationKey,
        phase: "learning",
        ownerId: this.instanceId,
      });
      if (lease === "HELD") {
        const live = existing ?? (await this.get(key));
        if (!live) {
          throw new MemoryError(
            "LEARNING_FENCE_FAILED",
            "Lease held but learning fence is missing",
            { fenceKey: learningFenceKey(key) },
          );
        }
        if (live.status !== "FAILED") {
          return { outcome: "IN_PROGRESS", fence: live };
        }
      }
      const freshLease =
        lease === "HELD"
          ? await this.leaseStore.acquire({
              coordinationKey,
              phase: "learning",
              ownerId: this.instanceId,
            })
          : lease;
      const ownerToken = makeOwnerToken(this.instanceId, freshLease.fenceToken);
      const fence: LearningFence = {
        fenceKey: learningFenceKey(key),
        runId: key.runId,
        outcome: key.outcome,
        ...(key.outcomeVerificationId !== undefined
          ? { outcomeVerificationId: key.outcomeVerificationId }
          : {}),
        status: "IN_PROGRESS",
        attempt: (existing?.attempt ?? 0) + 1,
        lastUpdatedAt: nowIso,
        ownerToken,
      };
      await upsertFence(this.db, {
        coordinationKey,
        phase: "learning",
        runId: key.runId,
        fenceToken: freshLease.fenceToken,
        ownerId: this.instanceId,
        ownerToken,
        status: fence.status,
        payload: fence,
      });
      return { outcome: "STARTED", fence, ownerToken };
    });
  }

  async markProcessed(
    key: LearningFenceKey,
    ownerToken: string,
    nowIso: string,
    historicalRunRecordId: string,
  ): Promise<LearningFence> {
    return this.transition(key, ownerToken, nowIso, "PROCESSED", {
      historicalRunRecordId,
    });
  }

  async markFailed(
    key: LearningFenceKey,
    ownerToken: string,
    nowIso: string,
    failureCode: string,
  ): Promise<LearningFence> {
    return this.transition(key, ownerToken, nowIso, "FAILED", { failureCode });
  }

  private async transition(
    key: LearningFenceKey,
    ownerToken: string,
    nowIso: string,
    status: LearningFenceStatus,
    extras: { historicalRunRecordId?: string; failureCode?: string },
  ): Promise<LearningFence> {
    const fenceKey = learningFenceKey(key);
    try {
      const fenceToken = parseOwnerToken(this.instanceId, ownerToken);
      await this.leaseStore.assertWritable({
        coordinationKey: this.coordinationKey(key),
        ownerId: this.instanceId,
        fenceToken,
      });
    } catch (error) {
      if (isStaleFence(error)) {
        throw new MemoryError(
          "LEARNING_FENCE_FAILED",
          "Learning fence owner token mismatch",
          { fenceKey },
        );
      }
      throw error;
    }
    const existing = await this.get(key);
    if (!existing) {
      throw new MemoryError(
        "LEARNING_FENCE_FAILED",
        "Learning fence not found",
        { fenceKey },
      );
    }
    if (existing.status !== "IN_PROGRESS") {
      throw new MemoryError(
        "INVALID_LEARNING_STATE",
        `Cannot transition fence from ${existing.status} to ${status}`,
        { fenceKey, from: existing.status, to: status },
      );
    }
    const next: LearningFence = {
      ...existing,
      status,
      lastUpdatedAt: nowIso,
      ...(extras.historicalRunRecordId !== undefined
        ? { historicalRunRecordId: extras.historicalRunRecordId }
        : {}),
      ...(extras.failureCode !== undefined
        ? { failureCode: extras.failureCode }
        : {}),
    };
    const updated = await updateFenceByOwnerToken(
      this.db,
      this.coordinationKey(key),
      ownerToken,
      next.status,
      next,
      (input) => LearningFenceSchema.parse(input),
    );
    if (!updated) {
      throw new MemoryError(
        "LEARNING_FENCE_FAILED",
        "Learning fence owner token mismatch",
        { fenceKey },
      );
    }
    return updated;
  }
}
