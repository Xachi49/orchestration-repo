/**
 * Governed Revenue Recovery objective reissue.
 *
 * OBJECTIVE V1 != OBJECTIVE V2. RUN A != RUN B.
 * AUTHORITY FOR RUN A != AUTHORITY FOR RUN B.
 * OBJECTIVE REISSUE != PLAN REVISION.
 * REPLACEMENT RUN != REUSE OF PREDECESSOR AUTHORIZATION.
 * CASE POINTER != HISTORY. IDEMPOTENCY != UNBOUNDED REISSUE.
 *
 * Mints the next objective version for the same RecoveryCase through normal
 * Phase 2 admission and moves the case's current-run pointer by compare-and-set.
 * It never terminates the predecessor, never touches its approval, plan,
 * validation, or authorization records, and never creates authority.
 */
import { z } from "zod";
import type { AdmissionRequest } from "../admission/request.js";
import type { AdmissionResult } from "../admission/result.js";
import type { ObjectiveRepository } from "../admission/objective-repository.js";
import type { RunRecord, RunRepository } from "../admission/run-repository.js";
import type { ApprovalRequestRepository } from "../authorization/approval-request-repository.js";
import { assessHistoricalExecutionAuthority } from "../authorization/historical-authority.js";
import type { AuthorizationRecordRepository } from "../authorization/authorization-record-repository.js";
import { objectiveFingerprint } from "../domain/objective/fingerprint.js";
import type { Objective } from "../domain/objective/objective.js";
import type { ExecutionAttemptRepository } from "../execution/attempt-repository.js";
import type { PlanRepository } from "../planning/plan-repository.js";
import { newAuditEventId, type ProductAuditEvent } from "./audit.js";
import type { ContactPolicyResult } from "./contact-policy.js";
import { RevenueRecoveryError } from "./errors.js";
import { hashCanonical } from "./hash.js";
import type { RecoveryCase } from "./recovery-case.js";
import type {
  ProductAuditRepository,
  RecoveryAttemptRepository,
  RecoveryCaseRepository,
} from "./repositories.js";

export const OBJECTIVE_REISSUE_REASONS = [
  "OBJECTIVE_MAPPING_CORRECTION",
] as const;
export type ObjectiveReissueReason = (typeof OBJECTIVE_REISSUE_REASONS)[number];

/**
 * Terminal predecessor states that are reached only by a governed Phase 6
 * outcome that grants nothing (human REJECT, approval expiry).
 */
export const OBJECTIVE_REISSUE_PREDECESSOR_STATES = [
  "REJECTED",
  "EXPIRED",
] as const;

/** Everything else — objective content, versions, run/plan/approval data — is server-derived. */
export const ObjectiveReissueRequestSchema = z
  .object({
    customerAccountId: z.string().min(1),
    projectId: z.string().min(1),
    reason: z.enum(OBJECTIVE_REISSUE_REASONS),
  })
  .strict();
export type ObjectiveReissueRequest = z.infer<typeof ObjectiveReissueRequestSchema>;

/** Read-only orchestrator evidence used to prove the predecessor holds no authority. */
export interface RecoveryObjectiveReissueOrchestratorPorts {
  runs: Pick<RunRepository, "getById">;
  objectives: Pick<ObjectiveRepository, "getById" | "getByRunBinding">;
  plans: Pick<PlanRepository, "listByRunId">;
  approvalRequests: Pick<ApprovalRequestRepository, "listByRun">;
  authorizationRecords: Pick<AuthorizationRecordRepository, "listByRun">;
  executionAttempts: Pick<ExecutionAttemptRepository, "listByRun">;
}

export type CanonicalRecoveryObjective = {
  admissionRequest: AdmissionRequest;
  contactPolicy: ContactPolicyResult;
};

