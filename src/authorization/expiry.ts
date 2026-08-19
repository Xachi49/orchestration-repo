import type { ClockPort } from "../infrastructure/clock.js";
import { commitRunTransition } from "../admission/run-transition.js";
import type { RunRepository } from "../admission/run-repository.js";
import { assertTransition } from "../domain/run/run-state.js";
import type { ApprovalRequest } from "../domain/authorization/index.js";
import type { ApprovalRequestRepository } from "./approval-request-repository.js";
import type { AuthorizationCoordinator } from "./coordinator.js";
import { isExpired } from "./identity.js";
import type { AuthorizationResult } from "./result.js";

export interface ApprovalExpiryServiceDeps {
  requests: ApprovalRequestRepository;
  runs: RunRepository;
  coordinator: AuthorizationCoordinator;
  clock: ClockPort;
}

/**
 * Deterministic expiry of PENDING approval requests.
 * No background scheduler in Phase 6 — call expireDueRequests(now) explicitly.
 * Expired approvals cannot be revived; a new request needs a new id.
 */
export class ApprovalExpiryService {
  constructor(private readonly deps: ApprovalExpiryServiceDeps) {}

  async expireDueRequests(nowIso?: string): Promise<{
    expiredRequests: readonly ApprovalRequest[];
    results: readonly AuthorizationResult[];
  }> {
    const now = nowIso ?? this.deps.clock.nowIso();
    // Scan all known requests via runs is awkward; repository has no listAll.
    // Expose expire on known pending by scanning through a helper on the
    // in-memory repo when available; otherwise require runIds.
    const memory = this.deps.requests as ApprovalRequestRepository & {
      listAll?: () => Promise<readonly ApprovalRequest[]>;
    };
    const all =
      typeof memory.listAll === "function"
        ? await memory.listAll()
        : await this.collectViaRuns();

    const expiredRequests: ApprovalRequest[] = [];
    const results: AuthorizationResult[] = [];

    for (const request of all) {
      if (request.status !== "PENDING") {
        continue;
      }
      if (!isExpired(request.expiresAt, now)) {
        continue;
      }
      const updated = await this.deps.requests.updateStatus(
        request.approvalRequestId,
        "EXPIRED",
        { failureReasonCode: "APPROVAL_REQUEST_EXPIRED" },
      );
      await this.deps.coordinator.invalidateNonce(request.approvalRequestId);
      expiredRequests.push(updated);

      const run = await this.deps.runs.getById(request.runId);
      let runState = run?.state ?? "EXPIRED";
      if (run && run.state === "AWAITING_APPROVAL") {
        const next = assertTransition(run.state, "EXPIRED");
        await commitRunTransition(this.deps.runs, run, next, now);
        runState = next;
      }
      results.push({
        runId: request.runId,
        approvalRequestId: request.approvalRequestId,
        planId: request.planId,
        planVersion: request.planVersion,
        planHash: request.planHash,
        result: "EXPIRED",
        requiresFurtherAction: true,
        runState,
      });
    }

    return { expiredRequests, results };
  }

  private async collectViaRuns(): Promise<readonly ApprovalRequest[]> {
    // Without listAll, expire is a no-op unless callers use InMemory with listAll.
    return [];
  }
}
