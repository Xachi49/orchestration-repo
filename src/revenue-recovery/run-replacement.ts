/**
 * Governed same-objective run replacement.
 *
 * OBJECTIVE REVISION != RUN REPLACEMENT.
 * OBJECTIVE VERSION = WHAT is being attempted.
 * RUN ATTEMPT = WHICH immutable attempt is executing it.
 * SAME OBJECTIVE AUTHORITY != SAME RUN ATTEMPT.
 * RUN REPLACEMENT != OBJECTIVE RESUBMISSION.
 * PREDECESSOR AUTHORITY != REPLACEMENT AUTHORITY.
 * PREDECESSOR REPOSITORY VERIFICATION != REPLACEMENT REPOSITORY VERIFICATION.
 * RUN-SCOPED BUDGET != UNBOUNDED BUDGET RENEWAL.
 * SUPERSEDED != FAILED OBJECTIVE.
 * FAILED RUN HISTORY != AUTHORITY TO MUTATE HISTORY.
 *
 * At most two governed SYSTEM_DEFECT_RETRY replacements may exist for one
 * objective version, and at most one consumption per durable evidence class.
 * Run attempt 3 is the hard ceiling. The evidence class is system-derived;
 * the caller cannot select it.
 *
 * A historical attempt-1 → attempt-2 audit without evidenceClass is legacy
 * TOKEN_RESERVATION_EXHAUSTION. Any other missing class is malformed lineage.
 * Request identity includes expectedPredecessorRunId. Replaying that
 * predecessor returns the historical successor even after the case advances.
 *
 * This service does not call objective reissue and does not call
 * AdmissionService.admit().
 */
import { z } from "zod";
import type { EventStore } from "../admission/event-store.js";
import { PROJECT_RUN_REPLACEMENT_ADMITTED } from "../admission/event-store.js";
import type { AdmissionIdentityGenerator } from "../admission/identity.js";
import type { IdempotencyStore } from "../admission/idempotency-store.js";
import type { ObjectiveRepository } from "../admission/objective-repository.js";
import type { ProjectLockService } from "../admission/project-lock.js";
import { commitRunTransition } from "../admission/run-transition.js";
import type { RunRecord, RunRepository } from "../admission/run-repository.js";
import type { ApprovalRequestRepository } from "../authorization/approval-request-repository.js";
import { assessHistoricalExecutionAuthority } from "../authorization/historical-authority.js";
import type { AuthorizationRecordRepository } from "../authorization/authorization-record-repository.js";
import type { ControlPlaneService } from "../control-plane/service.js";
import { isDurabilityError } from "../durability/errors.js";
import { objectiveFingerprint } from "../domain/objective/fingerprint.js";
import type { Objective } from "../domain/objective/objective.js";
import { parseEventEnvelope } from "../domain/run/event-envelope.js";
import {
  runReplacementIdempotencyKey,
  runReplacementMaterialFingerprint,
} from "../domain/run/replacement-identity.js";
import type { ExecutionAttemptRepository } from "../execution/attempt-repository.js";
import type { PlanningCoordinator } from "../planning/coordinator.js";
import type { PlanningFence } from "../planning/coordinator.js";
import {
  aggregatePlanningUsage,
  type PlanningModelUsage,
} from "../planning/model.js";
import type { PlanRepository } from "../planning/plan-repository.js";
import type { ResourceBudgetProfile } from "../control-plane/budgets/budget.js";
import { newAuditEventId, type ProductAuditEvent } from "./audit.js";
import { RevenueRecoveryError } from "./errors.js";
import { hashCanonical } from "./hash.js";
import { recoveryObjectiveId } from "./objective-reissue.js";
import type { RecoveryCase } from "./recovery-case.js";
import type {
  ProductAuditRepository,
  RecoveryAttemptRepository,
  RecoveryCaseRepository,
} from "./repositories.js";

export const RUN_REPLACEMENT_REASONS = ["SYSTEM_DEFECT_RETRY"] as const;
export type RunReplacementReason = (typeof RUN_REPLACEMENT_REASONS)[number];

/**
 * Hard ceiling on the run attempt this primitive may produce.
 * The constant does not authorize a replacement. A new attempt also requires
 * an unused durable evidence class and a continuous lineage chain.
 */
export const MAX_GOVERNED_SYSTEM_DEFECT_RUN_ATTEMPT = 3;

export const RUN_REPLACEMENT_EVIDENCE_CLASSES = [
  "TOKEN_RESERVATION_EXHAUSTION",
  "POST_MODEL_DETERMINISTIC_FAILURE",
] as const;
export type RunReplacementEvidenceClass =
  (typeof RUN_REPLACEMENT_EVIDENCE_CLASSES)[number];

const LOCK_TTL_MS = 60 * 60 * 1000;
const EVENT_TTL_MS = 24 * 60 * 60 * 1000;

export const RunReplacementRequestSchema = z
  .object({
    customerAccountId: z.string().min(1),
    projectId: z.string().min(1),
    expectedPredecessorRunId: z.string().min(1),
    reason: z.enum(RUN_REPLACEMENT_REASONS),
  })
  .strict();
export type RunReplacementRequest = z.infer<typeof RunReplacementRequestSchema>;

