import {
  INFERENCE_DURABILITY_STATES,
  type InferenceDurabilityState,
} from "../../../domain/durability/index.js";
import { DurabilityError } from "../../../durability/errors.js";
import { assertProjectScope } from "../../../domain/project-scope.js";
import type { InferenceDurabilityPort } from "../../../durability/inference.js";
import {
  StoredPlanRecordSchema,
  type PlanRepository,
  type StoredPlanRecord,
} from "../../../planning/plan-repository.js";
import type { PlanVersion } from "../../../domain/plan/execution-plan.js";
import { PlanningError } from "../../../planning/errors.js";
import {
  aggregatePlanningUsage,
  type PlanningModelUsage,
  type PlanningTokenReservationRequest,
  type PlanningUsageLedger,
  type PlanningUsageSettle,
} from "../../../planning/model.js";
import { ValidationError } from "../../../validation/errors.js";
import {
  aggregateValidationUsage,
  VALIDATION_OPERATION_CATEGORY,
  type ValidationModelUsage,
  type ValidationTokenReservationRequest,
  type ValidationUsageLedger,
  type ValidationUsageSettle,
} from "../../../validation/model.js";
import {
  parseValidationDecision,
  type ValidationDecision,
} from "../../../domain/validation/index.js";
import type { ValidationDecisionRepository } from "../../../validation/decision-repository.js";
import {
  isTerminalApprovalRequestStatus,
  parseApprovalRequest,
  parseApprovalDecisionCard,
  parseAuthorizationRecord,
  parseModificationRequest,
  type ApprovalDecisionCard,
  type ApprovalRequest,
  type AuthorizationRecord,
  type ModificationRequest,
} from "../../../domain/authorization/index.js";
import { AuthorizationError } from "../../../authorization/errors.js";
import type {
  ApprovalRequestRepository,
  ApprovalRequestStatusExtras,
} from "../../../authorization/approval-request-repository.js";
import type { AuthorizationRecordRepository } from "../../../authorization/authorization-record-repository.js";
import type { ModificationRequestRepository } from "../../../authorization/modification-request-repository.js";
import type { DecisionCardStore } from "../../../authorization/decision-card-store.js";
import {
  parseExecutionAttempt,
  parseExecutionArtifact,
  parseExecutionResult,
  parseStepExecutionResult,
  type ExecutionAttempt,
  type ExecutionArtifact,
  type ExecutionResult,
  type StepExecutionResult,
} from "../../../domain/execution/index.js";
import { ExecutionError } from "../../../execution/errors.js";
import type { ExecutionAttemptRepository } from "../../../execution/attempt-repository.js";
import type { ExecutionArtifactRepository } from "../../../execution/artifact-repository.js";
import type { StepExecutionRepository } from "../../../execution/step-repository.js";
import {
  parseCompletionRecord,
  parseOutcomeVerificationRecord,
  parseVerificationEvidence,
  type CompletionRecord,
  type OutcomeVerificationRecord,
  type VerificationEvidence,
} from "../../../domain/verification/index.js";
import { VerificationError } from "../../../verification/errors.js";
import type { OutcomeVerificationRepository } from "../../../verification/outcome-repository.js";
import type { CompletionRecordRepository } from "../../../verification/completion-repository.js";
import type { VerificationEvidenceRepository } from "../../../verification/evidence-repository.js";
import type {
  VerificationInferenceLedger,
  VerificationInferenceRecord,
} from "../../../verification/inference-ledger.js";
import {
  parseHistoricalRunRecord,
  parseLearningCandidate,
  parseLearningLedgerEvent,
  parsePrecedentContradictionRecord,
  parsePrecedentPromotionDecision,
  parsePromotedPrecedent,
  type HistoricalRunRecord,
  type LearningCandidate,
  type LearningCandidateStatus,
  type LearningLedgerEvent,
  type PrecedentContradictionRecord,
  type PrecedentPromotionDecision,
  type PrecedentStatus,
  type PromotedPrecedent,
  type ContradictionResolutionStatus,
} from "../../../domain/memory/index.js";
import { MemoryError } from "../../../memory/errors.js";
import type { HistoricalRunRepository } from "../../../memory/historical-run-repository.js";
import type { LearningCandidateRepository } from "../../../memory/candidate-repository.js";
import type { PromotedPrecedentRepository } from "../../../memory/promoted-precedent-repository.js";
import type { PrecedentPromotionDecisionRepository } from "../../../memory/promotion-decision-repository.js";
import type { LearningLedgerRepository } from "../../../memory/ledger-repository.js";
import type { PrecedentContradictionRepository } from "../../../memory/contradiction-repository.js";
import type {
  LearningInferenceLedger,
  LearningInferenceRecord,
} from "../../../memory/inference-ledger.js";
import {
  AnomalyFindingSchema,
  ObservabilityLedgerEventSchema,
  OptimizationCandidateSchema,
  PhaseTelemetryRecordSchema,
  RunTelemetryRecordSchema,
  SLOEvaluationSchema,
  SystemHealthSnapshotSchema,
  type AnomalyFinding,
  type ObservabilityLedgerEvent,
  type OptimizationCandidate,
  type PhaseTelemetryRecord,
  type RunTelemetryRecord,
  type SLOEvaluation,
  type SystemHealthSnapshot,
} from "../../../domain/observability/index.js";
import type {
  AnomalyFindingRepository,
  ObservabilityLedger,
  OptimizationCandidateRepository,
  PhaseTelemetryRepository,
  RunTelemetryRepository,
  SLOEvaluationRepository,
  SystemHealthSnapshotRepository,
} from "../../../observability/repositories.js";
import {
  parseRepositorySource,
  type RepositorySource,
  type RepositorySourceRegistry,
} from "../../../ingestion/repository-source.js";
import {
  LockedRepositoryStateSchema,
  type LockedRepositoryState,
  type LockedRepositoryStore,
} from "../../../ingestion/locked-state.js";
import {
  parseEvidenceRecord,
  type EvidenceRecord,
} from "../../../domain/evidence/evidence.js";
import type {
  EvidenceRegistry,
  VerifiedRepositoryContext,
  VerifiedRepositoryContextStore,
} from "../../../ingestion/context.js";
import { VerifiedRepositoryContextSchema } from "../../../ingestion/context.js";
import {
  ProjectIndexSchema,
  repositoryIndexCacheKeyString,
  type ProjectIndex,
  type RepositoryIndexCacheKey,
  type RepositoryIndexStore,
} from "../../../ingestion/index-model.js";
import type { PostgresDatabase } from "../database.js";
import { PostgresJsonDocuments } from "../documents.js";
import { hydrateRecord } from "../hydrate.js";

const C = {
  plans: "plans",
  planningUsage: "planning_usage",
  validationUsage: "validation_usage",
  validationDecisions: "validation_decisions",
  approvalRequests: "approval_requests",
  authorizationRecords: "authorization_records",
  modificationRequests: "modification_requests",
  decisionCards: "decision_cards",
  executionAttempts: "execution_attempts",
  stepExecutions: "step_executions",
  executionArtifacts: "execution_artifacts",
  executionResults: "execution_results",
  outcomeVerifications: "outcome_verifications",
  completionRecords: "completion_records",
  verificationEvidence: "verification_evidence",
  verificationInference: "verification_inference",
  historicalRuns: "historical_runs",
  learningCandidates: "learning_candidates",
  promotedPrecedents: "promoted_precedents",
  promotionDecisions: "promotion_decisions",
  learningLedger: "learning_ledger",
  contradictions: "contradictions",
  learningInference: "learning_inference",
  runTelemetry: "run_telemetry",
  phaseTelemetry: "phase_telemetry",
  healthSnapshots: "health_snapshots",
  sloEvaluations: "slo_evaluations",
  anomalies: "anomalies",
  optimizationCandidates: "optimization_candidates",
  observabilityLedger: "observability_ledger",
  verifiedContexts: "verified_contexts",
  lockedRepos: "locked_repos",
  evidenceRegistry: "evidence_registry",
  repositoryIndexes: "repository_indexes",
  repositorySources: "repository_sources",
  runTelemetryWindows: "run_telemetry_windows",
} as const;

function isConflict(error: unknown): boolean {
  return error instanceof DurabilityError && error.code === "DURABLE_CONFLICT";
}

function isDurabilityState(value: unknown): value is InferenceDurabilityState {
  return (
    typeof value === "string" &&
    (INFERENCE_DURABILITY_STATES as readonly string[]).includes(value)
  );
}

function planProjectId(record: StoredPlanRecord): string | undefined {
  const plan = record.plan as { projectId?: unknown };
  return typeof plan.projectId === "string" ? plan.projectId : undefined;
}

async function listByJsonField<T>(
  db: PostgresDatabase,
  collection: string,
  field: string,
  value: string,
  parse: (input: unknown) => T,
): Promise<T[]> {
  const result = await db.query<{ payload: unknown; document_id: string }>(
    `SELECT document_id, payload FROM json_documents
     WHERE collection = $1 AND payload->>$2 = $3
     ORDER BY created_at ASC, document_id ASC`,
    [collection, field, value],
  );
  return result.rows.map((row) =>
    hydrateRecord(parse, row.payload, `${collection}:${row.document_id}`),
  );
}

function parsePlanningUsageDocument(input: unknown): {
  record: PlanningModelUsage;
  durabilityState: InferenceDurabilityState;
} {
  if (typeof input !== "object" || input === null) {
    throw new Error("Planning usage document is not an object");
  }
  const doc = input as { record?: unknown; durabilityState?: unknown };
  if (typeof doc.record !== "object" || doc.record === null) {
    throw new Error("Planning usage record missing");
  }
  const record = doc.record as PlanningModelUsage;
  if (typeof record.callId !== "string" || typeof record.runId !== "string") {
    throw new Error("Planning usage record invalid");
  }
  if (!isDurabilityState(doc.durabilityState)) {
    throw new Error("Planning usage durability state invalid");
  }
  return { record, durabilityState: doc.durabilityState };
}

function parseValidationUsageDocument(input: unknown): {
  record: ValidationModelUsage;
  durabilityState: InferenceDurabilityState;
} {
  if (typeof input !== "object" || input === null) {
    throw new Error("Validation usage document is not an object");
  }
  const doc = input as { record?: unknown; durabilityState?: unknown };
  if (typeof doc.record !== "object" || doc.record === null) {
    throw new Error("Validation usage record missing");
  }
  const record = doc.record as ValidationModelUsage;
  if (typeof record.callId !== "string" || typeof record.runId !== "string") {
    throw new Error("Validation usage record invalid");
  }
  if (!isDurabilityState(doc.durabilityState)) {
    throw new Error("Validation usage durability state invalid");
  }
  return { record, durabilityState: doc.durabilityState };
}

function parseVerificationInferenceDocument(input: unknown): {
  record: VerificationInferenceRecord;
  durabilityState: InferenceDurabilityState;
} {
  if (typeof input !== "object" || input === null) {
    throw new Error("Verification inference document is not an object");
  }
  const doc = input as { record?: unknown; durabilityState?: unknown };
  if (typeof doc.record !== "object" || doc.record === null) {
    throw new Error("Verification inference record missing");
  }
  const record = doc.record as VerificationInferenceRecord;
  if (typeof record.recordId !== "string" || typeof record.runId !== "string") {
    throw new Error("Verification inference record invalid");
  }
  if (!isDurabilityState(doc.durabilityState)) {
    throw new Error("Verification inference durability state invalid");
  }
  return { record, durabilityState: doc.durabilityState };
}

function durabilityForSettle(
  outcome: PlanningUsageSettle["outcome"] | ValidationUsageSettle["outcome"] | "RELEASED",
): InferenceDurabilityState {
  return outcome === "RELEASED" ? "FAILED_PRE_DISPATCH" : "SETTLED";
}