export interface RecoveryObjectiveReissueDeps {
  nowIso: () => string;
  cases: RecoveryCaseRepository;
  attempts: Pick<RecoveryAttemptRepository, "listByCase">;
  audits: ProductAuditRepository;
  admission: { admit(input: unknown): Promise<AdmissionResult> };
  orchestrator: RecoveryObjectiveReissueOrchestratorPorts;
  /** Canonical fixed mapper — the only source of objective content. */
  buildCanonicalObjective: (input: {
    recoveryCase: RecoveryCase;
    requesterId: string;
    requestedEnvironment: string;
    objectiveVersion: number;
  }) => Promise<CanonicalRecoveryObjective>;
  /**
   * Serializes reissue per case. Durable composers run `fn` inside one database
   * transaction so admission, case rebind, and audit commit or roll back together.
   */
  withReissueLock: <T>(recoveryCaseId: string, fn: () => Promise<T>) => Promise<T>;
}

export type RecoveryObjectiveReissueResult = {
  outcome: "REISSUED" | "ALREADY_REISSUED";
  reissueId: string;
  recoveryCaseId: string;
  objectiveId: string;
  sourceObjectiveVersion: number;
  targetObjectiveVersion: number;
  predecessorRunId: string;
  replacementRunId: string;
  replacementRunState: string | null;
  reason: ObjectiveReissueReason;
};

export type RecoveryObjectiveLineageEntry = {
  reissueId: string;
  objectiveId: string;
  sourceObjectiveVersion: number;
  targetObjectiveVersion: number;
  predecessorRunId: string;
  replacementRunId: string;
  reason: string;
  principalId: string | null;
  occurredAt: string;
};

export function recoveryObjectiveId(recoveryCaseId: string): string {
  return `obj_rr_${recoveryCaseId}`;
}

export function objectiveReissueId(input: {
  recoveryCaseId: string;
  predecessorRunId: string;
  targetObjectiveVersion: number;
  reason: ObjectiveReissueReason;
}): string {
  return `rreissue_${hashCanonical(input).slice(0, 32)}`;
}

/** Predecessor → replacement lineage, oldest first, from immutable audit events. */
export function recoveryObjectiveLineage(
  events: readonly ProductAuditEvent[],
): RecoveryObjectiveLineageEntry[] {
  return events
    .filter((e) => e.kind === "RECOVERY_OBJECTIVE_REISSUED" && e.payload)
    .map((e) => {
      const p = e.payload!;
      return {
        reissueId: String(p["reissueId"]),
        objectiveId: String(p["objectiveId"]),
        sourceObjectiveVersion: Number(p["sourceObjectiveVersion"]),
        targetObjectiveVersion: Number(p["targetObjectiveVersion"]),
        predecessorRunId: String(p["predecessorRunId"]),
        replacementRunId: String(p["replacementRunId"]),
        reason: String(p["reason"]),
        principalId:
          typeof p["principalId"] === "string" ? p["principalId"] : null,
        occurredAt: e.occurredAt,
      };
    })
    .sort((a, b) => a.targetObjectiveVersion - b.targetObjectiveVersion);
}

/** In-process per-key serialization for non-durable composers. */
export function createKeyedSerialLock(): <T>(
  key: string,
  fn: () => Promise<T>,
) => Promise<T> {
  const tails = new Map<string, Promise<unknown>>();
  return async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const prior = tails.get(key) ?? Promise.resolve();
    const run = prior.then(fn, fn);
    const tail = run.catch(() => undefined);
    tails.set(key, tail);
    try {
      return await run;
    } finally {
      if (tails.get(key) === tail) tails.delete(key);
    }
  };
}

function notEligible(
  reasonCode: string,
  message: string,
  details: Record<string, unknown> = {},
): RevenueRecoveryError {
  return new RevenueRecoveryError("OBJECTIVE_REISSUE_NOT_ELIGIBLE", message, {
    reasonCode,
    ...details,
  });
}