export interface RecoveryRunReplacementOrchestratorPorts {
  runs: RunRepository;
  objectives: Pick<ObjectiveRepository, "getById" | "getByRunBinding" | "bindRun">;
  plans: Pick<PlanRepository, "listByRunId">;
  approvalRequests: Pick<ApprovalRequestRepository, "listByRun">;
  authorizationRecords: Pick<AuthorizationRecordRepository, "listByRun">;
  executionAttempts: Pick<ExecutionAttemptRepository, "listByRun">;
  planning: Pick<PlanningCoordinator, "get">;
  usage: Pick<PlanningUsageLedgerList, "listByRunId">;
  controlPlane: Pick<ControlPlaneService, "resolve">;
  events: EventStore;
  idempotency: IdempotencyStore;
  locks: ProjectLockService;
}

type PlanningUsageLedgerList = {
  listByRunId(runId: string): Promise<readonly PlanningModelUsage[]>;
};

export interface RecoveryRunReplacementDeps {
  nowIso: () => string;
  cases: RecoveryCaseRepository;
  attempts: Pick<RecoveryAttemptRepository, "listByCase">;
  audits: ProductAuditRepository;
  orchestrator: RecoveryRunReplacementOrchestratorPorts;
  identities: AdmissionIdentityGenerator;
  withReplacementLock: <T>(
    recoveryCaseId: string,
    fn: () => Promise<T>,
  ) => Promise<T>;
}

export type RecoveryRunReplacementResult = {
  outcome: "REPLACED" | "ALREADY_REPLACED";
  replacementId: string;
  recoveryCaseId: string;
  objectiveId: string;
  objectiveVersion: number;
  predecessorRunId: string;
  predecessorRunAttempt: number;
  predecessorRunState: string | null;
  replacementRunId: string;
  replacementRunAttempt: number;
  replacementRunState: string | null;
  reason: RunReplacementReason;
  evidenceClass: RunReplacementEvidenceClass;
};

export type RecoveryRunReplacementLineageEntry = {
  replacementId: string;
  recoveryCaseId: string;
  objectiveId: string;
  objectiveVersion: number;
  predecessorRunId: string;
  predecessorRunAttempt: number;
  replacementRunId: string;
  replacementRunAttempt: number;
  reason: string;
  evidenceClass: RunReplacementEvidenceClass;
  principalId: string | null;
  occurredAt: string;
};

export function recoveryRunReplacementId(input: {
  recoveryCaseId: string;
  predecessorRunId: string;
  objectiveId: string;
  objectiveVersion: number;
  reason: RunReplacementReason;
}): string {
  return `rrunrepl_${hashCanonical(input).slice(0, 32)}`;
}

/**
 * Missing evidenceClass is legacy Class A only for the single transition the
 * pre-evidence implementation could mint: SYSTEM_DEFECT_RETRY, attempt 1 → 2.
 * That implementation required the token-reservation proof. Any other missing
 * or unrecognized class is malformed lineage and is not rewritten.
 */
export function evidenceClassFromReplacementPayload(
  payload: Readonly<Record<string, string | number | boolean | null>>,
): RunReplacementEvidenceClass {
  const raw = payload["evidenceClass"];
  if (
    raw === "TOKEN_RESERVATION_EXHAUSTION" ||
    raw === "POST_MODEL_DETERMINISTIC_FAILURE"
  ) {
    return raw;
  }
  if (raw !== undefined && raw !== null) {
    throw lineageConflict(
      "MALFORMED_REPLACEMENT_LINEAGE",
      "Replacement lineage evidenceClass is not a governed class",
    );
  }
  const predecessorRunAttempt = Number(payload["predecessorRunAttempt"]);
  const replacementRunAttempt = Number(payload["replacementRunAttempt"]);
  if (
    payload["reason"] === "SYSTEM_DEFECT_RETRY" &&
    predecessorRunAttempt === 1 &&
    replacementRunAttempt === 2
  ) {
    return "TOKEN_RESERVATION_EXHAUSTION";
  }
  throw lineageConflict(
    "MALFORMED_REPLACEMENT_LINEAGE",
    "Replacement lineage is missing evidenceClass",
  );
}

export function recoveryRunReplacementLineage(
  events: readonly ProductAuditEvent[],
): RecoveryRunReplacementLineageEntry[] {
  return events
    .filter((event) => event.kind === "RECOVERY_RUN_REPLACED" && event.payload)
    .map((event) => {
      const payload = event.payload!;
      return {
        replacementId: String(payload["replacementId"]),
        recoveryCaseId: String(payload["recoveryCaseId"]),
        objectiveId: String(payload["objectiveId"]),
        objectiveVersion: Number(payload["objectiveVersion"]),
        predecessorRunId: String(payload["predecessorRunId"]),
        predecessorRunAttempt: Number(payload["predecessorRunAttempt"]),
        replacementRunId: String(payload["replacementRunId"]),
        replacementRunAttempt: Number(payload["replacementRunAttempt"]),
        reason: String(payload["reason"]),
        evidenceClass: evidenceClassFromReplacementPayload(payload),
        principalId:
          typeof payload["principalId"] === "string"
            ? payload["principalId"]
            : null,
        occurredAt: event.occurredAt,
      };
    })
    .sort((a, b) => a.replacementRunAttempt - b.replacementRunAttempt);
}