function assertApprovalBindingUnchanged(
  before: ApprovalRequest,
  after: ApprovalRequest,
): void {
  const fields: (keyof ApprovalRequest)[] = [
    "approvalRequestId",
    "projectId",
    "objectiveId",
    "objectiveVersion",
    "planId",
    "planVersion",
    "planHash",
    "repositoryCommitSha",
    "repositoryFingerprint",
    "policyBundleId",
    "policyBundleHash",
    "validationDecisionId",
    "validationDecision",
    "decisionCardHash",
    "capabilitySetFingerprint",
    "decisionNonceHash",
    "createdAt",
    "expiresAt",
    "replacesApprovalRequestId",
  ];
  for (const field of fields) {
    if (before[field] !== after[field]) {
      throw new AuthorizationError(
        "APPROVAL_REQUEST_IMMUTABLE",
        `ApprovalRequest binding field ${String(field)} is immutable after creation`,
        { approvalRequestId: before.approvalRequestId, field },
      );
    }
  }
}

function historicalOutcomeKey(input: {
  runId: string;
  outcome: string;
  outcomeVerificationId?: string;
}): string {
  return [
    input.runId,
    input.outcome,
    input.outcomeVerificationId ?? "",
  ].join(":");
}

function precedentKey(precedentId: string, version: number): string {
  return `${precedentId}:v${version}`;
}

export class PostgresPlanRepository implements PlanRepository {
  private readonly docs: PostgresJsonDocuments;

  constructor(db: PostgresDatabase) {
    this.docs = new PostgresJsonDocuments(db);
    this.db = db;
  }

  private readonly db: PostgresDatabase;

  async save(record: StoredPlanRecord): Promise<StoredPlanRecord> {
    const parsed = StoredPlanRecordSchema.parse(record);
    const uniqueKey = `${parsed.runId}:${parsed.planVersion}`;
    const existing = await this.docs.getByUniqueKey(
      C.plans,
      uniqueKey,
      (input) => StoredPlanRecordSchema.parse(input),
    );
    if (existing && existing.planId !== parsed.planId) {
      throw new Error(
        `Run ${parsed.runId} already has planVersion ${parsed.planVersion} (${existing.planId})`,
      );
    }
    const projectId = planProjectId(parsed);
    await this.docs.upsert({
      collection: C.plans,
      documentId: parsed.planId,
      payload: parsed,
      runId: parsed.runId,
      uniqueKey,
      ...(projectId !== undefined ? { projectId } : {}),
    });
    return parsed;
  }

  async getById(planId: string): Promise<StoredPlanRecord | null> {
    return this.docs.get(C.plans, planId, (input) =>
      StoredPlanRecordSchema.parse(input),
    );
  }