function contentFingerprint(content: {
  requestedOutcome: string;
  acceptanceCriteria: readonly string[];
  nonGoals: readonly string[];
  constraints: readonly string[];
  priority: Objective["priority"];
  deadline?: string | undefined;
}): string {
  return objectiveFingerprint({
    requestedOutcome: content.requestedOutcome,
    acceptanceCriteria: content.acceptanceCriteria,
    nonGoals: content.nonGoals,
    constraints: content.constraints,
    priority: content.priority,
    ...(content.deadline !== undefined ? { deadline: content.deadline } : {}),
  });
}

export class RevenueRecoveryObjectiveReissueService {
  constructor(private readonly deps: RecoveryObjectiveReissueDeps) {}

  async reissue(input: {
    recoveryCaseId: string;
    body: unknown;
    principalId?: string;
  }): Promise<RecoveryObjectiveReissueResult> {
    const parsed = ObjectiveReissueRequestSchema.safeParse(input.body);
    if (!parsed.success) {
      throw new RevenueRecoveryError(
        "OBJECTIVE_REISSUE_INVALID",
        "Objective reissue request is invalid",
        {
          fields: [
            ...new Set(
              parsed.error.issues.flatMap((i) =>
                i.code === "unrecognized_keys"
                  ? i.keys
                  : [i.path.join(".") || "(root)"],
              ),
            ),
          ].sort(),
        },
      );
    }
    const request = parsed.data;
    return this.deps.withReissueLock(input.recoveryCaseId, () =>
      this.reissueLocked(input.recoveryCaseId, request, input.principalId),
    );
  }