/**
 * A replacement chain is continuous, unforked, and consumes each evidence
 * class once. Historical rows are not repaired.
 */
export function validateReplacementLineage(
  entries: readonly RecoveryRunReplacementLineageEntry[],
): void {
  const sorted = [...entries].sort(
    (a, b) => a.replacementRunAttempt - b.replacementRunAttempt,
  );
  const predecessors = new Set<string>();
  const replacements = new Set<string>();
  const attempts = new Set<number>();
  const classes = new Set<string>();
  let previous: RecoveryRunReplacementLineageEntry | null = null;
  for (const entry of sorted) {
    if (entry.reason !== "SYSTEM_DEFECT_RETRY") {
      throw lineageConflict(
        "MALFORMED_REPLACEMENT_LINEAGE",
        "Replacement lineage reason is not SYSTEM_DEFECT_RETRY",
      );
    }
    if (
      !Number.isInteger(entry.predecessorRunAttempt) ||
      entry.predecessorRunAttempt < 1 ||
      entry.replacementRunAttempt !== entry.predecessorRunAttempt + 1 ||
      entry.replacementRunAttempt > MAX_GOVERNED_SYSTEM_DEFECT_RUN_ATTEMPT
    ) {
      throw lineageConflict(
        "MALFORMED_REPLACEMENT_LINEAGE",
        "Replacement lineage attempt chain is not continuous",
      );
    }
    if (
      predecessors.has(entry.predecessorRunId) ||
      replacements.has(entry.replacementRunId) ||
      attempts.has(entry.replacementRunAttempt) ||
      classes.has(entry.evidenceClass)
    ) {
      throw lineageConflict(
        "MALFORMED_REPLACEMENT_LINEAGE",
        "Replacement lineage repeats a predecessor, successor, attempt, or evidence class",
      );
    }
    if (previous === null) {
      if (entry.predecessorRunAttempt !== 1) {
        throw lineageConflict(
          "MALFORMED_REPLACEMENT_LINEAGE",
          "Replacement lineage does not start at run attempt 1",
        );
      }
    } else if (
      entry.predecessorRunId !== previous.replacementRunId ||
      entry.predecessorRunAttempt !== previous.replacementRunAttempt
    ) {
      throw lineageConflict(
        "MALFORMED_REPLACEMENT_LINEAGE",
        "Replacement lineage is forked or has a gap",
      );
    }
    predecessors.add(entry.predecessorRunId);
    replacements.add(entry.replacementRunId);
    attempts.add(entry.replacementRunAttempt);
    classes.add(entry.evidenceClass);
    previous = entry;
  }
}

/**
 * Durable proof that planning stopped on the token-reservation branch.
 *
 * PLANNING_MODEL_BUDGET_EXCEEDED has two producers: the LLM-call ceiling and
 * reservedTokens > remaining. The fence stores the code, not the dimension.
 * llmCalls still below the resolved maximumLlmCalls excludes the call-count
 * branch, so the recorded failure is the token-reservation branch.
 *
 * Reservation size is inputTokenEstimate + maxOutputTokens, so a failed retry
 * can leave remaining well above one output cap. Remaining tokens are not a
 * second proof.
 *
 * Charged usage records do not currently persist budgetProfileId. When a
 * record does carry one, it must match the resolved project budget.
 */
export function assertReplacementPlanningEvidence(input: {
  fence: PlanningFence | null;
  usage: readonly PlanningModelUsage[];
  budget: ResourceBudgetProfile;
}): void {
  const fence = input.fence;
  if (
    !fence ||
    fence.status !== "FAILED" ||
    fence.failureCode !== "PLANNING_MODEL_BUDGET_EXCEEDED" ||
    fence.retryable !== true
  ) {
    throw notEligible(
      "PLANNING_FAILURE_UNPROVEN",
      "Durable planning evidence does not prove a retryable token-budget failure",
    );
  }
  if (input.usage.some((record) => record.status === "STARTED")) {
    throw notEligible(
      "PLANNING_FAILURE_UNPROVEN",
      "Planning usage still has an active reservation",
    );
  }
  const settled = input.usage.filter(
    (record) =>
      record.status === "SUCCESS" ||
      record.status === "FAILED" ||
      record.status === "TIMEOUT" ||
      record.status === "REFUSED",
  );
  if (!settled.some((record) => (record.totalUsage ?? 0) > 0)) {
    throw notEligible(
      "PLANNING_FAILURE_UNPROVEN",
      "Planning usage has no settled consumption",
    );
  }
  const aggregate = aggregatePlanningUsage(input.usage);
  if (aggregate.budgetInvariantViolated) {
    throw notEligible(
      "PLANNING_FAILURE_UNPROVEN",
      "Planning usage recorded a budget invariant violation",
    );
  }
  if (aggregate.llmCalls >= input.budget.maximumLlmCalls) {
    throw notEligible(
      "PLANNING_FAILURE_UNPROVEN",
      "Planning call limit is exhausted; token exhaustion is not the proven dimension",
    );
  }
  const foreignProfile = settled.some((record) => {
    const profileId = (record as { budgetProfileId?: unknown }).budgetProfileId;
    return (
      typeof profileId === "string" &&
      profileId.length > 0 &&
      profileId !== input.budget.budgetProfileId
    );
  });
  if (foreignProfile) {
    throw notEligible(
      "PLANNING_FAILURE_UNPROVEN",
      "Charged planning usage names a different budget profile than the resolved project budget",
    );
  }
}