  async getByRunId(runId: string): Promise<StoredPlanRecord | null> {
    const result = await this.db.query<{ payload: unknown; document_id: string }>(
      `SELECT document_id, payload FROM json_documents
       WHERE collection = $1 AND run_id = $2
       ORDER BY (payload->>'planVersion')::int DESC, created_at DESC
       LIMIT 1`,
      [C.plans, runId],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return hydrateRecord(
      (input) => StoredPlanRecordSchema.parse(input),
      row.payload,
      `${C.plans}:${row.document_id}`,
    );
  }

  async getVersion(
    runId: string,
    planVersion: PlanVersion,
  ): Promise<StoredPlanRecord | null> {
    return this.docs.getByUniqueKey(
      C.plans,
      `${runId}:${planVersion}`,
      (input) => StoredPlanRecordSchema.parse(input),
    );
  }

  async listByRunId(runId: string): Promise<readonly StoredPlanRecord[]> {
    const rows = await this.docs.listByRun(C.plans, runId, (input) =>
      StoredPlanRecordSchema.parse(input),
    );
    return [...rows].sort((a, b) => a.planVersion - b.planVersion);
  }

  async exists(planId: string): Promise<boolean> {
    return this.docs.exists(C.plans, planId);
  }

  async markSuperseded(planId: string): Promise<StoredPlanRecord> {
    const existing = await this.getById(planId);
    if (!existing) {
      throw new Error(`Unknown planId: ${planId}`);
    }
    const next = StoredPlanRecordSchema.parse({
      ...existing,
      status: "SUPERSEDED",
    });
    await this.docs.updatePayload({
      collection: C.plans,
      documentId: planId,
      payload: next,
    });
    return next;
  }
}

export class PostgresPlanningUsageLedger
  implements PlanningUsageLedger, InferenceDurabilityPort
{
  private readonly docs: PostgresJsonDocuments;

  constructor(private readonly db: PostgresDatabase) {
    this.docs = new PostgresJsonDocuments(db);
  }

  async reserve(
    request: PlanningTokenReservationRequest,
  ): Promise<PlanningModelUsage> {
    return this.db.withTransaction(async () => {
      await this.db.query(
        `SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`,
        [`${C.planningUsage}:${request.runId}`],
      );
      await this.db.query(
        `SELECT document_id FROM json_documents
         WHERE collection = $1 AND run_id = $2
         FOR UPDATE`,
        [C.planningUsage, request.runId],
      );
      const existing = await this.docs.get(C.planningUsage, request.callId, parsePlanningUsageDocument);
      if (existing) {
        throw new Error(
          `Planning usage callId already exists: ${request.callId}`,
        );
      }
      const records = await this.recordsForRun(request.runId);
      if (records.some((record) => record.budgetInvariantViolation)) {
        throw new PlanningError(
          "PLANNING_MODEL_BUDGET_INVARIANT_VIOLATION",
          "Planning inference budget invariant previously violated; further model calls are blocked",
          { runId: request.runId },
        );
      }
      const aggregate = aggregatePlanningUsage(records);
      if (aggregate.llmCalls >= request.maximumLlmCalls) {
        throw new PlanningError(
          "PLANNING_MODEL_BUDGET_EXCEEDED",
          "Planning inference LLM call budget exhausted",
          {
            dimension: "maximumLlmCalls",
            used: aggregate.llmCalls,
            limit: request.maximumLlmCalls,
            budgetProfileId: request.budgetProfileId,
          },
        );
      }
      const remaining =
        request.maximumTotalTokens -
        aggregate.completedActualTokens -
        aggregate.activeReservedTokens;
      if (request.reservedTokens > remaining) {
        throw new PlanningError(
          "PLANNING_MODEL_BUDGET_EXCEEDED",
          "Planning inference token reservation exceeds remaining budget",
          {
            dimension: "maximumTotalTokens",
            requiredReservation: request.reservedTokens,
            remaining,
            completedActualTokens: aggregate.completedActualTokens,
            activeReservedTokens: aggregate.activeReservedTokens,
            limit: request.maximumTotalTokens,
            budgetProfileId: request.budgetProfileId,
          },
        );
      }
      const record: PlanningModelUsage = {
        callId: request.callId,
        runId: request.runId,
        planningAttempt: request.planningAttempt,
        operation: request.operation,
        provider: request.provider,
        model: request.model,
        reservedTokens: request.reservedTokens,
        startedAt: request.startedAt,
        status: "STARTED",
      };
      await this.docs.insert({
        collection: C.planningUsage,
        documentId: request.callId,
        uniqueKey: request.callId,
        runId: request.runId,
        payload: { record, durabilityState: "RESERVED" as const },
      });
      return { ...record };
    });
  }

  async settle(
    callId: string,
    update: PlanningUsageSettle,
  ): Promise<PlanningModelUsage> {
    return this.db.withTransaction(async () => {
      const existing = await this.requireDocument(callId);
      await this.db.query(
        `SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`,
        [`${C.planningUsage}:${existing.record.runId}`],
      );
      await this.db.query(
        `SELECT document_id FROM json_documents
         WHERE collection = $1 AND run_id = $2
         FOR UPDATE`,
        [C.planningUsage, existing.record.runId],
      );
      const current = await this.requireDocument(callId);
      if (current.record.status !== "STARTED") {
        throw new Error(
          `Planning usage callId ${callId} already settled as ${current.record.status}`,
        );
      }
      const settled = settlePlanningRecord(current.record, update);
      await this.docs.updatePayload({
        collection: C.planningUsage,
        documentId: callId,
        payload: {
          record: settled,
          durabilityState: durabilityForSettle(update.outcome),
        },
      });
      return { ...settled };
    });
  }

  async listByRunId(runId: string): Promise<readonly PlanningModelUsage[]> {
    return this.recordsForRun(runId);
  }

  async hasBudgetInvariantViolation(runId: string): Promise<boolean> {
    return (await this.recordsForRun(runId)).some(
      (record) => record.budgetInvariantViolation === true,
    );
  }

  async markDispatched(callId: string): Promise<void> {
    const current = await this.requireDocument(callId);
    if (current.durabilityState === "DISPATCH_STARTED") {
      return;
    }
    await this.docs.updatePayload({
      collection: C.planningUsage,
      documentId: callId,
      payload: { record: current.record, durabilityState: "DISPATCH_STARTED" },
    });
  }

  async getDurabilityState(
    callId: string,
  ): Promise<InferenceDurabilityState | null> {
    const found = await this.docs.get(
      C.planningUsage,
      callId,
      parsePlanningUsageDocument,
    );
    return found?.durabilityState ?? null;
  }

  async markAmbiguous(callId: string): Promise<void> {
    const current = await this.requireDocument(callId);
    await this.docs.updatePayload({
      collection: C.planningUsage,
      documentId: callId,
      payload: { record: current.record, durabilityState: "AMBIGUOUS" },
    });
  }

  private async recordsForRun(runId: string): Promise<PlanningModelUsage[]> {
    const docs = await this.docs.listByRun(
      C.planningUsage,
      runId,
      parsePlanningUsageDocument,
    );
    return docs.map((doc) => doc.record);
  }

  private async requireDocument(callId: string): Promise<{
    record: PlanningModelUsage;
    durabilityState: InferenceDurabilityState;
  }> {
    const found = await this.docs.get(
      C.planningUsage,
      callId,
      parsePlanningUsageDocument,
    );
    if (!found) {
      throw new Error(`Unknown planning usage callId: ${callId}`);
    }
    return found;
  }
}

function settlePlanningRecord(
  current: PlanningModelUsage,
  update: PlanningUsageSettle,
): PlanningModelUsage {
  if (update.charging === "NONE") {
    return {
      ...current,
      status: "RELEASED",
      completedAt: update.completedAt,
      charging: "NONE",
      totalUsage: 0,
    };
  }
  if (update.charging === "RESERVATION") {
    return {
      ...current,
      status: update.outcome,
      completedAt: update.completedAt,
      charging: "RESERVATION",
      totalUsage: current.reservedTokens,
    };
  }
  const settled: PlanningModelUsage = {
    ...current,
    status: update.outcome,
    completedAt: update.completedAt,
    charging: "ACTUAL",
    totalUsage: update.totalUsage,
  };
  if (update.inputUsage !== undefined) {
    settled.inputUsage = update.inputUsage;
  }
  if (update.outputUsage !== undefined) {
    settled.outputUsage = update.outputUsage;
  }
  if (update.markInvariantViolation) {
    settled.budgetInvariantViolation = true;
  }
  return settled;
}

export class PostgresValidationUsageLedger
  implements ValidationUsageLedger, InferenceDurabilityPort
{
  private readonly docs: PostgresJsonDocuments;

  constructor(private readonly db: PostgresDatabase) {
    this.docs = new PostgresJsonDocuments(db);
  }

  async reserve(
    request: ValidationTokenReservationRequest,
  ): Promise<ValidationModelUsage> {
    return this.db.withTransaction(async () => {
      await this.db.query(
        `SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`,
        [`${C.validationUsage}:${request.runId}`],
      );
      await this.db.query(
        `SELECT document_id FROM json_documents
         WHERE collection = $1 AND run_id = $2
         FOR UPDATE`,
        [C.validationUsage, request.runId],
      );
      const existing = await this.docs.get(
        C.validationUsage,
        request.callId,
        parseValidationUsageDocument,
      );
      if (existing) {
        throw new Error(
          `Validation usage callId already exists: ${request.callId}`,
        );
      }
      const records = await this.recordsForRun(request.runId);
      if (records.some((record) => record.budgetInvariantViolation)) {
        throw new ValidationError(
          "VALIDATION_MODEL_BUDGET_INVARIANT_VIOLATION",
          "Validation inference budget invariant previously violated; further model calls are blocked",
          { runId: request.runId },
        );
      }
      const aggregate = aggregateValidationUsage(records);
      if (aggregate.llmCalls >= request.maximumLlmCalls) {
        throw new ValidationError(
          request.operation === "PLAN_REVISION"
            ? "REVISION_BUDGET_EXCEEDED"
            : "VALIDATION_MODEL_BUDGET_EXCEEDED",
          request.operation === "PLAN_REVISION"
            ? "Semantic revision LLM call budget exhausted"
            : "Validation inference LLM call budget exhausted",
          {
            dimension: "maximumLlmCalls",
            used: aggregate.llmCalls,
            limit: request.maximumLlmCalls,
            budgetProfileId: request.budgetProfileId,
            operation: request.operation,
            operationCategory: VALIDATION_OPERATION_CATEGORY[request.operation],
          },
        );
      }
      const remaining =
        request.maximumTotalTokens -
        aggregate.completedActualTokens -
        aggregate.activeReservedTokens;
      if (request.reservedTokens > remaining) {
        throw new ValidationError(
          request.operation === "PLAN_REVISION"
            ? "REVISION_BUDGET_EXCEEDED"
            : "VALIDATION_MODEL_BUDGET_EXCEEDED",
          request.operation === "PLAN_REVISION"
            ? "Semantic revision token reservation exceeds remaining budget"
            : "Validation inference token reservation exceeds remaining budget",
          {
            dimension: "maximumTotalTokens",
            requiredReservation: request.reservedTokens,
            remaining,
            completedActualTokens: aggregate.completedActualTokens,
            activeReservedTokens: aggregate.activeReservedTokens,
            limit: request.maximumTotalTokens,
            budgetProfileId: request.budgetProfileId,
            operation: request.operation,
            operationCategory: VALIDATION_OPERATION_CATEGORY[request.operation],
          },
        );
      }
      const record: ValidationModelUsage = {
        callId: request.callId,
        runId: request.runId,
        planId: request.planId,
        planVersion: request.planVersion,
        validationAttempt: request.validationAttempt,
        operation: request.operation,
        operationCategory: VALIDATION_OPERATION_CATEGORY[request.operation],
        provider: request.provider,
        model: request.model,
        reservedTokens: request.reservedTokens,
        startedAt: request.startedAt,
        status: "STARTED",
      };
      if (request.sourcePlanVersion !== undefined) {
        record.sourcePlanVersion = request.sourcePlanVersion;
      }
      if (request.targetPlanVersion !== undefined) {
        record.targetPlanVersion = request.targetPlanVersion;
      }
      if (request.revisionAttempt !== undefined) {
        record.revisionAttempt = request.revisionAttempt;
      }
      await this.docs.insert({
        collection: C.validationUsage,
        documentId: request.callId,
        uniqueKey: request.callId,
        runId: request.runId,
        payload: { record, durabilityState: "RESERVED" as const },
      });
      return { ...record };
    });
  }

  async settle(
    callId: string,
    update: ValidationUsageSettle,
  ): Promise<ValidationModelUsage> {
    return this.db.withTransaction(async () => {
      const existing = await this.requireDocument(callId);
      await this.db.query(
        `SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`,
        [`${C.validationUsage}:${existing.record.runId}`],
      );
      await this.db.query(
        `SELECT document_id FROM json_documents
         WHERE collection = $1 AND run_id = $2
         FOR UPDATE`,
        [C.validationUsage, existing.record.runId],
      );
      const current = await this.requireDocument(callId);
      if (current.record.status !== "STARTED") {
        throw new Error(
          `Validation usage callId ${callId} already settled as ${current.record.status}`,
        );
      }
      const settled = settleValidationRecord(current.record, update);
      await this.docs.updatePayload({
        collection: C.validationUsage,
        documentId: callId,
        payload: {
          record: settled,
          durabilityState: durabilityForSettle(update.outcome),
        },
      });
      return { ...settled };
    });
  }

  async listByRunId(runId: string): Promise<readonly ValidationModelUsage[]> {
    return this.recordsForRun(runId);
  }

  async hasBudgetInvariantViolation(runId: string): Promise<boolean> {
    return (await this.recordsForRun(runId)).some(
      (record) => record.budgetInvariantViolation === true,
    );
  }

  async markDispatched(callId: string): Promise<void> {
    const current = await this.requireDocument(callId);
    if (current.durabilityState === "DISPATCH_STARTED") {
      return;
    }
    await this.docs.updatePayload({
      collection: C.validationUsage,
      documentId: callId,
      payload: { record: current.record, durabilityState: "DISPATCH_STARTED" },
    });
  }

  async getDurabilityState(
    callId: string,
  ): Promise<InferenceDurabilityState | null> {
    const found = await this.docs.get(
      C.validationUsage,
      callId,
      parseValidationUsageDocument,
    );
    return found?.durabilityState ?? null;
  }

  async markAmbiguous(callId: string): Promise<void> {
    const current = await this.requireDocument(callId);
    await this.docs.updatePayload({
      collection: C.validationUsage,
      documentId: callId,
      payload: { record: current.record, durabilityState: "AMBIGUOUS" },
    });
  }

  private async recordsForRun(runId: string): Promise<ValidationModelUsage[]> {
    const docs = await this.docs.listByRun(
      C.validationUsage,
      runId,
      parseValidationUsageDocument,
    );
    return docs.map((doc) => doc.record);
  }

  private async requireDocument(callId: string): Promise<{
    record: ValidationModelUsage;
    durabilityState: InferenceDurabilityState;
  }> {
    const found = await this.docs.get(
      C.validationUsage,
      callId,
      parseValidationUsageDocument,
    );
    if (!found) {
      throw new Error(`Unknown validation usage callId: ${callId}`);
    }
    return found;
  }
}

function settleValidationRecord(
  current: ValidationModelUsage,
  update: ValidationUsageSettle,
): ValidationModelUsage {
  if (update.charging === "NONE") {
    return {
      ...current,
      status: "RELEASED",
      completedAt: update.completedAt,
      charging: "NONE",
      totalUsage: 0,
    };
  }
  if (update.charging === "RESERVATION") {
    return {
      ...current,
      status: update.outcome,
      completedAt: update.completedAt,
      charging: "RESERVATION",
      totalUsage: current.reservedTokens,
    };
  }
  const settled: ValidationModelUsage = {
    ...current,
    status: update.outcome,
    completedAt: update.completedAt,
    charging: "ACTUAL",
    totalUsage: update.totalUsage,
  };
  if (update.inputUsage !== undefined) {
    settled.inputUsage = update.inputUsage;
  }
  if (update.outputUsage !== undefined) {
    settled.outputUsage = update.outputUsage;
  }
  if (update.markInvariantViolation) {
    settled.budgetInvariantViolation = true;
  }
  return settled;
}

export class PostgresValidationDecisionRepository
  implements ValidationDecisionRepository
{
  private readonly docs: PostgresJsonDocuments;

  constructor(db: PostgresDatabase) {
    this.docs = new PostgresJsonDocuments(db);
  }

  async save(decision: ValidationDecision): Promise<ValidationDecision> {
    const parsed = parseValidationDecision(decision);
    try {
      await this.docs.insert({
        collection: C.validationDecisions,
        documentId: parsed.validationDecisionId,
        uniqueKey: parsed.validationDecisionId,
        runId: parsed.runId,
        payload: parsed,
        immutable: true,
      });
    } catch (error) {
      if (isConflict(error)) {
        throw new Error(
          `Validation decision already exists: ${parsed.validationDecisionId}`,
        );
      }
      throw error;
    }
    return parsed;
  }

  async getById(
    validationDecisionId: string,
  ): Promise<ValidationDecision | null> {
    return this.docs.get(C.validationDecisions, validationDecisionId, parseValidationDecision);
  }

  async getLatestByRunId(runId: string): Promise<ValidationDecision | null> {
    const list = await this.listByRunId(runId);
    return list[list.length - 1] ?? null;
  }

  async getByPlan(
    runId: string,
    planId: string,
    planVersion: PlanVersion,
  ): Promise<ValidationDecision | null> {
    const decisions = await this.listByRunId(runId);
    const matches = decisions.filter(
      (decision) =>
        decision.planId === planId && decision.planVersion === planVersion,
    );
    return matches[matches.length - 1] ?? null;
  }

  async listByRunId(runId: string): Promise<readonly ValidationDecision[]> {
    return this.docs.listByRun(
      C.validationDecisions,
      runId,
      parseValidationDecision,
    );
  }

  async exists(validationDecisionId: string): Promise<boolean> {
    return this.docs.exists(C.validationDecisions, validationDecisionId);
  }
}

export class PostgresApprovalRequestRepository
  implements ApprovalRequestRepository
{
  private readonly docs: PostgresJsonDocuments;

  constructor(private readonly db: PostgresDatabase) {
    this.docs = new PostgresJsonDocuments(db);
  }

  async save(request: ApprovalRequest): Promise<ApprovalRequest> {
    const parsed = parseApprovalRequest(request);
    return this.db.withTransaction(async () => {
      try {
        await this.docs.insert({
          collection: C.approvalRequests,
          documentId: parsed.approvalRequestId,
          uniqueKey: parsed.approvalRequestId,
          runId: parsed.runId,
          projectId: parsed.projectId,
          payload: parsed,
        });
      } catch (error) {
        if (isConflict(error)) {
          throw new AuthorizationError(
            "APPROVAL_REQUEST_ALREADY_EXISTS",
            `Approval request already exists: ${parsed.approvalRequestId}`,
          );
        }
        throw error;
      }
      await this.db.query(
        `INSERT INTO nonce_state (approval_request_id, nonce_hash, status)
         VALUES ($1, $2, 'PENDING')
         ON CONFLICT DO NOTHING`,
        [parsed.approvalRequestId, parsed.decisionNonceHash],
      );
      return parsed;
    });
  }

  async getById(approvalRequestId: string): Promise<ApprovalRequest | null> {
    return this.docs.get(C.approvalRequests, approvalRequestId, parseApprovalRequest);
  }

  async getPendingByRun(runId: string): Promise<ApprovalRequest | null> {
    const list = await this.listByRun(runId);
    return list.find((request) => request.status === "PENDING") ?? null;
  }

  async getByPlanVersion(
    runId: string,
    planId: string,
    planVersion: PlanVersion,
  ): Promise<ApprovalRequest | null> {
    const list = await this.listByRun(runId);
    const matches = list.filter(
      (request) =>
        request.planId === planId && request.planVersion === planVersion,
    );
    return matches[matches.length - 1] ?? null;
  }

  async exists(approvalRequestId: string): Promise<boolean> {
    return this.docs.exists(C.approvalRequests, approvalRequestId);
  }

  async listAll(): Promise<readonly ApprovalRequest[]> {
    return this.docs.listCollection(C.approvalRequests, parseApprovalRequest);
  }

  async listByRun(runId: string): Promise<readonly ApprovalRequest[]> {
    return this.docs.listByRun(C.approvalRequests, runId, parseApprovalRequest);
  }

  async updateStatus(
    approvalRequestId: string,
    status: ApprovalRequest["status"],
    extras: ApprovalRequestStatusExtras = {},
  ): Promise<ApprovalRequest> {
    const existing = await this.getById(approvalRequestId);
    if (!existing) {
      throw new AuthorizationError(
        "APPROVAL_REQUEST_NOT_FOUND",
        `Unknown approval request: ${approvalRequestId}`,
      );
    }
    if (isTerminalApprovalRequestStatus(existing.status)) {
      if (status === "PENDING") {
        throw new AuthorizationError(
          "APPROVAL_REQUEST_IMMUTABLE",
          `Terminal approval request ${approvalRequestId} (${existing.status}) cannot return to PENDING`,
        );
      }
      if (status !== existing.status) {
        throw new AuthorizationError(
          "APPROVAL_REQUEST_IMMUTABLE",
          `Terminal approval request ${approvalRequestId} is ${existing.status} and cannot transition to ${status}`,
        );
      }
    }
    if (status === "PENDING" && existing.status !== "PENDING") {
      throw new AuthorizationError(
        "APPROVAL_REQUEST_IMMUTABLE",
        `Cannot reactivate approval request ${approvalRequestId} to PENDING`,
      );
    }
    const next = parseApprovalRequest({
      ...existing,
      status,
      ...(extras.deliveryFailedAt !== undefined
        ? { deliveryFailedAt: extras.deliveryFailedAt }
        : {}),
      ...(extras.deliveryFailureCode !== undefined
        ? { deliveryFailureCode: extras.deliveryFailureCode }
        : {}),
      ...(extras.failureReasonCode !== undefined
        ? { failureReasonCode: extras.failureReasonCode }
        : {}),
    });
    assertApprovalBindingUnchanged(existing, next);
    await this.docs.updatePayload({
      collection: C.approvalRequests,
      documentId: approvalRequestId,
      payload: next,
    });
    return next;
  }
}

export class PostgresAuthorizationRecordRepository
  implements AuthorizationRecordRepository
{
  private readonly docs: PostgresJsonDocuments;

  constructor(db: PostgresDatabase) {
    this.docs = new PostgresJsonDocuments(db);
  }

  async append(record: AuthorizationRecord): Promise<AuthorizationRecord> {
    const parsed = parseAuthorizationRecord(record);
    const existingId = await this.docs.exists(
      C.authorizationRecords,
      parsed.authorizationRecordId,
    );
    if (existingId) {
      throw new AuthorizationError(
        "AUTHORIZATION_PERSISTENCE_FAILED",
        `Authorization record already exists: ${parsed.authorizationRecordId}`,
      );
    }
    const existingApproval = await this.docs.getByUniqueKey(
      C.authorizationRecords,
      parsed.approvalRequestId,
      parseAuthorizationRecord,
    );
    if (existingApproval) {
      throw new AuthorizationError(
        "AUTHORIZATION_ALREADY_DECIDED",
        `Authorization already recorded for request ${parsed.approvalRequestId}`,
      );
    }
    try {
      await this.docs.insert({
        collection: C.authorizationRecords,
        documentId: parsed.authorizationRecordId,
        uniqueKey: parsed.approvalRequestId,
        runId: parsed.runId,
        projectId: parsed.projectId,
        payload: parsed,
        immutable: true,
      });
    } catch (error) {
      if (isConflict(error)) {
        throw new AuthorizationError(
          "AUTHORIZATION_ALREADY_DECIDED",
          `Authorization already recorded for request ${parsed.approvalRequestId}`,
        );
      }
      throw error;
    }
    return parsed;
  }

  async getByApprovalRequest(
    approvalRequestId: string,
  ): Promise<AuthorizationRecord | null> {
    return this.docs.getByUniqueKey(
      C.authorizationRecords,
      approvalRequestId,
      parseAuthorizationRecord,
    );
  }

  async getLatestByRun(runId: string): Promise<AuthorizationRecord | null> {
    const list = await this.listByRun(runId);
    return list[list.length - 1] ?? null;
  }

  async getLatestByRunInProject(
    runId: string,
    projectId: string,
  ): Promise<AuthorizationRecord | null> {
    const record = await this.getLatestByRun(runId);
    if (!record) {
      return null;
    }
    assertProjectScope(
      record.projectId,
      projectId,
      "authorization record",
      record.authorizationRecordId,
    );
    return record;
  }

  async listByRun(runId: string): Promise<readonly AuthorizationRecord[]> {
    return this.docs.listByRun(
      C.authorizationRecords,
      runId,
      parseAuthorizationRecord,
    );
  }

  async exists(authorizationRecordId: string): Promise<boolean> {
    return this.docs.exists(C.authorizationRecords, authorizationRecordId);
  }
}

export class PostgresModificationRequestRepository
  implements ModificationRequestRepository
{
  private readonly docs: PostgresJsonDocuments;

  constructor(private readonly db: PostgresDatabase) {
    this.docs = new PostgresJsonDocuments(db);
  }

  async save(request: ModificationRequest): Promise<ModificationRequest> {
    const parsed = parseModificationRequest(request);
    try {
      await this.docs.insert({
        collection: C.modificationRequests,
        documentId: parsed.modificationRequestId,
        uniqueKey: parsed.modificationRequestId,
        runId: parsed.runId,
        payload: parsed,
      });
    } catch (error) {
      if (isConflict(error)) {
        throw new AuthorizationError(
          "MODIFICATION_REQUEST_INVALID",
          `Modification request already exists: ${parsed.modificationRequestId}`,
        );
      }
      throw error;
    }
    return parsed;
  }

  async getByApprovalRequest(
    approvalRequestId: string,
  ): Promise<ModificationRequest | null> {
    const matches = await listByJsonField(
      this.db,
      C.modificationRequests,
      "approvalRequestId",
      approvalRequestId,
      parseModificationRequest,
    );
    return matches[matches.length - 1] ?? null;
  }

  async listByRun(runId: string): Promise<readonly ModificationRequest[]> {
    return this.docs.listByRun(
      C.modificationRequests,
      runId,
      parseModificationRequest,
    );
  }
}

export class PostgresDecisionCardStore implements DecisionCardStore {
  private readonly docs: PostgresJsonDocuments;

