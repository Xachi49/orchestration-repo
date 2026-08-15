import type { ControlPlaneService } from "../control-plane/service.js";
import type { ApprovalRequest } from "../domain/authorization/index.js";

export type ApproverAuthorizationOutcome =
  | { outcome: "AUTHORIZED" }
  | {
      outcome:
        | "UNKNOWN_APPROVER"
        | "APPROVER_NOT_ALLOWED"
        | "PROJECT_ACCESS_DENIED";
    };

export interface ApproverAuthorizationQuery {
  approverId: string;
  projectId: string;
  requestedEnvironment: string;
  approvalRequest: ApprovalRequest;
}

export interface ApproverAuthorizationService {
  authorize(
    query: ApproverAuthorizationQuery,
  ): Promise<ApproverAuthorizationOutcome>;
}

/**
 * Deterministic approver check against project.authorizedApproverIds.
 * No OAuth/IdP. Unknown approver fails closed.
 * Requester identity is not automatically an approver.
 */
export class InMemoryApproverAuthorizationService
  implements ApproverAuthorizationService
{
  constructor(
    private readonly controlPlane: ControlPlaneService,
    private readonly knownApproverIds: ReadonlySet<string>,
  ) {}

  async authorize(
    query: ApproverAuthorizationQuery,
  ): Promise<ApproverAuthorizationOutcome> {
    if (!this.knownApproverIds.has(query.approverId)) {
      return { outcome: "UNKNOWN_APPROVER" };
    }

    let resolved;
    try {
      resolved = await this.controlPlane.resolve(
        query.projectId,
        query.requestedEnvironment,
      );
    } catch {
      return { outcome: "PROJECT_ACCESS_DENIED" };
    }

    if (resolved.project.projectId !== query.approvalRequest.projectId) {
      return { outcome: "PROJECT_ACCESS_DENIED" };
    }

    if (
      !resolved.project.authorizedApproverIds.includes(query.approverId)
    ) {
      return { outcome: "APPROVER_NOT_ALLOWED" };
    }

    if (
      query.approvalRequest.requestedApproverIds.length > 0 &&
      !query.approvalRequest.requestedApproverIds.includes(query.approverId)
    ) {
      return { outcome: "APPROVER_NOT_ALLOWED" };
    }

    return { outcome: "AUTHORIZED" };
  }
}