/**
 * Inference for the failed fence attempt completed, and deterministic
 * post-model processing failed before a plan was saved. The fence code alone
 * is not this proof.
 */
export function assertPostModelDeterministicFailure(input: {
  fence: PlanningFence | null;
  usage: readonly PlanningModelUsage[];
}): void {
  const fence = input.fence;
  if (
    !fence ||
    fence.status !== "FAILED" ||
    fence.failureCode !== "RECOVERY_TARGET_BINDING_FAILED" ||
    fence.retryable !== true
  ) {
    throw notEligible(
      "POST_MODEL_FAILURE_UNPROVEN",
      "Durable planning evidence does not prove a retryable post-model failure",
    );
  }
  if (input.usage.some((record) => record.status === "STARTED")) {
    throw notEligible(
      "POST_MODEL_FAILURE_UNPROVEN",
      "Planning usage still has an active reservation",
    );
  }
  if (aggregatePlanningUsage(input.usage).budgetInvariantViolated) {
    throw notEligible(
      "POST_MODEL_FAILURE_UNPROVEN",
      "Planning usage recorded a budget invariant violation",
    );
  }
  const onAttempt = input.usage.filter(
    (record) => record.planningAttempt === fence.attempt,
  );
  const bound = onAttempt.filter((record) => record.provider.trim().length > 0);
  const gap = bound.filter((record) => record.operation === "GAP_ANALYSIS");
  const proposal = bound.filter((record) => record.operation === "PLAN_PROPOSAL");
  const proven = (record: PlanningModelUsage | undefined) =>
    record?.status === "SUCCESS" && (record.totalUsage ?? 0) > 0;
  if (
    onAttempt.length !== 2 ||
    bound.length !== 2 ||
    gap.length !== 1 ||
    proposal.length !== 1 ||
    !proven(gap[0]) ||
    !proven(proposal[0])
  ) {
    throw notEligible(
      "POST_MODEL_FAILURE_UNPROVEN",
      "Durable usage does not prove one successful gap analysis and one successful plan proposal for the failed planning attempt",
    );
  }
}

/**
 * Exactly one governed defect class, or fail closed. Class A and Class B
 * are different fence codes, so a record cannot satisfy both.
 */
export function classifyRunReplacementEvidence(input: {
  fence: PlanningFence | null;
  usage: readonly PlanningModelUsage[];
  budget: ResourceBudgetProfile;
}): RunReplacementEvidenceClass {
  if (input.fence?.failureCode === "PLANNING_MODEL_BUDGET_EXCEEDED") {
    assertReplacementPlanningEvidence(input);
    return "TOKEN_RESERVATION_EXHAUSTION";
  }
  if (input.fence?.failureCode === "RECOVERY_TARGET_BINDING_FAILED") {
    assertPostModelDeterministicFailure(input);
    return "POST_MODEL_DETERMINISTIC_FAILURE";
  }
  throw notEligible(
    "PLANNING_FAILURE_UNPROVEN",
    "Durable planning evidence does not prove a governed system defect",
  );
}

function lineageConflict(
  reasonCode: string,
  message: string,
): RevenueRecoveryError {
  return new RevenueRecoveryError("RUN_REPLACEMENT_CONFLICT", message, {
    reasonCode,
  });
}

function limitReached(
  reasonCode: string,
  message: string,
  details: Record<string, unknown> = {},
): RevenueRecoveryError {
  return new RevenueRecoveryError("RUN_REPLACEMENT_LIMIT_REACHED", message, {
    reasonCode,
    ...details,
  });
}

function notEligible(
  reasonCode: string,
  message: string,
  details: Record<string, unknown> = {},
): RevenueRecoveryError {
  return new RevenueRecoveryError("RUN_REPLACEMENT_NOT_ELIGIBLE", message, {
    reasonCode,
    ...details,
  });
}

function contentFingerprint(objective: {
  requestedOutcome: string;
  acceptanceCriteria: readonly string[];
  nonGoals: readonly string[];
  constraints: readonly string[];
  priority: Objective["priority"];
  deadline?: string | undefined;
}): string {
  return objectiveFingerprint({
    requestedOutcome: objective.requestedOutcome,
    acceptanceCriteria: objective.acceptanceCriteria,
    nonGoals: objective.nonGoals,
    constraints: objective.constraints,
    priority: objective.priority,
    ...(objective.deadline !== undefined ? { deadline: objective.deadline } : {}),
  });
}

function addMs(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}

export class RecoveryRunReplacementService {
  constructor(private readonly deps: RecoveryRunReplacementDeps) {}