  constructor(db: PostgresDatabase) {
    this.docs = new PostgresJsonDocuments(db);
  }

  async save(
    approvalRequestId: string,
    card: ApprovalDecisionCard,
  ): Promise<ApprovalDecisionCard> {
    const parsed = parseApprovalDecisionCard(card);
    await this.docs.upsert({
      collection: C.decisionCards,
      documentId: approvalRequestId,
      uniqueKey: approvalRequestId,
      payload: parsed,
    });
    return parsed;
  }

  async get(approvalRequestId: string): Promise<ApprovalDecisionCard | null> {
    return this.docs.get(
      C.decisionCards,
      approvalRequestId,
      parseApprovalDecisionCard,
    );
  }
}

export class PostgresExecutionAttemptRepository
  implements ExecutionAttemptRepository
{
  private readonly docs: PostgresJsonDocuments;

  constructor(db: PostgresDatabase) {
    this.docs = new PostgresJsonDocuments(db);
  }

  async save(attempt: ExecutionAttempt): Promise<ExecutionAttempt> {
    const parsed = parseExecutionAttempt(attempt);
    await this.docs.upsert({
      collection: C.executionAttempts,
      documentId: parsed.executionAttemptId,
      uniqueKey: parsed.executionAttemptId,
      runId: parsed.runId,
      payload: parsed,
    });
    return parsed;
  }

  async getById(executionAttemptId: string): Promise<ExecutionAttempt | null> {
    return this.docs.get(
      C.executionAttempts,
      executionAttemptId,
      parseExecutionAttempt,
    );
  }

  async listByRun(runId: string): Promise<readonly ExecutionAttempt[]> {
    return this.docs.listByRun(
      C.executionAttempts,
      runId,
      parseExecutionAttempt,
    );
  }

  async getLatestByRun(runId: string): Promise<ExecutionAttempt | null> {
    const list = await this.listByRun(runId);
    return list[list.length - 1] ?? null;
  }
}

export class PostgresStepExecutionRepository
  implements StepExecutionRepository
{
  private readonly docs: PostgresJsonDocuments;

  constructor(private readonly db: PostgresDatabase) {
    this.docs = new PostgresJsonDocuments(db);
  }

  async reserve(input: {
    idempotencyKey: string;
    runId: string;
    executionAttemptId: string;
    stepId: string;
    capabilityId: string;
    actionType: string;
    startedAt: string;
  }): Promise<
    | { outcome: "RESERVED"; result: StepExecutionResult }
    | { outcome: "REPLAY"; result: StepExecutionResult }
  > {
    const reserved = parseStepExecutionResult({
      stepId: input.stepId,
      idempotencyKey: input.idempotencyKey,
      capabilityId: input.capabilityId,
      actionType: input.actionType,
      status: "RESERVED",
      startedAt: input.startedAt,
      outputArtifactRefs: [],
      outputHashes: [],
      affectedTargets: [],
      executionAttemptId: input.executionAttemptId,
      runId: input.runId,
    });
    const inserted = await this.db.query<{ payload: unknown }>(
      `INSERT INTO json_documents (
         collection, document_id, run_id, unique_key, payload, immutable
       ) VALUES ($1, $2, $3, $4, $5::jsonb, FALSE)
       ON CONFLICT (collection, unique_key) WHERE unique_key IS NOT NULL
       DO NOTHING
       RETURNING payload`,
      [
        C.stepExecutions,
        input.idempotencyKey,
        input.runId,
        input.idempotencyKey,
        JSON.stringify(reserved),
      ],
    );
    if (inserted.rows[0]) {
      return { outcome: "RESERVED", result: reserved };
    }
    const existing = await this.getByIdempotencyKey(input.idempotencyKey);
    if (!existing) {
      throw new ExecutionError(
        "STEP_EXECUTION_FAILED",
        `Step reservation conflicted but could not be loaded: ${input.idempotencyKey}`,
      );
    }
    if (existing.status === "SUCCEEDED" || existing.status === "COMPENSATED") {
      return { outcome: "REPLAY", result: existing };
    }
    if (existing.status === "RUNNING") {
      throw new ExecutionError(
        "STEP_EXECUTION_STATE_UNKNOWN",
        `Step ${existing.stepId} is RUNNING with uncertain side-effect state; refusing blind re-execution`,
        { idempotencyKey: input.idempotencyKey, stepId: existing.stepId },
      );
    }
    if (existing.status === "RESERVED") {
      return { outcome: "RESERVED", result: existing };
    }
    if (
      existing.status === "FAILED" ||
      existing.status === "CONTAINED" ||
      existing.status === "SKIPPED"
    ) {
      throw new ExecutionError(
        "EXECUTION_IDEMPOTENCY_CONFLICT",
        `Step previously ended in ${existing.status}; refusing blind re-execution`,
        { idempotencyKey: input.idempotencyKey, status: existing.status },
      );
    }
    throw new ExecutionError(
      "EXECUTION_IDEMPOTENCY_CONFLICT",
      `Step reservation conflict for ${input.idempotencyKey}`,
      { idempotencyKey: input.idempotencyKey, status: existing.status },
    );
  }

  async markRunning(idempotencyKey: string): Promise<StepExecutionResult> {
    const updated = await this.db.query<{ payload: unknown }>(
      `UPDATE json_documents
       SET payload = jsonb_set(payload, '{status}', '"RUNNING"'),
           record_revision = record_revision + 1,
           updated_at = NOW()
       WHERE collection = $1
         AND unique_key = $2
         AND payload->>'status' = 'RESERVED'
         AND immutable = FALSE
       RETURNING payload`,
      [C.stepExecutions, idempotencyKey],
    );
    const row = updated.rows[0];
    if (row) {
      return hydrateRecord(
        parseStepExecutionResult,
        row.payload,
        `${C.stepExecutions}:${idempotencyKey}`,
      );
    }
    const existing = await this.getByIdempotencyKey(idempotencyKey);
    if (!existing) {
      throw new ExecutionError(
        "STEP_EXECUTION_FAILED",
        `Cannot markRunning: unknown key ${idempotencyKey}`,
      );
    }
    if (existing.status === "RUNNING") {
      return existing;
    }
    throw new ExecutionError(
      "EXECUTION_IDEMPOTENCY_CONFLICT",
      `markRunning requires RESERVED, got ${existing.status}`,
      { idempotencyKey, status: existing.status },
    );
  }

  async getByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<StepExecutionResult | null> {
    return this.docs.getByUniqueKey(
      C.stepExecutions,
      idempotencyKey,
      parseStepExecutionResult,
    );
  }

  async complete(
    idempotencyKey: string,
    result: StepExecutionResult,
  ): Promise<StepExecutionResult> {
    const existing = await this.getByIdempotencyKey(idempotencyKey);
    if (!existing) {
      throw new ExecutionError(
        "STEP_EXECUTION_FAILED",
        `Cannot complete unknown key ${idempotencyKey}`,
      );
    }
    if (existing.status !== "RUNNING") {
      throw new ExecutionError(
        "EXECUTION_IDEMPOTENCY_CONFLICT",
        `complete() requires RUNNING, got ${existing.status}`,
      );
    }
    const parsed = parseStepExecutionResult(result);
    if (parsed.idempotencyKey !== idempotencyKey) {
      throw new ExecutionError(
        "EXECUTION_IDEMPOTENCY_CONFLICT",
        "Idempotency key mismatch on complete",
      );
    }
    if (parsed.status !== "SUCCEEDED" && parsed.status !== "COMPENSATED") {
      throw new ExecutionError(
        "STEP_EXECUTION_FAILED",
        `complete() requires SUCCEEDED/COMPENSATED, got ${parsed.status}`,
      );
    }
    await this.docs.updatePayload({
      collection: C.stepExecutions,
      documentId: idempotencyKey,
      payload: parsed,
    });
    return parsed;
  }

  async fail(
    idempotencyKey: string,
    result: StepExecutionResult,
  ): Promise<StepExecutionResult> {
    const existing = await this.getByIdempotencyKey(idempotencyKey);
    if (
      existing &&
      existing.status !== "RUNNING" &&
      existing.status !== "RESERVED"
    ) {
      throw new ExecutionError(
        "EXECUTION_IDEMPOTENCY_CONFLICT",
        `fail() requires RESERVED or RUNNING, got ${existing.status}`,
      );
    }
    const parsed = parseStepExecutionResult(result);
    if (parsed.idempotencyKey !== idempotencyKey) {
      throw new ExecutionError(
        "EXECUTION_IDEMPOTENCY_CONFLICT",
        "Idempotency key mismatch on fail",
      );
    }
    await this.docs.upsert({
      collection: C.stepExecutions,
      documentId: idempotencyKey,
      uniqueKey: idempotencyKey,
      runId: parsed.runId,
      payload: parsed,
    });
    return parsed;
  }

  async reconcileSucceeded(
    idempotencyKey: string,
    result: StepExecutionResult,
  ): Promise<StepExecutionResult> {
    const existing = await this.getByIdempotencyKey(idempotencyKey);
    if (!existing || existing.status !== "RUNNING") {
      throw new ExecutionError(
        "STEP_EXECUTION_STATE_UNKNOWN",
        `Cannot reconcile: expected RUNNING for ${idempotencyKey}`,
      );
    }
    const parsed = parseStepExecutionResult({
      ...result,
      status: "SUCCEEDED",
      idempotencyKey,
    });
    await this.docs.updatePayload({
      collection: C.stepExecutions,
      documentId: idempotencyKey,
      payload: parsed,
    });
    return parsed;
  }

  async listByExecutionAttempt(
    executionAttemptId: string,
  ): Promise<readonly StepExecutionResult[]> {
    return listByJsonField(
      this.db,
      C.stepExecutions,
      "executionAttemptId",
      executionAttemptId,
      parseStepExecutionResult,
    );
  }
}

export class PostgresExecutionArtifactRepository
  implements ExecutionArtifactRepository
{
  private readonly docs: PostgresJsonDocuments;

  constructor(private readonly db: PostgresDatabase) {
    this.docs = new PostgresJsonDocuments(db);
  }

  async save(artifact: ExecutionArtifact): Promise<ExecutionArtifact> {
    const parsed = parseExecutionArtifact(artifact);
    await this.docs.upsert({
      collection: C.executionArtifacts,
      documentId: parsed.artifactId,
      uniqueKey: parsed.artifactId,
      runId: parsed.runId,
      payload: parsed,
    });
    return parsed;
  }

  async getById(artifactId: string): Promise<ExecutionArtifact | null> {
    return this.docs.get(
      C.executionArtifacts,
      artifactId,
      parseExecutionArtifact,
    );
  }

  async listByRun(runId: string): Promise<readonly ExecutionArtifact[]> {
    return this.docs.listByRun(
      C.executionArtifacts,
      runId,
      parseExecutionArtifact,
    );
  }

  async listByAttempt(
    executionAttemptId: string,
  ): Promise<readonly ExecutionArtifact[]> {
    return listByJsonField(
      this.db,
      C.executionArtifacts,
      "executionAttemptId",
      executionAttemptId,
      parseExecutionArtifact,
    );
  }
}

export class PostgresExecutionResultRepository {
  private readonly docs: PostgresJsonDocuments;