  private async reissueLocked(
    recoveryCaseId: string,
    request: ObjectiveReissueRequest,
    principalId: string | undefined,
  ): Promise<RecoveryObjectiveReissueResult> {
    const { orchestrator } = this.deps;
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
    if (recoveryCase.objectiveId && recoveryCase.objectiveId !== objectiveId) {
      throw notEligible(
        "CASE_OBJECTIVE_MISMATCH",
        "RecoveryCase objective identity is not canonical",
      );
    }
    const predecessorRunId = recoveryCase.orchestratorRunId;
    if (!predecessorRunId) {
      throw notEligible(
        "NO_CURRENT_RUN",
        "RecoveryCase has no current orchestrator run to replace",
      );
    }
    const sourceObjectiveVersion = recoveryCase.recoveryObjectiveVersion ?? 1;

    const replay = await this.findReissueInto(recoveryCase, sourceObjectiveVersion);
    if (replay) {
      if (replay.reason !== request.reason) {
        throw new RevenueRecoveryError(
          "OBJECTIVE_REISSUE_ALREADY_EXISTS",
          "The predecessor run was already replaced by a different reissue",
          {
            reissueId: replay.reissueId,
            replacementRunId: replay.replacementRunId,
          },
        );
      }
      const current = await orchestrator.runs.getById(replay.replacementRunId);
      return {
        outcome: "ALREADY_REISSUED",
        reissueId: replay.reissueId,
        recoveryCaseId: recoveryCase.recoveryCaseId,
        objectiveId: replay.objectiveId,
        sourceObjectiveVersion: replay.sourceObjectiveVersion,
        targetObjectiveVersion: replay.targetObjectiveVersion,
        predecessorRunId: replay.predecessorRunId,
        replacementRunId: replay.replacementRunId,
        replacementRunState: current?.state ?? null,
        reason: request.reason,
      };
    }

    if (recoveryCase.status !== "IN_ORCHESTRATION") {
      throw notEligible(
        "CASE_NOT_IN_ORCHESTRATION",
        "RecoveryCase is not in orchestration",
        { caseStatus: recoveryCase.status },
      );
    }

    const { run: predecessor, authorityState: predecessorAuthority } =
      await this.assertPredecessorEligible({
        recoveryCase,
        predecessorRunId,
        objectiveId,
        sourceObjectiveVersion,
      });

    const targetObjectiveVersion = sourceObjectiveVersion + 1;
    const reissueId = objectiveReissueId({
      recoveryCaseId: recoveryCase.recoveryCaseId,
      predecessorRunId,
      targetObjectiveVersion,
      reason: request.reason,
    });

    // The predecessor's requester is re-authorized by admission; the HTTP
    // principal is recorded in lineage but never becomes the requester.
    const canonical = await this.deps.buildCanonicalObjective({
      recoveryCase,
      requesterId: predecessor.requesterId,
      requestedEnvironment: predecessor.requestedEnvironment,
      objectiveVersion: targetObjectiveVersion,
    });
    const admissionRequest = canonical.admissionRequest;
    if (!canonical.contactPolicy.eligible) {
      throw notEligible(
        "CONTACT_POLICY_NOT_ELIGIBLE",
        "Contact policy permits no channel; the reissued objective would authorize nothing",
        { contactPolicyReasonCodes: [...canonical.contactPolicy.reasonCodes] },
      );
    }
    if (
      admissionRequest.objectiveId !== objectiveId ||
      admissionRequest.objectiveVersion !== targetObjectiveVersion ||
      admissionRequest.projectId !== recoveryCase.projectId
    ) {
      throw new RevenueRecoveryError(
        "OBJECTIVE_REISSUE_CONFLICT",
        "Canonical objective identity does not match the reissue target",
      );
    }
    const fingerprint = contentFingerprint(admissionRequest);

    // Objective rows are write-once: an existing target version with other
    // content would silently survive admission and bind to the new run.
    const existingTarget = await orchestrator.objectives.getById(
      objectiveId,
      targetObjectiveVersion,
    );
    if (existingTarget && contentFingerprint(existingTarget) !== fingerprint) {
      throw new RevenueRecoveryError(
        "OBJECTIVE_REISSUE_CONFLICT",
        "A different objective already holds the target version",
        { objectiveId, targetObjectiveVersion },
      );
    }

    const admitted = await this.deps.admission.admit(admissionRequest);
    const { replacementRunId, admissionOutcome } =
      await this.resolveReplacementRun({
        admitted,
        recoveryCase,
        predecessorRunId,
        objectiveId,
        targetObjectiveVersion,
        requestedEnvironment: predecessor.requestedEnvironment,
      });

    const bound = await orchestrator.objectives.getByRunBinding(replacementRunId);
    if (
      !bound ||
      bound.objectiveId !== objectiveId ||
      bound.objectiveVersion !== targetObjectiveVersion ||
      contentFingerprint(bound) !== fingerprint
    ) {
      throw new RevenueRecoveryError(
        "OBJECTIVE_REISSUE_CONFLICT",
        "Replacement run is not bound to the canonical reissued objective",
        { replacementRunId },
      );
    }

    const now = this.deps.nowIso();
    const rebound = await this.deps.cases.compareAndSetOrchestratorRunBinding({
      recoveryCaseId: recoveryCase.recoveryCaseId,
      expectedOrchestratorRunId: predecessorRunId,
      expectedObjectiveVersion: sourceObjectiveVersion,
      expectedRecordRevision: recoveryCase.recordRevision,
      orchestratorRunId: replacementRunId,
      objectiveId,
      objectiveVersion: targetObjectiveVersion,
      updatedAt: now,
    });
    if (!rebound) {
      throw new RevenueRecoveryError(
        "OBJECTIVE_REISSUE_BINDING_CHANGED",
        "RecoveryCase binding changed concurrently; nothing was rebound",
        { recoveryCaseId: recoveryCase.recoveryCaseId },
      );
    }

    await this.deps.audits.append({
      eventId: newAuditEventId({
        kind: "RECOVERY_OBJECTIVE_REISSUED",
        occurredAt: now,
        recoveryCaseId: recoveryCase.recoveryCaseId,
        subjectRef: reissueId,
      }),
      kind: "RECOVERY_OBJECTIVE_REISSUED",
      customerAccountId: recoveryCase.customerAccountId,
      projectId: recoveryCase.projectId,
      leadId: recoveryCase.leadId,
      recoveryCaseId: recoveryCase.recoveryCaseId,
      occurredAt: now,
      payload: {
        reissueId,
        recoveryCaseId: recoveryCase.recoveryCaseId,
        objectiveId,
        sourceObjectiveVersion,
        targetObjectiveVersion,
        predecessorRunId,
        predecessorRunState: predecessor.state,
        predecessorAuthority,
        replacementRunId,
        reason: request.reason,
        admissionOutcome,
        requesterId: predecessor.requesterId,
        principalId: principalId ?? null,
      },
    });

    const replacement = await orchestrator.runs.getById(replacementRunId);
    return {
      outcome: "REISSUED",
      reissueId,
      recoveryCaseId: recoveryCase.recoveryCaseId,
      objectiveId,
      sourceObjectiveVersion,
      targetObjectiveVersion,
      predecessorRunId,
      replacementRunId,
      replacementRunState: replacement?.state ?? null,
      reason: request.reason,
    };
  }