  async replace(input: {
    recoveryCaseId: string;
    body: unknown;
    principalId?: string;
  }): Promise<RecoveryRunReplacementResult> {
    const parsed = RunReplacementRequestSchema.safeParse(input.body);
    if (!parsed.success) {
      throw new RevenueRecoveryError(
        "RUN_REPLACEMENT_INVALID",
        "Run replacement request is invalid",
        {
          fields: [
            ...new Set(
              parsed.error.issues.flatMap((issue) =>
                issue.code === "unrecognized_keys"
                  ? issue.keys
                  : [issue.path.join(".") || "(root)"],
              ),
            ),
          ].sort(),
        },
      );
    }
    try {
      return await this.deps.withReplacementLock(input.recoveryCaseId, () =>
        this.replaceLocked(
          input.recoveryCaseId,
          parsed.data,
          input.principalId,
        ),
      );
    } catch (error) {
      if (isDurabilityError(error) && error.code === "DURABLE_CONFLICT") {
        throw new RevenueRecoveryError(
          "RUN_REPLACEMENT_CONFLICT",
          "Durable run replacement conflict",
          { reasonCode: "DURABLE_CONFLICT" },
        );
      }
      throw error;
    }
  }

  private async replaceLocked(
    recoveryCaseId: string,
    request: RunReplacementRequest,
    principalId: string | undefined,
  ): Promise<RecoveryRunReplacementResult> {
    const recoveryCase = await this.deps.cases.getById(recoveryCaseId);
    if (!recoveryCase) {
      throw new RevenueRecoveryError(
        "RECOVERY_CASE_NOT_FOUND",
        `Unknown recovery case ${recoveryCaseId}`,
      );
    }
    if (
      recoveryCase.customerAccountId !== request.customerAccountId ||
      recoveryCase.projectId !== request.projectId
    ) {
      throw new RevenueRecoveryError(
        "TENANT_ISOLATION_VIOLATION",
        "Cross-tenant access denied",
      );
    }

    const objectiveId = recoveryObjectiveId(recoveryCase.recoveryCaseId);
    const objectiveVersion = recoveryCase.recoveryObjectiveVersion ?? 1;
    if (recoveryCase.objectiveId !== objectiveId) {
      throw notEligible(
        "CASE_OBJECTIVE_MISMATCH",
        "RecoveryCase objective identity does not match the canonical objective",
      );
    }

    const events = await this.deps.audits.listByCase(recoveryCase.recoveryCaseId);
    const lineage = recoveryRunReplacementLineage(events).filter(
      (entry) =>
        entry.objectiveId === objectiveId &&
        entry.objectiveVersion === objectiveVersion,
    );
    validateReplacementLineage(lineage);
    const historical = lineage.filter(
      (entry) => entry.predecessorRunId === request.expectedPredecessorRunId,
    );
    if (historical.length > 1) {
      throw lineageConflict(
        "MALFORMED_REPLACEMENT_LINEAGE",
        "More than one replacement records the expected predecessor",
      );
    }
    if (historical.length === 1) {
      return this.alreadyReplaced(historical[0]!);
    }

    if (recoveryCase.status !== "IN_ORCHESTRATION") {
      throw notEligible(
        "CASE_NOT_IN_ORCHESTRATION",
        "RecoveryCase is not in orchestration",
        { caseStatus: recoveryCase.status },
      );
    }
    const predecessorRunId = recoveryCase.orchestratorRunId;
    if (!predecessorRunId || predecessorRunId !== request.expectedPredecessorRunId) {
      throw notEligible(
        "EXPECTED_PREDECESSOR_MISMATCH",
        "Expected predecessor is not the RecoveryCase current run",
        {
          expectedPredecessorRunId: request.expectedPredecessorRunId,
          currentRunId: predecessorRunId ?? null,
        },
      );
    }
    const named = await this.deps.orchestrator.runs.getById(predecessorRunId);
    if (!named) {
      throw notEligible("PREDECESSOR_NOT_FOUND", "Predecessor run not found", {
        predecessorRunId,
      });
    }
    if (named.runAttempt >= MAX_GOVERNED_SYSTEM_DEFECT_RUN_ATTEMPT) {
      throw limitReached(
        "MAX_RUN_ATTEMPT_REACHED",
        "Governed system-defect replacement cannot mint another run attempt",
        { predecessorRunAttempt: named.runAttempt },
      );
    }

    const predecessor = await this.provePredecessor({
      recoveryCase,
      predecessorRunId,
      objectiveId,
      objectiveVersion,
    });
    const objective = await this.deps.orchestrator.objectives.getByRunBinding(
      predecessor.runId,
    );
    const stored = await this.deps.orchestrator.objectives.getById(
      objectiveId,
      objectiveVersion,
    );
    if (!objective || !stored) {
      throw notEligible(
        "OBJECTIVE_MISSING",
        "Canonical objective content is not stored",
      );
    }
    const fingerprint = contentFingerprint(stored);
    if (
      contentFingerprint(objective) !== fingerprint ||
      stored.projectId !== recoveryCase.projectId ||
      objective.objectiveId !== objectiveId ||
      objective.objectiveVersion !== objectiveVersion
    ) {
      throw notEligible(
        "PREDECESSOR_BINDING_INCONSISTENT",
        "Stored objective does not match the predecessor binding",
      );
    }

    let budget: ResourceBudgetProfile;
    try {
      const context = await this.deps.orchestrator.controlPlane.resolve(
        predecessor.projectId,
        predecessor.requestedEnvironment,
      );
      budget = context.resourceBudget;
    } catch {
      throw notEligible(
        "CONTROL_PLANE_UNRESOLVED",
        "Project control context could not be resolved",
      );
    }
    const usage = await this.deps.orchestrator.usage.listByRunId(predecessor.runId);
    const fence = await this.deps.orchestrator.planning.get(predecessor.runId);
    const evidenceClass = classifyRunReplacementEvidence({ fence, usage, budget });
    if (lineage.some((entry) => entry.evidenceClass === evidenceClass)) {
      throw limitReached(
        "EVIDENCE_CLASS_ALREADY_CONSUMED",
        "This evidence class already authorized a system-defect replacement",
        { evidenceClass },
      );
    }

    const maxAttempt = await this.deps.orchestrator.runs.maxRunAttempt({
      projectId: predecessor.projectId,
      objectiveId,
      objectiveVersion,
      requestedEnvironment: predecessor.requestedEnvironment,
    });
    const replacementRunAttempt = predecessor.runAttempt + 1;
    const last = lineage[lineage.length - 1];
    const chainAgrees =
      lineage.length === 0
        ? predecessor.runAttempt === 1
        : last?.replacementRunId === predecessor.runId &&
          last.replacementRunAttempt === predecessor.runAttempt;
    if (!chainAgrees || maxAttempt !== predecessor.runAttempt) {
      throw lineageConflict(
        "MALFORMED_REPLACEMENT_LINEAGE",
        "Current run does not continue the replacement lineage",
      );
    }
    if (replacementRunAttempt > MAX_GOVERNED_SYSTEM_DEFECT_RUN_ATTEMPT) {
      throw limitReached(
        "MAX_RUN_ATTEMPT_REACHED",
        "Governed system-defect replacement cannot mint another run attempt",
        { maxAttempt, predecessorRunAttempt: predecessor.runAttempt },
      );
    }

    const idempotencyKey = runReplacementIdempotencyKey({
      projectId: predecessor.projectId,
      objectiveId,
      objectiveVersion,
      requestedEnvironment: predecessor.requestedEnvironment,
      predecessorRunId: predecessor.runId,
      replacementReason: request.reason,
    });
    const materialFingerprint = runReplacementMaterialFingerprint({
      objectiveFingerprint: fingerprint,
      predecessorRunId: predecessor.runId,
      replacementReason: request.reason,
      objectiveId,
      objectiveVersion,
      requestedEnvironment: predecessor.requestedEnvironment,
      projectId: predecessor.projectId,
    });

    const now = this.deps.nowIso();
    const reserved = await this.deps.orchestrator.idempotency.reserve(
      idempotencyKey,
      materialFingerprint,
      now,
    );
    if (reserved.status !== "NEW") {
      return this.convergeReserved({
        reserved,
        idempotencyKey,
        recoveryCase,
        objectiveId,
        objectiveVersion,
        predecessor,
        reason: request.reason,
        evidenceClass,
      });
    }

    const identity = this.deps.identities.next();
    try {
      const lock = await this.deps.orchestrator.locks.acquire({
        projectId: predecessor.projectId,
        runId: identity.runId,
        lockOwner: predecessor.requesterId,
        acquiredAt: now,
        expiresAt: addMs(now, LOCK_TTL_MS),
      });
      if (lock.result === "RESOURCE_CONFLICT") {
        throw new RevenueRecoveryError(
          "RUN_REPLACEMENT_CONFLICT",
          "Project admission lock is held by another run",
          { reasonCode: "PROJECT_LOCK_CONFLICT" },
        );
      }

      const received: RunRecord = {
        runId: identity.runId,
        projectId: predecessor.projectId,
        objectiveId,
        objectiveVersion,
        runAttempt: replacementRunAttempt,
        idempotencyKey,
        requesterId: predecessor.requesterId,
        requestedEnvironment: predecessor.requestedEnvironment,
        state: "RECEIVED",
        recordRevision: 1,
        createdAt: now,
        updatedAt: now,
        correlationId: identity.correlationId,
        traceId: identity.traceId,
      };
      const created = await this.deps.orchestrator.runs.create(received);
      const admitted = await commitRunTransition(
        this.deps.orchestrator.runs,
        created,
        "ADMITTED",
        now,
        { admittedAt: now },
      );
      await this.deps.orchestrator.objectives.bindRun(
        admitted.runId,
        objectiveId,
        objectiveVersion,
      );
      const bound = await this.deps.orchestrator.objectives.getByRunBinding(
        admitted.runId,
      );
      if (
        !bound ||
        bound.objectiveId !== objectiveId ||
        bound.objectiveVersion !== objectiveVersion ||
        contentFingerprint(bound) !== fingerprint
      ) {
        throw new RevenueRecoveryError(
          "RUN_REPLACEMENT_CONFLICT",
          "Replacement run is not bound to the existing objective",
        );
      }
      await this.deps.orchestrator.events.append(
        parseEventEnvelope({
          eventId: identity.eventId,
          eventType: PROJECT_RUN_REPLACEMENT_ADMITTED,
          eventVersion: "1",
          runId: admitted.runId,
          correlationId: identity.correlationId,
          causationId: identity.eventId,
          idempotencyKey,
          projectId: admitted.projectId,
          objectiveId,
          objectiveVersion,
          traceId: identity.traceId,
          createdAt: now,
          expiresAt: addMs(now, EVENT_TTL_MS),
          schemaVersion: "1.0.0",
          data: {
            predecessorRunId: predecessor.runId,
            predecessorRunAttempt: predecessor.runAttempt,
            replacementRunAttempt,
            reason: request.reason,
            evidenceClass,
            requesterId: predecessor.requesterId,
            requestedEnvironment: predecessor.requestedEnvironment,
          },
        }),
      );
      await this.deps.orchestrator.idempotency.complete(
        idempotencyKey,
        admitted.runId,
        now,
      );

      const freshPredecessor = await this.deps.orchestrator.runs.getById(
        predecessor.runId,
      );
      if (
        !freshPredecessor ||
        freshPredecessor.state !== "PLANNING" ||
        freshPredecessor.recordRevision !== predecessor.recordRevision
      ) {
        throw new RevenueRecoveryError(
          "RUN_REPLACEMENT_BINDING_CHANGED",
          "Predecessor run changed before supersession",
        );
      }
      const superseded = await commitRunTransition(
        this.deps.orchestrator.runs,
        freshPredecessor,
        "SUPERSEDED",
        now,
      );

      const replacementId = recoveryRunReplacementId({
        recoveryCaseId: recoveryCase.recoveryCaseId,
        predecessorRunId: predecessor.runId,
        objectiveId,
        objectiveVersion,
        reason: request.reason,
      });
      const rebound = await this.deps.cases.compareAndSetOrchestratorRunBinding({
        recoveryCaseId: recoveryCase.recoveryCaseId,
        expectedOrchestratorRunId: predecessor.runId,
        expectedObjectiveVersion: objectiveVersion,
        expectedRecordRevision: recoveryCase.recordRevision,
        orchestratorRunId: admitted.runId,
        objectiveId,
        objectiveVersion,
        updatedAt: now,
      });
      if (!rebound) {
        throw new RevenueRecoveryError(
          "RUN_REPLACEMENT_BINDING_CHANGED",
          "RecoveryCase binding changed concurrently",
          { recoveryCaseId: recoveryCase.recoveryCaseId },
        );
      }

      await this.deps.audits.append({
        eventId: newAuditEventId({
          kind: "RECOVERY_RUN_REPLACED",
          occurredAt: now,
          recoveryCaseId: recoveryCase.recoveryCaseId,
          subjectRef: replacementId,
        }),
        kind: "RECOVERY_RUN_REPLACED",
        customerAccountId: recoveryCase.customerAccountId,
        projectId: recoveryCase.projectId,
        leadId: recoveryCase.leadId,
        recoveryCaseId: recoveryCase.recoveryCaseId,
        occurredAt: now,
        payload: {
          replacementId,
          recoveryCaseId: recoveryCase.recoveryCaseId,
          objectiveId,
          objectiveVersion,
          predecessorRunId: predecessor.runId,
          predecessorRunAttempt: predecessor.runAttempt,
          replacementRunId: admitted.runId,
          replacementRunAttempt,
          reason: request.reason,
          evidenceClass,
          principalId: principalId ?? null,
        },
      });

      await this.deps.orchestrator.locks.release(
        predecessor.projectId,
        admitted.runId,
      );

      return {
        outcome: "REPLACED",
        replacementId,
        recoveryCaseId: recoveryCase.recoveryCaseId,
        objectiveId,
        objectiveVersion,
        predecessorRunId: predecessor.runId,
        predecessorRunAttempt: predecessor.runAttempt,
        predecessorRunState: superseded.state,
        replacementRunId: admitted.runId,
        replacementRunAttempt,
        replacementRunState: admitted.state,
        reason: request.reason,
        evidenceClass,
      };
    } catch (error) {
      await this.deps.orchestrator.idempotency
        .release(idempotencyKey)
        .catch(() => undefined);
      await this.deps.orchestrator.locks
        .release(predecessor.projectId, identity.runId)
        .catch(() => undefined);
      throw error;
    }
  }

