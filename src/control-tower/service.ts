import type { RunRecord, RunRepository } from "../admission/run-repository.js";
import type { RunState } from "../domain/run/run-state.js";
import type { ApprovalRequestRepository } from "../authorization/approval-request-repository.js";
import type { DecisionCardStore } from "../authorization/decision-card-store.js";
import type { FakeApprovalDeliveryService } from "../authorization/delivery.js";
import type { HumanAuthorizationService } from "../authorization/service.js";
import type { PlanningService } from "../planning/service.js";
import type { ValidationService } from "../validation/service.js";
import type { RepositoryTruthService } from "../ingestion/service.js";
import type { ExecutionService } from "../execution/service.js";
import type { OutcomeVerificationService } from "../verification/service.js";
import type { AssuranceOrchestrationService } from "../assurance/service.js";
import type { QualificationOrchestrationService } from "../qualification/service.js";
import type { ObjectiveRepository } from "../admission/objective-repository.js";
import { sanitizeApprovalRequest, sanitizeNestedValue } from "./sanitizers.js";
import { deriveRunTimeline } from "./timeline.js";
import {
  ControlTowerDashboardSchema,
  type ControlTowerDashboard,
  type RunDetailReadModel,
} from "./read-model.js";
import {
  filterByViewerProjects,
  viewerMayAccessProject,
  type ControlTowerViewer,
} from "./access-scope.js";

export type ControlTowerRunQuery = RunRepository & {
  listRecent?(limit: number): Promise<readonly RunRecord[]>;
  listByStates?(
    states: readonly RunState[],
    limit: number,
  ): Promise<readonly RunRecord[]>;
};

export interface ControlTowerServiceDeps {
  runs: ControlTowerRunQuery;
  objectives?: ObjectiveRepository;
  approvalRequests?: ApprovalRequestRepository;
  decisionCards?: DecisionCardStore;
  humanAuthorization?: HumanAuthorizationService;
  /** TEST/local delivery only — never a production secret channel. */
  fakeDelivery?: FakeApprovalDeliveryService;
  planning?: PlanningService;
  validation?: ValidationService;
  ingestion?: RepositoryTruthService;
  execution?: ExecutionService;
  verification?: OutcomeVerificationService;
  assuranceService?: AssuranceOrchestrationService;
  qualificationService?: QualificationOrchestrationService;
  /** Development default project only — not the sole production project. */
  defaultProjectId?: string;
}

const ACTIVE: readonly RunState[] = [
  "RECEIVED",
  "ADMITTED",
  "INGESTING",
  "PLANNING",
  "VALIDATING",
  "AWAITING_APPROVAL",
  "APPROVED",
  "EXECUTING",
  "VERIFYING",
  "REVISING",
];

const BLOCKED_FAILED: readonly RunState[] = [
  "BLOCKED",
  "FAILED",
  "REJECTED",
  "ADMISSION_REJECTED",
  "ESCALATED",
  "CONTAINED",
  "ROLLBACK_REQUIRED",
  "EXPIRED",
  "CANCELLED",
];

/**
 * Read-model composition for the Control Tower product surface.
 * CONTROL TOWER != AUTHORITY — this service never mutates domain state.
 */
export class ControlTowerService {
  constructor(private readonly deps: ControlTowerServiceDeps) {}

  async getDashboard(
    viewer: ControlTowerViewer,
    limit = 20,
  ): Promise<ControlTowerDashboard> {
    const recent = filterByViewerProjects(
      viewer,
      await this.listRecentRuns(viewer, Math.max(limit, 50)),
    );
    const counts = {
      active: recent.filter((r) => ACTIVE.includes(r.state)).length,
      awaitingApproval: recent.filter((r) => r.state === "AWAITING_APPROVAL")
        .length,
      executing: recent.filter((r) => r.state === "EXECUTING").length,
      verifying: recent.filter((r) => r.state === "VERIFYING").length,
      completed: recent.filter((r) => r.state === "COMPLETED").length,
      blockedOrFailed: recent.filter((r) => BLOCKED_FAILED.includes(r.state))
        .length,
    };

    const recentApprovals = [];
    if (this.deps.approvalRequests?.listAll) {
      const all = await this.deps.approvalRequests.listAll();
      const pending = filterByViewerProjects(
        viewer,
        all.filter((a) => a.status === "PENDING"),
      )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit);
      for (const a of pending) {
        recentApprovals.push({
          approvalRequestId: a.approvalRequestId,
          runId: a.runId,
          projectId: a.projectId,
          objectiveId: a.objectiveId,
          status: a.status,
          expiresAt: a.expiresAt,
          validationDecision: a.validationDecision,
        });
      }
    } else {
      for (const run of recent.filter((r) => r.state === "AWAITING_APPROVAL")) {
        const pending = await this.deps.humanAuthorization?.getPendingRequest(
          run.runId,
        );
        if (pending && viewerMayAccessProject(viewer, pending.projectId)) {
          recentApprovals.push({
            approvalRequestId: pending.approvalRequestId,
            runId: pending.runId,
            projectId: pending.projectId,
            objectiveId: pending.objectiveId,
            status: pending.status,
            expiresAt: pending.expiresAt,
            validationDecision: pending.validationDecision,
          });
        }
      }
    }