  constructor(db: PostgresDatabase) {
    this.docs = new PostgresJsonDocuments(db);
  }

  async store(fenceKey: string, result: ExecutionResult): Promise<void> {
    const parsed = parseExecutionResult(result);
    await this.docs.upsert({
      collection: C.executionResults,
      documentId: fenceKey,
      uniqueKey: fenceKey,
      runId: parsed.runId,
      payload: parsed,
    });
  }

  async get(fenceKey: string): Promise<ExecutionResult | null> {
    return this.docs.getByUniqueKey(
      C.executionResults,
      fenceKey,
      parseExecutionResult,
    );
  }
}

export class PostgresOutcomeVerificationRepository
  implements OutcomeVerificationRepository
{
  private readonly docs: PostgresJsonDocuments;

  constructor(private readonly db: PostgresDatabase) {
    this.docs = new PostgresJsonDocuments(db);
  }

  async append(
    record: OutcomeVerificationRecord,
  ): Promise<OutcomeVerificationRecord> {
    const parsed = parseOutcomeVerificationRecord(record);
    try {
      await this.docs.insert({
        collection: C.outcomeVerifications,
        documentId: parsed.outcomeVerificationId,
        uniqueKey: parsed.outcomeVerificationId,
        runId: parsed.runId,
        payload: parsed,
        immutable: true,
      });
    } catch (error) {
      if (isConflict(error)) {
        throw new Error(
          `Outcome verification record already exists: ${parsed.outcomeVerificationId}`,
        );
      }
      throw error;
    }
    return parsed;
  }

  async getById(
    outcomeVerificationId: string,
  ): Promise<OutcomeVerificationRecord | null> {
    return this.docs.get(
      C.outcomeVerifications,
      outcomeVerificationId,
      parseOutcomeVerificationRecord,
    );
  }

  async getLatestByRun(
    runId: string,
  ): Promise<OutcomeVerificationRecord | null> {
    const list = await this.listByRun(runId);
    return list[list.length - 1] ?? null;
  }

  async getByExecutionAttempt(
    executionAttemptId: string,
  ): Promise<OutcomeVerificationRecord | null> {
    const matches = await listByJsonField(
      this.db,
      C.outcomeVerifications,
      "executionAttemptId",
      executionAttemptId,
      parseOutcomeVerificationRecord,
    );
    return matches[matches.length - 1] ?? null;
  }

  async listByRun(
    runId: string,
  ): Promise<readonly OutcomeVerificationRecord[]> {
    return this.docs.listByRun(
      C.outcomeVerifications,
      runId,
      parseOutcomeVerificationRecord,
    );
  }

  async exists(outcomeVerificationId: string): Promise<boolean> {
    return this.docs.exists(C.outcomeVerifications, outcomeVerificationId);
  }
}

export class PostgresCompletionRecordRepository
  implements CompletionRecordRepository
{
  private readonly docs: PostgresJsonDocuments;

  constructor(db: PostgresDatabase) {
    this.docs = new PostgresJsonDocuments(db);
  }

  async append(record: CompletionRecord): Promise<CompletionRecord> {
    const parsed = parseCompletionRecord(record);
    const existingByRun = await this.docs.getByUniqueKey(
      C.completionRecords,
      parsed.runId,
      parseCompletionRecord,
    );
    if (existingByRun) {
      throw new VerificationError(
        "COMPLETION_RECORD_CONFLICT",
        `Run already has a completion record: ${parsed.runId}`,
        { runId: parsed.runId },
      );
    }
    if (await this.docs.exists(C.completionRecords, parsed.completionRecordId)) {
      throw new VerificationError(
        "COMPLETION_RECORD_CONFLICT",
        `Completion record already exists: ${parsed.completionRecordId}`,
        { completionRecordId: parsed.completionRecordId },
      );
    }
    try {
      await this.docs.insert({
        collection: C.completionRecords,
        documentId: parsed.completionRecordId,
        uniqueKey: parsed.runId,
        runId: parsed.runId,
        payload: parsed,
        immutable: true,
      });
    } catch (error) {
      if (isConflict(error)) {
        throw new VerificationError(
          "COMPLETION_RECORD_CONFLICT",
          `Run already has a completion record: ${parsed.runId}`,
          { runId: parsed.runId },
        );
      }
      throw error;
    }
    return parsed;
  }

  async getByRun(runId: string): Promise<CompletionRecord | null> {
    return this.docs.getByUniqueKey(
      C.completionRecords,
      runId,
      parseCompletionRecord,
    );
  }

  async exists(completionRecordId: string): Promise<boolean> {
    return this.docs.exists(C.completionRecords, completionRecordId);
  }
}

export class PostgresVerificationEvidenceRepository
  implements VerificationEvidenceRepository
{
  private readonly docs: PostgresJsonDocuments;

  constructor(private readonly db: PostgresDatabase) {
    this.docs = new PostgresJsonDocuments(db);
  }

  async save(evidence: VerificationEvidence): Promise<VerificationEvidence> {
    const parsed = parseVerificationEvidence(evidence);
    try {
      await this.docs.insert({
        collection: C.verificationEvidence,
        documentId: parsed.evidenceId,
        uniqueKey: parsed.evidenceId,
        runId: parsed.runId,
        payload: parsed,
        immutable: true,
      });
    } catch (error) {
      if (isConflict(error)) {
        throw new Error(
          `Verification evidence already exists: ${parsed.evidenceId}`,
        );
      }
      throw error;
    }
    return parsed;
  }

  async getById(evidenceId: string): Promise<VerificationEvidence | null> {
    return this.docs.get(
      C.verificationEvidence,
      evidenceId,
      parseVerificationEvidence,
    );
  }

  async listByRun(runId: string): Promise<readonly VerificationEvidence[]> {
    return this.docs.listByRun(
      C.verificationEvidence,
      runId,
      parseVerificationEvidence,
    );
  }

  async listByExecutionAttempt(
    executionAttemptId: string,
  ): Promise<readonly VerificationEvidence[]> {
    return listByJsonField(
      this.db,
      C.verificationEvidence,
      "executionAttemptId",
      executionAttemptId,
      parseVerificationEvidence,
    );
  }

  async listByCriterion(
    criterionId: string,
  ): Promise<readonly VerificationEvidence[]> {
    const all = await this.docs.listCollection(
      C.verificationEvidence,
      parseVerificationEvidence,
    );
    return all.filter((evidence) => evidence.criterionIds.includes(criterionId));
  }

  async exists(evidenceId: string): Promise<boolean> {
    return this.docs.exists(C.verificationEvidence, evidenceId);
  }
}

export class PostgresVerificationInferenceLedger
  implements VerificationInferenceLedger, InferenceDurabilityPort
{
  private readonly docs: PostgresJsonDocuments;

  constructor(db: PostgresDatabase) {
    this.docs = new PostgresJsonDocuments(db);
  }

  async reserve(input: {
    recordId: string;
    runId: string;
    verificationAttemptId: string;
    provider: string;
    model: string;
    reservedTokens: number;
    nowIso: string;
  }): Promise<VerificationInferenceRecord> {
    const record: VerificationInferenceRecord = {
      recordId: input.recordId,
      runId: input.runId,
      verificationAttemptId: input.verificationAttemptId,
      operationCategory: "OUTCOME_VERIFICATION",
      provider: input.provider,
      model: input.model,
      reservedTokens: input.reservedTokens,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      status: "RESERVED",
      createdAt: input.nowIso,
    };
    await this.docs.insert({
      collection: C.verificationInference,
      documentId: input.recordId,
      uniqueKey: input.recordId,
      runId: input.runId,
      payload: { record, durabilityState: "RESERVED" as const },
    });
    return record;
  }

  async settle(input: {
    recordId: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    nowIso: string;
  }): Promise<VerificationInferenceRecord> {
    const existing = await this.require(input.recordId);
    const next: VerificationInferenceRecord = {
      ...existing.record,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      totalTokens: input.totalTokens,
      status: "SETTLED",
      settledAt: input.nowIso,
    };
    await this.docs.updatePayload({
      collection: C.verificationInference,
      documentId: input.recordId,
      payload: { record: next, durabilityState: "SETTLED" },
    });
    return next;
  }

  async release(
    recordId: string,
    nowIso: string,
  ): Promise<VerificationInferenceRecord> {
    const existing = await this.require(recordId);
    const next: VerificationInferenceRecord = {
      ...existing.record,
      status: "RELEASED",
      settledAt: nowIso,
      reservedTokens: 0,
    };
    await this.docs.updatePayload({
      collection: C.verificationInference,
      documentId: recordId,
      payload: { record: next, durabilityState: "FAILED_PRE_DISPATCH" },
    });
    return next;
  }

  async chargeAmbiguous(
    recordId: string,
    nowIso: string,
  ): Promise<VerificationInferenceRecord> {
    const existing = await this.require(recordId);
    const next: VerificationInferenceRecord = {
      ...existing.record,
      totalTokens: existing.record.reservedTokens,
      status: "AMBIGUOUS_CHARGED",
      settledAt: nowIso,
    };
    await this.docs.updatePayload({
      collection: C.verificationInference,
      documentId: recordId,
      payload: { record: next, durabilityState: "AMBIGUOUS" },
    });
    return next;
  }

  async markDispatched(callId: string): Promise<void> {
    const existing = await this.require(callId);
    if (existing.durabilityState === "DISPATCH_STARTED") {
      return;
    }
    await this.docs.updatePayload({
      collection: C.verificationInference,
      documentId: callId,
      payload: {
        record: existing.record,
        durabilityState: "DISPATCH_STARTED",
      },
    });
  }

  async getDurabilityState(
    callId: string,
  ): Promise<InferenceDurabilityState | null> {
    const found = await this.docs.get(
      C.verificationInference,
      callId,
      parseVerificationInferenceDocument,
    );
    return found?.durabilityState ?? null;
  }

  async markAmbiguous(callId: string): Promise<void> {
    const existing = await this.require(callId);
    await this.docs.updatePayload({
      collection: C.verificationInference,
      documentId: callId,
      payload: { record: existing.record, durabilityState: "AMBIGUOUS" },
    });
  }

  async listByRun(
    runId: string,
  ): Promise<readonly VerificationInferenceRecord[]> {
    const docs = await this.docs.listByRun(
      C.verificationInference,
      runId,
      parseVerificationInferenceDocument,
    );
    return docs.map((doc) => doc.record);
  }

  private async require(recordId: string): Promise<{
    record: VerificationInferenceRecord;
    durabilityState: InferenceDurabilityState;
  }> {
    const existing = await this.docs.get(
      C.verificationInference,
      recordId,
      parseVerificationInferenceDocument,
    );
    if (!existing) {
      throw new VerificationError(
        "VERIFICATION_PERSISTENCE_FAILED",
        `Inference record not found: ${recordId}`,
      );
    }
    return existing;
  }
}

export class PostgresHistoricalRunRepository
  implements HistoricalRunRepository
{
  private readonly docs: PostgresJsonDocuments;

  constructor(db: PostgresDatabase) {
    this.docs = new PostgresJsonDocuments(db);
  }

  async append(record: HistoricalRunRecord): Promise<HistoricalRunRecord> {
    const parsed = parseHistoricalRunRecord(record);
    if (await this.docs.exists(C.historicalRuns, parsed.historicalRunRecordId)) {
      throw new MemoryError(
        "HISTORICAL_RUN_CONFLICT",
        `Historical run record already exists: ${parsed.historicalRunRecordId}`,
      );
    }
    const uniqueKey = historicalOutcomeKey({
      runId: parsed.runId,
      outcome: parsed.outcome,
      ...(parsed.outcomeVerificationId !== undefined
        ? { outcomeVerificationId: parsed.outcomeVerificationId }
        : {}),
    });
    const existingByKey = await this.docs.getByUniqueKey(
      C.historicalRuns,
      uniqueKey,
      parseHistoricalRunRecord,
    );
    if (existingByKey) {
      return existingByKey;
    }
    try {
      await this.docs.insert({
        collection: C.historicalRuns,
        documentId: parsed.historicalRunRecordId,
        uniqueKey,
        runId: parsed.runId,
        projectId: parsed.projectId,
        payload: parsed,
        immutable: true,
      });
    } catch (error) {
      if (isConflict(error)) {
        const raced = await this.docs.getByUniqueKey(
          C.historicalRuns,
          uniqueKey,
          parseHistoricalRunRecord,
        );
        if (raced) {
          return raced;
        }
        throw new MemoryError(
          "HISTORICAL_RUN_CONFLICT",
          `Historical run record already exists: ${parsed.historicalRunRecordId}`,
        );
      }
      throw error;
    }
    return parsed;
  }

  async getById(id: string): Promise<HistoricalRunRecord | null> {
    return this.docs.get(C.historicalRuns, id, parseHistoricalRunRecord);
  }

  async getByRunId(runId: string): Promise<HistoricalRunRecord | null> {
    const list = await this.docs.listByRun(
      C.historicalRuns,
      runId,
      parseHistoricalRunRecord,
    );
    return list[list.length - 1] ?? null;
  }

  async getByOutcomeIdentity(input: {
    runId: string;
    outcome: string;
    outcomeVerificationId?: string;
  }): Promise<HistoricalRunRecord | null> {
    return this.docs.getByUniqueKey(
      C.historicalRuns,
      historicalOutcomeKey(input),
      parseHistoricalRunRecord,
    );
  }

  async listByProject(
    projectId: string,
  ): Promise<readonly HistoricalRunRecord[]> {
    return this.docs.listByProject(
      C.historicalRuns,
      projectId,
      parseHistoricalRunRecord,
    );
  }
}

export class PostgresLearningCandidateRepository
  implements LearningCandidateRepository
{
  private readonly docs: PostgresJsonDocuments;

  constructor(private readonly db: PostgresDatabase) {
    this.docs = new PostgresJsonDocuments(db);
  }

  async append(candidate: LearningCandidate): Promise<LearningCandidate> {
    const parsed = parseLearningCandidate(candidate);
    const existingByHash = await this.docs.getByUniqueKey(
      C.learningCandidates,
      parsed.candidateHash,
      parseLearningCandidate,
    );
    if (existingByHash) {
      return existingByHash;
    }
    if (await this.docs.exists(C.learningCandidates, parsed.learningCandidateId)) {
      throw new MemoryError(
        "LEARNING_PERSISTENCE_FAILED",
        `Candidate already exists: ${parsed.learningCandidateId}`,
      );
    }
    try {
      await this.docs.insert({
        collection: C.learningCandidates,
        documentId: parsed.learningCandidateId,
        uniqueKey: parsed.candidateHash,
        projectId: parsed.projectId,
        payload: parsed,
      });
    } catch (error) {
      if (isConflict(error)) {
        const raced = await this.docs.getByUniqueKey(
          C.learningCandidates,
          parsed.candidateHash,
          parseLearningCandidate,
        );
        if (raced) {
          return raced;
        }
        throw new MemoryError(
          "LEARNING_PERSISTENCE_FAILED",
          `Candidate already exists: ${parsed.learningCandidateId}`,
        );
      }
      throw error;
    }
    return parsed;
  }

  async getById(id: string): Promise<LearningCandidate | null> {
    return this.docs.get(C.learningCandidates, id, parseLearningCandidate);
  }

  async getByHash(candidateHash: string): Promise<LearningCandidate | null> {
    return this.docs.getByUniqueKey(
      C.learningCandidates,
      candidateHash,
      parseLearningCandidate,
    );
  }

  async listByRunRecord(
    historicalRunRecordId: string,
  ): Promise<readonly LearningCandidate[]> {
    return listByJsonField(
      this.db,
      C.learningCandidates,
      "sourceHistoricalRunRecordId",
      historicalRunRecordId,
      parseLearningCandidate,
    );
  }

  async listByProject(
    projectId: string,
  ): Promise<readonly LearningCandidate[]> {
    return this.docs.listByProject(
      C.learningCandidates,
      projectId,
      parseLearningCandidate,
    );
  }

  async updateStatus(
    id: string,
    status: LearningCandidateStatus,
  ): Promise<LearningCandidate> {
    const existing = await this.getById(id);
    if (!existing) {
      throw new MemoryError("CANDIDATE_NOT_FOUND", `Candidate not found: ${id}`);
    }
    const next = parseLearningCandidate({ ...existing, status });
    await this.docs.updatePayload({
      collection: C.learningCandidates,
      documentId: id,
      payload: next,
    });
    return next;
  }
}

export class PostgresPromotedPrecedentRepository
  implements PromotedPrecedentRepository
{
  private readonly docs: PostgresJsonDocuments;

  constructor(db: PostgresDatabase) {
    this.docs = new PostgresJsonDocuments(db);
  }

  async append(precedent: PromotedPrecedent): Promise<PromotedPrecedent> {
    const parsed = parsePromotedPrecedent(precedent);
    const key = precedentKey(parsed.precedentId, parsed.version);
    try {
      await this.docs.insert({
        collection: C.promotedPrecedents,
        documentId: key,
        uniqueKey: key,
        projectId: parsed.projectId,
        payload: parsed,
      });
    } catch (error) {
      if (isConflict(error)) {
        throw new MemoryError(
          "LEARNING_PERSISTENCE_FAILED",
          `Precedent version already exists: ${key}`,
        );
      }
      throw error;
    }
    return parsed;
  }

  async getById(id: string): Promise<PromotedPrecedent | null> {
    return this.getLatestVersion(id);
  }

  async getLatestVersion(
    precedentId: string,
  ): Promise<PromotedPrecedent | null> {
    const all = await this.docs.listCollection(
      C.promotedPrecedents,
      parsePromotedPrecedent,
    );
    const versions = all
      .filter((record) => record.precedentId === precedentId)
      .sort((a, b) => a.version - b.version);
    return versions[versions.length - 1] ?? null;
  }

  async listByProject(
    projectId: string,
  ): Promise<readonly PromotedPrecedent[]> {
    const all = await this.docs.listByProject(
      C.promotedPrecedents,
      projectId,
      parsePromotedPrecedent,
    );
    return latestPrecedents(all);
  }

  async listActiveByProject(
    projectId: string,
  ): Promise<readonly PromotedPrecedent[]> {
    const all = await this.listByProject(projectId);
    return all.filter((record) => record.status === "ACTIVE");
  }

  async listAllActive(): Promise<readonly PromotedPrecedent[]> {
    const all = await this.docs.listCollection(
      C.promotedPrecedents,
      parsePromotedPrecedent,
    );
    return latestPrecedents(all).filter((record) => record.status === "ACTIVE");
  }

  async updateStatus(
    precedentId: string,
    version: number,
    status: PrecedentStatus,
  ): Promise<PromotedPrecedent> {
    const key = precedentKey(precedentId, version);
    const existing = await this.docs.get(
      C.promotedPrecedents,
      key,
      parsePromotedPrecedent,
    );
    if (!existing) {
      throw new MemoryError(
        "PRECEDENT_NOT_FOUND",
        `Precedent not found: ${key}`,
      );
    }
    const next = parsePromotedPrecedent({ ...existing, status });
    await this.docs.updatePayload({
      collection: C.promotedPrecedents,
      documentId: key,
      payload: next,
    });
    return next;
  }
}

function latestPrecedents(
  records: readonly PromotedPrecedent[],
): PromotedPrecedent[] {
  const byId = new Map<string, PromotedPrecedent>();
  for (const record of records) {
    const current = byId.get(record.precedentId);
    if (!current || record.version > current.version) {
      byId.set(record.precedentId, record);
    }
  }
  return [...byId.values()];
}

export class PostgresPrecedentPromotionDecisionRepository
  implements PrecedentPromotionDecisionRepository
{
  private readonly docs: PostgresJsonDocuments;

  constructor(private readonly db: PostgresDatabase) {
    this.docs = new PostgresJsonDocuments(db);
  }

  async append(
    decision: PrecedentPromotionDecision,
  ): Promise<PrecedentPromotionDecision> {
    const parsed = parsePrecedentPromotionDecision(decision);
    try {
      await this.docs.insert({
        collection: C.promotionDecisions,
        documentId: parsed.promotionDecisionId,
        uniqueKey: parsed.promotionDecisionId,
        payload: parsed,
        immutable: true,
      });
    } catch (error) {
      if (isConflict(error)) {
        throw new MemoryError(
          "LEARNING_PERSISTENCE_FAILED",
          `Promotion decision already exists: ${parsed.promotionDecisionId}`,
        );
      }
      throw error;
    }
    return parsed;
  }

  async getById(id: string): Promise<PrecedentPromotionDecision | null> {
    return this.docs.get(
      C.promotionDecisions,
      id,
      parsePrecedentPromotionDecision,
    );
  }

  async listByCandidate(
    learningCandidateId: string,
  ): Promise<readonly PrecedentPromotionDecision[]> {
    return listByJsonField(
      this.db,
      C.promotionDecisions,
      "learningCandidateId",
      learningCandidateId,
      parsePrecedentPromotionDecision,
    );
  }
}

export class PostgresLearningLedgerRepository
  implements LearningLedgerRepository
{
  private readonly docs: PostgresJsonDocuments;

  constructor(db: PostgresDatabase) {
    this.docs = new PostgresJsonDocuments(db);
  }

  async append(event: LearningLedgerEvent): Promise<LearningLedgerEvent> {
    const parsed = parseLearningLedgerEvent(event);
    await this.docs.insert({
      collection: C.learningLedger,
      documentId: parsed.eventId,
      uniqueKey: parsed.eventId,
      payload: parsed,
      immutable: true,
      ...(parsed.runId !== undefined ? { runId: parsed.runId } : {}),
      ...(parsed.projectId !== undefined ? { projectId: parsed.projectId } : {}),
    });
    return parsed;
  }

  async listByRun(runId: string): Promise<readonly LearningLedgerEvent[]> {
    return this.docs.listByRun(C.learningLedger, runId, parseLearningLedgerEvent);
  }

  async listByProject(
    projectId: string,
  ): Promise<readonly LearningLedgerEvent[]> {
    return this.docs.listByProject(
      C.learningLedger,
      projectId,
      parseLearningLedgerEvent,
    );
  }

  async listAll(): Promise<readonly LearningLedgerEvent[]> {
    return this.docs.listCollection(C.learningLedger, parseLearningLedgerEvent);
  }
}

export class PostgresPrecedentContradictionRepository
  implements PrecedentContradictionRepository
{
  private readonly docs: PostgresJsonDocuments;

  constructor(db: PostgresDatabase) {
    this.docs = new PostgresJsonDocuments(db);
  }

  async append(
    record: PrecedentContradictionRecord,
  ): Promise<PrecedentContradictionRecord> {
    const parsed = parsePrecedentContradictionRecord(record);
    try {
      await this.docs.insert({
        collection: C.contradictions,
        documentId: parsed.contradictionId,
        uniqueKey: parsed.contradictionId,
        payload: parsed,
      });
    } catch (error) {
      if (isConflict(error)) {
        throw new MemoryError(
          "LEARNING_PERSISTENCE_FAILED",
          `Contradiction already exists: ${parsed.contradictionId}`,
        );
      }
      throw error;
    }
    return parsed;
  }

  async getById(id: string): Promise<PrecedentContradictionRecord | null> {
    return this.docs.get(
      C.contradictions,
      id,
      parsePrecedentContradictionRecord,
    );
  }

  async listOpen(): Promise<readonly PrecedentContradictionRecord[]> {
    const all = await this.docs.listCollection(
      C.contradictions,
      parsePrecedentContradictionRecord,
    );
    return all.filter((record) => record.resolutionStatus === "OPEN");
  }

  async listForPrecedent(
    precedentId: string,
  ): Promise<readonly PrecedentContradictionRecord[]> {
    const all = await this.docs.listCollection(
      C.contradictions,
      parsePrecedentContradictionRecord,
    );
    return all.filter((record) => record.precedentIds.includes(precedentId));
  }

  async listForCandidate(
    candidateId: string,
  ): Promise<readonly PrecedentContradictionRecord[]> {
    const all = await this.docs.listCollection(
      C.contradictions,
      parsePrecedentContradictionRecord,
    );
    return all.filter((record) => record.candidateIds.includes(candidateId));
  }

  async updateResolution(
    id: string,
    status: ContradictionResolutionStatus,
  ): Promise<PrecedentContradictionRecord> {
    const existing = await this.getById(id);
    if (!existing) {
      throw new MemoryError(
        "LEARNING_PERSISTENCE_FAILED",
        `Contradiction not found: ${id}`,
      );
    }
    const next = parsePrecedentContradictionRecord({
      ...existing,
      resolutionStatus: status,
    });
    await this.docs.updatePayload({
      collection: C.contradictions,
      documentId: id,
      payload: next,
    });
    return next;
  }
}

export class PostgresLearningInferenceLedger
  implements LearningInferenceLedger
{
  private readonly docs: PostgresJsonDocuments;

  constructor(db: PostgresDatabase) {
    this.docs = new PostgresJsonDocuments(db);
  }

  async reserve(input: {
    recordId: string;
    runId: string;
    historicalRunRecordId: string;
    provider: string;
    model: string;
    reservedTokens: number;
    nowIso: string;
  }): Promise<LearningInferenceRecord> {
    const record: LearningInferenceRecord = {
      recordId: input.recordId,
      runId: input.runId,
      historicalRunRecordId: input.historicalRunRecordId,
      operationCategory: "CANDIDATE_EXTRACTION",
      provider: input.provider,
      model: input.model,
      reservedTokens: input.reservedTokens,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      status: "RESERVED",
      createdAt: input.nowIso,
    };
    await this.docs.insert({
      collection: C.learningInference,
      documentId: input.recordId,
      uniqueKey: input.recordId,
      runId: input.runId,
      payload: record,
    });
    return record;
  }

  async settle(input: {
    recordId: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    nowIso: string;
  }): Promise<LearningInferenceRecord> {
    const existing = await this.require(input.recordId);
    const next: LearningInferenceRecord = {
      ...existing,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      totalTokens: input.totalTokens,
      status: "SETTLED",
      settledAt: input.nowIso,
    };
    await this.docs.updatePayload({
      collection: C.learningInference,
      documentId: input.recordId,
      payload: next,
    });
    return next;
  }

  async release(
    recordId: string,
    nowIso: string,
  ): Promise<LearningInferenceRecord> {
    const existing = await this.require(recordId);
    const next: LearningInferenceRecord = {
      ...existing,
      status: "RELEASED",
      settledAt: nowIso,
    };
    await this.docs.updatePayload({
      collection: C.learningInference,
      documentId: recordId,
      payload: next,
    });
    return next;
  }

  async listByRun(runId: string): Promise<readonly LearningInferenceRecord[]> {
    return this.docs.listByRun(
      C.learningInference,
      runId,
      parseLearningInferenceRecord,
    );
  }

  private async require(recordId: string): Promise<LearningInferenceRecord> {
    const existing = await this.docs.get(
      C.learningInference,
      recordId,
      parseLearningInferenceRecord,
    );
    if (!existing) {
      throw new MemoryError(
        "LEARNING_PERSISTENCE_FAILED",
        `Learning inference record not found: ${recordId}`,
      );
    }
    return existing;
  }
}

function parseLearningInferenceRecord(input: unknown): LearningInferenceRecord {
  if (typeof input !== "object" || input === null) {
    throw new Error("Learning inference record is not an object");
  }
  const record = input as LearningInferenceRecord;
  if (typeof record.recordId !== "string" || typeof record.runId !== "string") {
    throw new Error("Learning inference record invalid");
  }
  return record;
}

export class PostgresRunTelemetryRepository implements RunTelemetryRepository {
  private readonly docs: PostgresJsonDocuments;