  private async alreadyReplaced(
    existing: RecoveryRunReplacementLineageEntry,
  ): Promise<RecoveryRunReplacementResult> {
    if (existing.reason !== "SYSTEM_DEFECT_RETRY") {
      throw new RevenueRecoveryError(
        "RUN_REPLACEMENT_CONFLICT",
        "Replacement lineage reason is not SYSTEM_DEFECT_RETRY",
      );
    }
    const replacement = await this.deps.orchestrator.runs.getById(
      existing.replacementRunId,
    );
    const predecessor = await this.deps.orchestrator.runs.getById(
      existing.predecessorRunId,
    );
    return {
      outcome: "ALREADY_REPLACED",
      replacementId: existing.replacementId,
      recoveryCaseId: existing.recoveryCaseId,
      objectiveId: existing.objectiveId,
      objectiveVersion: existing.objectiveVersion,
      predecessorRunId: existing.predecessorRunId,
      predecessorRunAttempt: existing.predecessorRunAttempt,
      predecessorRunState: predecessor?.state ?? null,
      replacementRunId: existing.replacementRunId,
      replacementRunAttempt: existing.replacementRunAttempt,
      replacementRunState: replacement?.state ?? null,
      reason: existing.reason,
      evidenceClass: existing.evidenceClass,
    };
  }