    const recentCompletions = [];
    for (const run of recent.filter((r) => r.state === "COMPLETED").slice(0, limit)) {
      const completion = this.deps.verification
        ? await this.deps.verification.getCompletion(run.runId)
        : null;
      if (completion) {
        recentCompletions.push({
          runId: run.runId,
          projectId: run.projectId,
          completedAt: completion.completedAt,
        });
      }
    }

    return ControlTowerDashboardSchema.parse({
      counts,
      recentRuns: recent.slice(0, limit),
      recentApprovals: recentApprovals.slice(0, limit),
      recentCompletions,
      doctrine: {
        controlTowerNotAuthority: "CONTROL TOWER != AUTHORITY",
        liveNotReady: "LIVE != READY",
      },
    });
  }

  async listRuns(
    viewer: ControlTowerViewer,
    input?: {
      projectId?: string;
      limit?: number;
    },
  ): Promise<readonly RunRecord[]> {
    const limit = input?.limit ?? 50;
    if (input?.projectId) {
      if (!viewerMayAccessProject(viewer, input.projectId)) {
        return [];
      }
      const rows = await this.deps.runs.listByProject(input.projectId);
      return [...rows]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, limit);
    }
    return filterByViewerProjects(
      viewer,
      await this.listRecentRuns(viewer, limit),
    ).slice(0, limit);
  }

  async getRunDetail(
    viewer: ControlTowerViewer,
    runId: string,
  ): Promise<RunDetailReadModel | null | "FORBIDDEN"> {
    const run = await this.deps.runs.getById(runId);
    if (!run) return null;
    if (!viewerMayAccessProject(viewer, run.projectId)) {
      return "FORBIDDEN";
    }

    const [
      objective,
      repositoryContext,
      plan,
      validation,
      approvalRaw,
      authorization,
      execution,
      verification,
      completion,
    ] = await Promise.all([
      this.deps.objectives?.getById(run.objectiveId, run.objectiveVersion) ??
        Promise.resolve(null),
      this.deps.ingestion?.getContext(runId) ?? Promise.resolve(null),
      this.deps.planning?.getPlan(runId) ?? Promise.resolve(null),
      this.deps.validation?.getLatestDecision(runId) ?? Promise.resolve(null),
      this.deps.humanAuthorization?.getPendingRequest(runId) ??
        Promise.resolve(null),
      this.deps.humanAuthorization?.getLatestAuthorization(runId) ??
        Promise.resolve(null),
      this.deps.execution?.getLatestAttempt(runId) ?? Promise.resolve(null),
      this.deps.verification?.getLatestResult(runId) ?? Promise.resolve(null),
      this.deps.verification?.getCompletion(runId) ?? Promise.resolve(null),
    ]);

    const timeline = deriveRunTimeline({
      state: run.state,
      hasCompletion: Boolean(completion),
    });

    return {
      run,
      timeline,
      objective: sanitizeNestedValue(objective),
      repositoryContext: sanitizeNestedValue(repositoryContext),
      plan: sanitizeNestedValue(plan),
      validation: sanitizeNestedValue(validation),
      approvalRequest: approvalRaw
        ? sanitizeApprovalRequest(approvalRaw)
        : null,
      authorization: sanitizeNestedValue(authorization),
      execution: sanitizeNestedValue(execution),
      verification: sanitizeNestedValue(verification),
      completion: sanitizeNestedValue(completion),
      doctrine: {
        passNotApproved: "PASS != APPROVED",
        executionSucceededNotVerified:
          "EXECUTION_SUCCEEDED != VERIFIED_SUCCESS",
        verifiedSuccessNotCompleted: "VERIFIED_SUCCESS != COMPLETED",
      },
    };
  }

  async listPendingApprovals(viewer: ControlTowerViewer, limit = 50) {
    if (this.deps.approvalRequests?.listAll) {
      const all = await this.deps.approvalRequests.listAll();
      return filterByViewerProjects(
        viewer,
        all.filter((a) => a.status === "PENDING"),
      )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit)
        .map(sanitizeApprovalRequest);
    }
    const awaiting = await this.listRecentRuns(viewer, 200);
    const out = [];
    for (const run of awaiting.filter((r) => r.state === "AWAITING_APPROVAL")) {
      const pending = await this.deps.humanAuthorization?.getPendingRequest(
        run.runId,
      );
      if (pending && viewerMayAccessProject(viewer, pending.projectId)) {
        out.push(sanitizeApprovalRequest(pending));
      }
    }
    return out.slice(0, limit);
  }

  async getApprovalDetail(
    viewer: ControlTowerViewer,
    approvalRequestId: string,
  ) {
    const request =
      (await this.deps.approvalRequests?.getById(approvalRequestId)) ?? null;
    if (!request) return null;
    if (!viewerMayAccessProject(viewer, request.projectId)) {
      return "FORBIDDEN" as const;
    }
    const card =
      (await this.deps.decisionCards?.get(approvalRequestId)) ?? null;
    const run = await this.deps.runs.getById(request.runId);
    return {
      request: sanitizeApprovalRequest(request),
      decisionCard: sanitizeNestedValue(card),
      run,
      doctrine: {
        passNotApproved: "PASS != APPROVED" as const,
        controlTowerNotAuthority: "CONTROL TOWER != AUTHORITY" as const,
      },
    };
  }

  /**
   * Local/test delivery channel only. Production composition must not call this.
   * Never exposes decisionNonceHash.
   */
  getLocalDeliveryNonce(approvalRequestId: string): string | null {
    return this.deps.fakeDelivery?.nonceFor(approvalRequestId) ?? null;
  }

  async getAssuranceSnapshot() {
    return {
      available: Boolean(this.deps.assuranceService),
      doctrine: {
        certificateNotOperationalAuthority:
          "CERTIFICATE != OPERATIONAL AUTHORITY" as const,
      },
      note: this.deps.assuranceService
        ? "Use GET /v1/assurance/runs/:runId and certificate routes for detail"
        : "Assurance service not mounted in this runtime",
    };
  }

  async getQualificationSnapshot() {
    return {
      available: Boolean(this.deps.qualificationService),
      doctrine: {
        qualifiedNotDeployed: "QUALIFIED_FOR_RELEASE != DEPLOYED" as const,
        deploymentNotInScope: "DEPLOYMENT != IN SCOPE" as const,
      },
      note: this.deps.qualificationService
        ? "Qualification records are available via the qualification service"
        : "Qualification service not mounted on HTTP yet — doctrine preserved",
    };
  }

  private async listRecentRuns(
    viewer: ControlTowerViewer,
    limit: number,
  ): Promise<readonly RunRecord[]> {
    if (!viewer.unrestricted) {
      if (viewer.allowedProjectIds.length === 0) {
        return [];
      }
      const collected: RunRecord[] = [];
      for (const projectId of viewer.allowedProjectIds) {
        const rows = await this.deps.runs.listByProject(projectId);
        collected.push(...rows);
      }
      return collected
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, limit);
    }
    // Explicit DEVELOPMENT/TEST allow-all fixture only.
    if (this.deps.runs.listRecent) {
      return this.deps.runs.listRecent(limit);
    }
    if (this.deps.defaultProjectId) {
      const rows = await this.deps.runs.listByProject(
        this.deps.defaultProjectId,
      );
      return [...rows]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, limit);
    }
    if (this.deps.runs.listByStates) {
      const states: RunState[] = [
        ...ACTIVE,
        "COMPLETED",
        ...BLOCKED_FAILED,
      ];
      return this.deps.runs.listByStates(states, limit);
    }
    return [];
  }
}