  private async findReissueInto(
    recoveryCase: RecoveryCase,
    currentVersion: number,
  ): Promise<RecoveryObjectiveLineageEntry | null> {
    const events = await this.deps.audits.listByCase(recoveryCase.recoveryCaseId);
    return (
      recoveryObjectiveLineage(events).find(
        (entry) =>
          entry.replacementRunId === recoveryCase.orchestratorRunId &&
          entry.targetObjectiveVersion === currentVersion,
      ) ?? null
    );
  }

  private async assertPredecessorEligible(input: {
    recoveryCase: RecoveryCase;
    predecessorRunId: string;
    objectiveId: string;
    sourceObjectiveVersion: number;
  }): Promise<{
    run: RunRecord;
    authorityState: "NONE" | "HISTORICAL_SUPERSEDED_APPROVE_ONLY";
  }> {
    const { orchestrator } = this.deps;
    const { predecessorRunId } = input;
    const run = await orchestrator.runs.getById(predecessorRunId);
    if (!run) {
      throw notEligible("PREDECESSOR_NOT_FOUND", "Predecessor run not found", {
        predecessorRunId,
      });
    }
    const objective = await orchestrator.objectives.getByRunBinding(
      predecessorRunId,
    );
    if (
      run.projectId !== input.recoveryCase.projectId ||
      run.objectiveId !== input.objectiveId ||
      run.objectiveVersion !== input.sourceObjectiveVersion ||
      !objective ||
      objective.objectiveId !== input.objectiveId ||
      objective.objectiveVersion !== input.sourceObjectiveVersion
    ) {
      throw notEligible(
        "PREDECESSOR_BINDING_INCONSISTENT",
        "Predecessor run does not hold the case's current objective version",
        { predecessorRunId },
      );
    }
    if (
      !(OBJECTIVE_REISSUE_PREDECESSOR_STATES as readonly string[]).includes(
        run.state,
      )
    ) {
      throw notEligible(
        "PREDECESSOR_NOT_TERMINAL_WITHOUT_AUTHORITY",
        `Predecessor run is ${run.state}; only ${OBJECTIVE_REISSUE_PREDECESSOR_STATES.join(" or ")} predecessors may be replaced`,
        { predecessorRunId, predecessorState: run.state },
      );
    }

    // A REJECT / REQUEST_MODIFICATION record is history, not authority; so is
    // an APPROVE bound only to a SUPERSEDED plan and followed by a later decision.
    const requests = await orchestrator.approvalRequests.listByRun(
      predecessorRunId,
    );
    const authority = assessHistoricalExecutionAuthority({
      runId: predecessorRunId,
      authorizationRecords: await orchestrator.authorizationRecords.listByRun(
        predecessorRunId,
      ),
      approvalRequests: requests,
      plans: await orchestrator.plans.listByRunId(predecessorRunId),
    });
    if (authority.kind === "CURRENT_APPROVE" || authority.kind === "AMBIGUOUS") {
      throw new RevenueRecoveryError(
        "OBJECTIVE_REISSUE_AUTHORITY_PRESENT",
        authority.kind === "CURRENT_APPROVE"
          ? "Predecessor run holds effective APPROVE authority"
          : "Predecessor run APPROVE history cannot be proven historical",
        {
          predecessorRunId,
          authorityState: authority.kind,
          reasonCode: authority.reasonCode,
        },
      );
    }
    if (requests.some((r) => r.status === "PENDING")) {
      throw notEligible(
        "PREDECESSOR_APPROVAL_PENDING",
        "Predecessor run still has a PENDING ApprovalRequest",
        { predecessorRunId },
      );
    }
    const executionAttempts = await orchestrator.executionAttempts.listByRun(
      predecessorRunId,
    );
    if (executionAttempts.length > 0) {
      throw new RevenueRecoveryError(
        "OBJECTIVE_REISSUE_AUTHORITY_PRESENT",
        "Predecessor run has execution attempts",
        { predecessorRunId },
      );
    }
    const attempts = await this.deps.attempts.listByCase(
      input.recoveryCase.recoveryCaseId,
    );
    if (attempts.some((a) => a.runId === predecessorRunId)) {
      throw new RevenueRecoveryError(
        "OBJECTIVE_REISSUE_AUTHORITY_PRESENT",
        "Predecessor run has recovery attempts",
        { predecessorRunId },
      );
    }
    return { run, authorityState: authority.kind };
  }