  private async convergeReserved(input: {
    reserved: Exclude<
      Awaited<ReturnType<IdempotencyStore["reserve"]>>,
      { status: "NEW" }
    >;
    idempotencyKey: string;
    recoveryCase: RecoveryCase;
    objectiveId: string;
    objectiveVersion: number;
    predecessor: RunRecord;
    reason: RunReplacementReason;
    evidenceClass: RunReplacementEvidenceClass;
  }): Promise<RecoveryRunReplacementResult> {
    if (
      input.reserved.status === "OBJECTIVE_VERSION_CONFLICT" ||
      input.reserved.runId === null
    ) {
      throw new RevenueRecoveryError(
        "RUN_REPLACEMENT_CONFLICT",
        "Replacement idempotency material conflicts with an existing reservation",
      );
    }
    const existingRun = await this.deps.orchestrator.runs.getById(
      input.reserved.runId,
    );
    if (
      !existingRun ||
      existingRun.idempotencyKey !== input.idempotencyKey ||
      input.recoveryCase.orchestratorRunId !== existingRun.runId
    ) {
      throw new RevenueRecoveryError(
        "RUN_REPLACEMENT_CONFLICT",
        "Replacement idempotency key is already bound to a different run",
      );
    }
    const replacementId = recoveryRunReplacementId({
      recoveryCaseId: input.recoveryCase.recoveryCaseId,
      predecessorRunId: input.predecessor.runId,
      objectiveId: input.objectiveId,
      objectiveVersion: input.objectiveVersion,
      reason: input.reason,
    });
    return {
      outcome: "ALREADY_REPLACED",
      replacementId,
      recoveryCaseId: input.recoveryCase.recoveryCaseId,
      objectiveId: input.objectiveId,
      objectiveVersion: input.objectiveVersion,
      predecessorRunId: input.predecessor.runId,
      predecessorRunAttempt: input.predecessor.runAttempt,
      predecessorRunState: input.predecessor.state,
      replacementRunId: existingRun.runId,
      replacementRunAttempt: existingRun.runAttempt,
      replacementRunState: existingRun.state,
      reason: input.reason,
      evidenceClass: input.evidenceClass,
    };
  }