  constructor(db: PostgresDatabase) {
    this.docs = new PostgresJsonDocuments(db);
  }

  async save(record: RunTelemetryRecord): Promise<RunTelemetryRecord> {
    const parsed = RunTelemetryRecordSchema.parse(record);
    const existing = await this.getByRun(parsed.runId);
    if (existing && existing.telemetryHash === parsed.telemetryHash) {
      return existing;
    }
    await this.docs.upsert({
      collection: C.runTelemetry,
      documentId: parsed.runId,
      uniqueKey: parsed.runId,
      runId: parsed.runId,
      projectId: parsed.projectId,
      payload: parsed,
    });
    return parsed;
  }

  async getByRun(runId: string): Promise<RunTelemetryRecord | null> {
    return this.docs.get(C.runTelemetry, runId, (input) =>
      RunTelemetryRecordSchema.parse(input),
    );
  }

  async listByProject(
    projectId: string,
  ): Promise<readonly RunTelemetryRecord[]> {
    const rows = await this.docs.listByProject(
      C.runTelemetry,
      projectId,
      (input) => RunTelemetryRecordSchema.parse(input),
    );
    return [...rows].sort((a, b) => a.runId.localeCompare(b.runId));
  }

  async listByWindow(
    projectId: string,
    windowFingerprint: string,
  ): Promise<readonly RunTelemetryRecord[]> {
    const index = await this.docs.getByUniqueKey(
      C.runTelemetryWindows,
      `${projectId}:${windowFingerprint}`,
      parseRunTelemetryWindow,
    );
    if (!index) {
      return [];
    }
    const records: RunTelemetryRecord[] = [];
    for (const runId of index.runIds) {
      const record = await this.getByRun(runId);
      if (record) {
        records.push(record);
      }
    }
    return records;
  }

