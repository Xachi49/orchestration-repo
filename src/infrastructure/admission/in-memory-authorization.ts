import type {
  AuthorizationDecision,
  AuthorizationQuery,
  RequesterAuthorizationService,
  RequesterGrant,
} from "../../admission/authorization.js";

export class InMemoryRequesterAuthorization
  implements RequesterAuthorizationService
{
  private readonly grants: readonly RequesterGrant[];

  constructor(grants: readonly RequesterGrant[] = []) {
    this.grants = grants.map((grant) => Object.freeze({ ...grant }));
  }

  async authorize(query: AuthorizationQuery): Promise<AuthorizationDecision> {
    if (
      query.requesterId.trim() === "" ||
      query.projectId.trim() === "" ||
      query.requestedEnvironment.trim() === ""
    ) {
      return { decision: "UNAUTHORIZED" };
    }

    const requesterGrants = this.grants.filter(
      (grant) => grant.requesterId === query.requesterId,
    );
    if (requesterGrants.length === 0) {
      return { decision: "UNKNOWN_REQUESTER" };
    }

    const projectGrants = requesterGrants.filter(
      (grant) => grant.projectId === query.projectId,
    );
    if (projectGrants.length === 0) {
      return { decision: "PROJECT_ACCESS_DENIED" };
    }

    const allowed = projectGrants.some((grant) =>
      grant.environments.includes(query.requestedEnvironment),
    );
    if (!allowed) {
      return { decision: "ENVIRONMENT_ACCESS_DENIED" };
    }

    return { decision: "AUTHORIZED" };
  }
}