  private async provePredecessor(input: {
    recoveryCase: RecoveryCase;
    predecessorRunId: string;
    objectiveId: string;
    objectiveVersion: number;
  }): Promise<RunRecord> {
    const { orchestrator } = this.deps;
    const run = await orchestrator.runs.getById(input.predecessorRunId);
    if (!run) {
      throw notEligible("PREDECESSOR_NOT_FOUND", "Predecessor run not found", {
        predecessorRunId: input.predecessorRunId,
      });
    }
    if (
      run.projectId !== input.recoveryCase.projectId ||
      run.objectiveId !== input.objectiveId ||
      run.objectiveVersion !== input.objectiveVersion
    ) {
      throw notEligible(
        "PREDECESSOR_BINDING_INCONSISTENT",
        "Predecessor run does not match the case objective",
        { predecessorRunId: input.predecessorRunId },
      );
    }
    if (run.state !== "PLANNING") {
      throw notEligible(
        "PREDECESSOR_NOT_PLANNING",
        `Predecessor run is ${run.state}`,
        { predecessorRunId: input.predecessorRunId, predecessorState: run.state },
      );
    }

    const plans = await orchestrator.plans.listByRunId(run.runId);
    if (plans.length > 0) {
      throw notEligible("PLAN_PRESENT", "Predecessor run has a persisted plan", {
        predecessorRunId: run.runId,
      });
    }
    const approvals = await orchestrator.approvalRequests.listByRun(run.runId);
    if (approvals.length > 0) {
      throw notEligible(
        "APPROVAL_PRESENT",
        "Predecessor run has an ApprovalRequest",
        { predecessorRunId: run.runId },
      );
    }
    const authorizations = await orchestrator.authorizationRecords.listByRun(
      run.runId,
    );
    if (authorizations.length > 0) {
      throw new RevenueRecoveryError(
        "RUN_REPLACEMENT_AUTHORITY_PRESENT",
        "Predecessor run has authorization records",
        { predecessorRunId: run.runId, reasonCode: "AUTHORIZATION_PRESENT" },
      );
    }
    const executionAttempts = await orchestrator.executionAttempts.listByRun(
      run.runId,
    );
    if (executionAttempts.length > 0) {
      throw new RevenueRecoveryError(
        "RUN_REPLACEMENT_AUTHORITY_PRESENT",
        "Predecessor run has execution attempts",
        { predecessorRunId: run.runId, reasonCode: "EXECUTION_PRESENT" },
      );
    }
    const recoveryAttempts = await this.deps.attempts.listByCase(
      input.recoveryCase.recoveryCaseId,
    );
    if (recoveryAttempts.some((attempt) => attempt.runId === run.runId)) {
      throw new RevenueRecoveryError(
        "RUN_REPLACEMENT_AUTHORITY_PRESENT",
        "Predecessor run has recovery attempts",
        { predecessorRunId: run.runId, reasonCode: "RECOVERY_ATTEMPT_PRESENT" },
      );
    }
    const authority = assessHistoricalExecutionAuthority({
      runId: run.runId,
      authorizationRecords: authorizations,
      approvalRequests: approvals,
      plans,
    });
    if (authority.kind !== "NONE") {
      throw new RevenueRecoveryError(
        "RUN_REPLACEMENT_AUTHORITY_PRESENT",
        "Predecessor run does not have empty execution authority",
        { predecessorRunId: run.runId, reasonCode: authority.kind },
      );
    }
    return run;
  }
}