  async indexForWindow(
    projectId: string,
    windowFingerprint: string,
    runIds: readonly string[],
  ): Promise<void> {
    const uniqueKey = `${projectId}:${windowFingerprint}`;
    await this.docs.upsert({
      collection: C.runTelemetryWindows,
      documentId: uniqueKey,
      uniqueKey,
      projectId,
      payload: { projectId, windowFingerprint, runIds: [...runIds] },
    });
  }
}

function parseRunTelemetryWindow(input: unknown): {
  projectId: string;
  windowFingerprint: string;
  runIds: string[];
} {
  if (typeof input !== "object" || input === null) {
    throw new Error("Run telemetry window index is not an object");
  }
  const doc = input as {
    projectId?: unknown;
    windowFingerprint?: unknown;
    runIds?: unknown;
  };
  if (
    typeof doc.projectId !== "string" ||
    typeof doc.windowFingerprint !== "string" ||
    !Array.isArray(doc.runIds)
  ) {
    throw new Error("Run telemetry window index invalid");
  }
  return {
    projectId: doc.projectId,
    windowFingerprint: doc.windowFingerprint,
    runIds: doc.runIds.filter((id): id is string => typeof id === "string"),
  };
}

export class PostgresPhaseTelemetryRepository
  implements PhaseTelemetryRepository
{
  private readonly docs: PostgresJsonDocuments;

  constructor(db: PostgresDatabase) {
    this.docs = new PostgresJsonDocuments(db);
  }

  async save(record: PhaseTelemetryRecord): Promise<PhaseTelemetryRecord> {
    const parsed = PhaseTelemetryRecordSchema.parse(record);
    await this.docs.upsert({
      collection: C.phaseTelemetry,
      documentId: parsed.phaseTelemetryId,
      uniqueKey: parsed.phaseTelemetryId,
      runId: parsed.runId,
      projectId: parsed.projectId,
      payload: parsed,
    });
    return parsed;
  }

  async listByRun(runId: string): Promise<readonly PhaseTelemetryRecord[]> {
    return this.docs.listByRun(C.phaseTelemetry, runId, (input) =>
      PhaseTelemetryRecordSchema.parse(input),
    );
  }

  async listByProject(
    projectId: string,
  ): Promise<readonly PhaseTelemetryRecord[]> {
    return this.docs.listByProject(C.phaseTelemetry, projectId, (input) =>
      PhaseTelemetryRecordSchema.parse(input),
    );
  }
}

export class PostgresSystemHealthSnapshotRepository
  implements SystemHealthSnapshotRepository
{
  private readonly docs: PostgresJsonDocuments;

  constructor(db: PostgresDatabase) {
    this.docs = new PostgresJsonDocuments(db);
  }

  async save(snapshot: SystemHealthSnapshot): Promise<SystemHealthSnapshot> {
    const parsed = SystemHealthSnapshotSchema.parse(snapshot);
    const uniqueKey = `${parsed.projectId}:${parsed.windowFingerprint}`;
    const existing = await this.docs.getByUniqueKey(
      C.healthSnapshots,
      uniqueKey,
      (input) => SystemHealthSnapshotSchema.parse(input),
    );
    if (existing && existing.snapshotHash === parsed.snapshotHash) {
      return existing;
    }
    if (existing) {
      return existing;
    }
    try {
      await this.docs.insert({
        collection: C.healthSnapshots,
        documentId: parsed.snapshotId,
        uniqueKey,
        projectId: parsed.projectId,
        payload: parsed,
        immutable: true,
      });
    } catch (error) {
      if (isConflict(error)) {
        const raced = await this.docs.getByUniqueKey(
          C.healthSnapshots,
          uniqueKey,
          (input) => SystemHealthSnapshotSchema.parse(input),
        );
        if (raced) {
          return raced;
        }
      }
      throw error;
    }
    return parsed;
  }

  async getById(snapshotId: string): Promise<SystemHealthSnapshot | null> {
    return this.docs.get(C.healthSnapshots, snapshotId, (input) =>
      SystemHealthSnapshotSchema.parse(input),
    );
  }

  async getByWindowFingerprint(
    projectId: string,
    windowFingerprint: string,
  ): Promise<SystemHealthSnapshot | null> {
    return this.docs.getByUniqueKey(
      C.healthSnapshots,
      `${projectId}:${windowFingerprint}`,
      (input) => SystemHealthSnapshotSchema.parse(input),
    );
  }

  async listByProject(
    projectId: string,
  ): Promise<readonly SystemHealthSnapshot[]> {
    return this.docs.listByProject(C.healthSnapshots, projectId, (input) =>
      SystemHealthSnapshotSchema.parse(input),
    );
  }
}

export class PostgresSLOEvaluationRepository
  implements SLOEvaluationRepository
{
  private readonly docs: PostgresJsonDocuments;

  constructor(db: PostgresDatabase) {
    this.docs = new PostgresJsonDocuments(db);
  }

  async save(evaluation: SLOEvaluation): Promise<SLOEvaluation> {
    const parsed = SLOEvaluationSchema.parse(evaluation);
    await this.docs.upsert({
      collection: C.sloEvaluations,
      documentId: parsed.evaluationId,
      uniqueKey: parsed.evaluationId,
      projectId: parsed.projectId,
      payload: parsed,
    });
    return parsed;
  }

  async listByProject(projectId: string): Promise<readonly SLOEvaluation[]> {
    return this.docs.listByProject(C.sloEvaluations, projectId, (input) =>
      SLOEvaluationSchema.parse(input),
    );
  }

  async listByWindow(
    projectId: string,
    windowFingerprint: string,
  ): Promise<readonly SLOEvaluation[]> {
    const list = await this.listByProject(projectId);
    return list.filter((evaluation) => evaluation.windowFingerprint === windowFingerprint);
  }
}

export class PostgresAnomalyFindingRepository
  implements AnomalyFindingRepository
{
  private readonly docs: PostgresJsonDocuments;

  constructor(db: PostgresDatabase) {
    this.docs = new PostgresJsonDocuments(db);
  }

  async save(finding: AnomalyFinding): Promise<AnomalyFinding> {
    const parsed = AnomalyFindingSchema.parse(finding);
    await this.docs.upsert({
      collection: C.anomalies,
      documentId: parsed.anomalyId,
      uniqueKey: parsed.anomalyId,
      projectId: parsed.projectId,
      payload: parsed,
    });
    return parsed;
  }

  async getById(anomalyId: string): Promise<AnomalyFinding | null> {
    return this.docs.get(C.anomalies, anomalyId, (input) =>
      AnomalyFindingSchema.parse(input),
    );
  }

  async updateStatus(
    anomalyId: string,
    status: AnomalyFinding["status"],
  ): Promise<AnomalyFinding> {
    const existing = await this.getById(anomalyId);
    if (!existing) {
      throw new Error(`Anomaly not found: ${anomalyId}`);
    }
    const updated = AnomalyFindingSchema.parse({ ...existing, status });
    await this.docs.updatePayload({
      collection: C.anomalies,
      documentId: anomalyId,
      payload: updated,
    });
    return updated;
  }

  async listByProject(projectId: string): Promise<readonly AnomalyFinding[]> {
    return this.docs.listByProject(C.anomalies, projectId, (input) =>
      AnomalyFindingSchema.parse(input),
    );
  }

  async listByWindow(
    projectId: string,
    windowFingerprint: string,
  ): Promise<readonly AnomalyFinding[]> {
    const list = await this.listByProject(projectId);
    return list.filter((finding) => finding.windowFingerprint === windowFingerprint);
  }
}

export class PostgresOptimizationCandidateRepository
  implements OptimizationCandidateRepository
{
  private readonly docs: PostgresJsonDocuments;

  constructor(db: PostgresDatabase) {
    this.docs = new PostgresJsonDocuments(db);
  }

  async save(candidate: OptimizationCandidate): Promise<OptimizationCandidate> {
    const parsed = OptimizationCandidateSchema.parse(candidate);
    await this.docs.upsert({
      collection: C.optimizationCandidates,
      documentId: parsed.optimizationCandidateId,
      uniqueKey: parsed.optimizationCandidateId,
      projectId: parsed.projectId,
      payload: parsed,
    });
    return parsed;
  }

  async getById(
    optimizationCandidateId: string,
  ): Promise<OptimizationCandidate | null> {
    return this.docs.get(
      C.optimizationCandidates,
      optimizationCandidateId,
      (input) => OptimizationCandidateSchema.parse(input),
    );
  }

  async updateStatus(
    optimizationCandidateId: string,
    status: OptimizationCandidate["status"],
  ): Promise<OptimizationCandidate> {
    const existing = await this.getById(optimizationCandidateId);
    if (!existing) {
      throw new Error(
        `Optimization candidate not found: ${optimizationCandidateId}`,
      );
    }
    const updated = OptimizationCandidateSchema.parse({ ...existing, status });
    await this.docs.updatePayload({
      collection: C.optimizationCandidates,
      documentId: optimizationCandidateId,
      payload: updated,
    });
    return updated;
  }

  async listByProject(
    projectId: string,
  ): Promise<readonly OptimizationCandidate[]> {
    return this.docs.listByProject(
      C.optimizationCandidates,
      projectId,
      (input) => OptimizationCandidateSchema.parse(input),
    );
  }
}

export class PostgresObservabilityLedger implements ObservabilityLedger {
  private readonly docs: PostgresJsonDocuments;