  /**
   * ADMITTED → fresh replacement. A duplicate is adopted only when it is the
   * same canonical objective on an untouched ADMITTED run (a prior attempt
   * admitted it but never bound the case); anything else fails closed.
   */
  private async resolveReplacementRun(input: {
    admitted: AdmissionResult;
    recoveryCase: RecoveryCase;
    predecessorRunId: string;
    objectiveId: string;
    targetObjectiveVersion: number;
    requestedEnvironment: string;
  }): Promise<{
    replacementRunId: string;
    admissionOutcome: "ADMITTED" | "CONVERGED_DUPLICATE";
  }> {
    const { admitted } = input;
    if (admitted.outcome === "REJECTED") {
      throw notEligible(
        "ADMISSION_REJECTED",
        "Phase 2 admission rejected the reissued objective",
        { admissionReasonCode: admitted.reasonCode },
      );
    }
    if (admitted.outcome === "CONFLICT") {
      throw new RevenueRecoveryError(
        "OBJECTIVE_REISSUE_CONFLICT",
        "Phase 2 admission refused the reissued objective",
        { admissionReasonCode: admitted.reasonCode },
      );
    }
    if (admitted.runId === input.predecessorRunId) {
      throw new RevenueRecoveryError(
        "OBJECTIVE_REISSUE_CONFLICT",
        "Admission resolved to the predecessor run",
      );
    }
    if (admitted.outcome === "ADMITTED") {
      return { replacementRunId: admitted.runId, admissionOutcome: "ADMITTED" };
    }

    const { orchestrator } = this.deps;
    const runId = admitted.runId;
    const run = await orchestrator.runs.getById(runId);
    const untouched =
      run !== null &&
      run.state === "ADMITTED" &&
      run.projectId === input.recoveryCase.projectId &&
      run.objectiveId === input.objectiveId &&
      run.objectiveVersion === input.targetObjectiveVersion &&
      run.requestedEnvironment === input.requestedEnvironment &&
      (await orchestrator.plans.listByRunId(runId)).length === 0 &&
      (await orchestrator.approvalRequests.listByRun(runId)).length === 0 &&
      (await orchestrator.authorizationRecords.listByRun(runId)).length === 0 &&
      (await orchestrator.executionAttempts.listByRun(runId)).length === 0 &&
      (await this.deps.cases.getByOrchestratorRunId(runId)) === null;
    if (!untouched) {
      throw new RevenueRecoveryError(
        "OBJECTIVE_REISSUE_CONFLICT",
        "The target objective version is already held by a run this reissue cannot adopt",
        { admissionOutcome: admitted.outcome },
      );
    }
    return { replacementRunId: runId, admissionOutcome: "CONVERGED_DUPLICATE" };
  }
}