  constructor(db: PostgresDatabase) {
    this.docs = new PostgresJsonDocuments(db);
  }

  async append(
    event: ObservabilityLedgerEvent,
  ): Promise<ObservabilityLedgerEvent> {
    const parsed = ObservabilityLedgerEventSchema.parse(event);
    await this.docs.insert({
      collection: C.observabilityLedger,
      documentId: parsed.eventId,
      uniqueKey: parsed.eventId,
      payload: parsed,
      immutable: true,
      ...(parsed.runId !== undefined ? { runId: parsed.runId } : {}),
      ...(parsed.projectId !== undefined ? { projectId: parsed.projectId } : {}),
    });
    return parsed;
  }

  async listByProject(
    projectId: string,
  ): Promise<readonly ObservabilityLedgerEvent[]> {
    return this.docs.listByProject(
      C.observabilityLedger,
      projectId,
      (input) => ObservabilityLedgerEventSchema.parse(input),
    );
  }
}

export class PostgresRepositorySourceRegistry
  implements RepositorySourceRegistry
{
  private readonly docs: PostgresJsonDocuments;

  constructor(db: PostgresDatabase) {
    this.docs = new PostgresJsonDocuments(db);
  }

  async seed(sources: readonly RepositorySource[]): Promise<void> {
    for (const item of sources) {
      const parsed = parseRepositorySource(item);
      await this.docs.upsert({
        collection: C.repositorySources,
        documentId: parsed.projectId,
        uniqueKey: parsed.projectId,
        projectId: parsed.projectId,
        payload: parsed,
      });
    }
  }

  async getByProjectId(projectId: string): Promise<RepositorySource | null> {
    return this.docs.get(C.repositorySources, projectId, parseRepositorySource);
  }

  async exists(projectId: string): Promise<boolean> {
    return this.docs.exists(C.repositorySources, projectId);
  }

  async list(): Promise<readonly RepositorySource[]> {
    return this.docs.listCollection(C.repositorySources, parseRepositorySource);
  }
}

export class PostgresLockedRepositoryStore implements LockedRepositoryStore {
  private readonly docs: PostgresJsonDocuments;

  constructor(db: PostgresDatabase) {
    this.docs = new PostgresJsonDocuments(db);
  }

  async getByRunId(runId: string): Promise<LockedRepositoryState | null> {
    return this.docs.get(C.lockedRepos, runId, (input) =>
      LockedRepositoryStateSchema.parse(input),
    );
  }

  async save(state: LockedRepositoryState): Promise<LockedRepositoryState> {
    const parsed = LockedRepositoryStateSchema.parse(state);
    await this.docs.upsert({
      collection: C.lockedRepos,
      documentId: parsed.runId,
      uniqueKey: parsed.runId,
      runId: parsed.runId,
      projectId: parsed.projectId,
      payload: parsed,
    });
    return parsed;
  }
}

export class PostgresEvidenceRegistry implements EvidenceRegistry {
  private readonly docs: PostgresJsonDocuments;

  constructor(db: PostgresDatabase) {
    this.docs = new PostgresJsonDocuments(db);
  }

  async put(record: EvidenceRecord): Promise<EvidenceRecord> {
    const parsed = parseEvidenceRecord(record);
    await this.docs.upsert({
      collection: C.evidenceRegistry,
      documentId: parsed.evidenceId,
      uniqueKey: parsed.evidenceId,
      payload: parsed,
      ...(parsed.runId !== undefined ? { runId: parsed.runId } : {}),
      ...(parsed.projectId !== undefined ? { projectId: parsed.projectId } : {}),
    });
    return parsed;
  }

  async getById(evidenceId: string): Promise<EvidenceRecord | null> {
    return this.docs.get(C.evidenceRegistry, evidenceId, parseEvidenceRecord);
  }

  async listByRunId(runId: string): Promise<readonly EvidenceRecord[]> {
    return this.docs.listByRun(C.evidenceRegistry, runId, parseEvidenceRecord);
  }
}

export class PostgresVerifiedRepositoryContextStore
  implements VerifiedRepositoryContextStore
{
  private readonly docs: PostgresJsonDocuments;

  constructor(db: PostgresDatabase) {
    this.docs = new PostgresJsonDocuments(db);
  }

  async getByRunId(runId: string): Promise<VerifiedRepositoryContext | null> {
    return this.docs.get(C.verifiedContexts, runId, (input) =>
      VerifiedRepositoryContextSchema.parse(input),
    );
  }

  async save(
    context: VerifiedRepositoryContext,
  ): Promise<VerifiedRepositoryContext> {
    const parsed = VerifiedRepositoryContextSchema.parse(context);
    const existing = await this.getByRunId(parsed.runId);
    if (existing) {
      return existing;
    }
    try {
      await this.docs.insert({
        collection: C.verifiedContexts,
        documentId: parsed.runId,
        uniqueKey: parsed.runId,
        runId: parsed.runId,
        projectId: parsed.projectId,
        payload: parsed,
        immutable: true,
      });
    } catch (error) {
      if (isConflict(error)) {
        const raced = await this.getByRunId(parsed.runId);
        if (raced) {
          return raced;
        }
      }
      throw error;
    }
    return parsed;
  }
}

export class PostgresRepositoryIndexStore implements RepositoryIndexStore {
  private readonly docs: PostgresJsonDocuments;

  constructor(db: PostgresDatabase) {
    this.docs = new PostgresJsonDocuments(db);
  }

  async get(key: RepositoryIndexCacheKey): Promise<ProjectIndex | null> {
    const documentId = repositoryIndexCacheKeyString(key);
    return this.docs.get(C.repositoryIndexes, documentId, (input) =>
      ProjectIndexSchema.parse(input),
    );
  }

  async save(index: ProjectIndex): Promise<ProjectIndex> {
    const parsed = ProjectIndexSchema.parse(index);
    const documentId = repositoryIndexCacheKeyString({
      repositoryIdentity: parsed.repositoryIdentity,
      commitSha: parsed.commitSha,
      indexVersion: parsed.indexVersion,
      indexConfigurationFingerprint: parsed.indexConfigurationFingerprint,
    });
    await this.docs.upsert({
      collection: C.repositoryIndexes,
      documentId,
      uniqueKey: documentId,
      payload: parsed,
    });
    return parsed;
  }

  async exists(key: RepositoryIndexCacheKey): Promise<boolean> {
    return this.docs.exists(
      C.repositoryIndexes,
      repositoryIndexCacheKeyString(key),
    );
  }
}
