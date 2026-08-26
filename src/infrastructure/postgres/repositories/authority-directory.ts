import { randomUUID } from "node:crypto";
import type {
  AuthorizationDecision,
  AuthorizationQuery,
  RequesterAuthorizationService,
  RequesterGrant,
} from "../../../admission/authorization.js";
import type { ControlPlaneService } from "../../../control-plane/service.js";
import type { ApprovalRequest } from "../../../domain/authorization/index.js";
import type {
  ApproverAuthorizationOutcome,
  ApproverAuthorizationQuery,
  ApproverAuthorizationService,
} from "../../../authorization/approver-authorization.js";
import type { PostgresDatabase } from "../database.js";

export interface AuthorityGrantSeed {
  principalId: string;
  principalType:
    | "REQUESTER"
    | "APPROVER"
    | "PROGRAM_MATERIALIZER"
    | "PORTFOLIO_ALLOCATOR"
    | "STRATEGY_SELECTOR";
  projectId: string;
  environments: readonly string[];
}

export class PostgresAuthorityDirectory {
  constructor(private readonly db: PostgresDatabase) {}

  async seed(grants: readonly AuthorityGrantSeed[]): Promise<void> {
    for (const grant of grants) {
      await this.db.query(
        `INSERT INTO authority_grants (
           grant_id, principal_id, principal_type, project_id,
           authorized_environments, enabled, authority_version
         ) VALUES ($1, $2, $3, $4, $5::jsonb, TRUE, '1')
         ON CONFLICT (principal_id, principal_type, project_id) DO UPDATE
           SET authorized_environments = EXCLUDED.authorized_environments,
               enabled = TRUE,
               updated_at = NOW()`,
        [
          randomUUID(),
          grant.principalId,
          grant.principalType,
          grant.projectId,
          JSON.stringify([...grant.environments]),
        ],
      );
    }
  }

  async listRequesterGrants(
    requesterId: string,
    projectId: string,
  ): Promise<readonly string[]> {
    const result = await this.db.query<{
      authorized_environments: string[];
    }>(
      `SELECT authorized_environments
       FROM authority_grants
       WHERE principal_id = $1
         AND principal_type = 'REQUESTER'
         AND project_id = $2
         AND enabled = TRUE`,
      [requesterId, projectId],
    );
    const row = result.rows[0];
    return row?.authorized_environments ?? [];
  }

  async isProgramMaterializerEnabled(
    principalId: string,
    projectId: string,
  ): Promise<boolean> {
    const result = await this.db.query<{ ok: number }>(
      `SELECT 1 AS ok
       FROM authority_grants
       WHERE principal_id = $1
         AND principal_type = 'PROGRAM_MATERIALIZER'
         AND project_id = $2
         AND enabled = TRUE`,
      [principalId, projectId],
    );
    return result.rows.length > 0;
  }

  async isPortfolioAllocatorEnabled(
    principalId: string,
    projectId: string,
  ): Promise<boolean> {
    const result = await this.db.query<{ ok: number }>(
      `SELECT 1 AS ok
       FROM authority_grants
       WHERE principal_id = $1
         AND principal_type = 'PORTFOLIO_ALLOCATOR'
         AND project_id = $2
         AND enabled = TRUE`,
      [principalId, projectId],
    );
    return result.rows.length > 0;
  }

  async isStrategySelectorEnabled(
    principalId: string,
    projectId: string,
  ): Promise<boolean> {
    const result = await this.db.query<{ ok: number }>(
      `SELECT 1 AS ok
       FROM authority_grants
       WHERE principal_id = $1
         AND principal_type = 'STRATEGY_SELECTOR'
         AND project_id = $2
         AND enabled = TRUE`,
      [principalId, projectId],
    );
    return result.rows.length > 0;
  }

  /**
   * Fail-closed intersection: principal must hold an explicit
   * STRATEGY_SELECTOR grant for EVERY project in scope.
   */
  async isStrategySelectorForAllProjects(
    principalId: string,
    projectIds: readonly string[],
  ): Promise<boolean> {
    const unique = [...new Set(projectIds.filter((id) => id.length > 0))];
    if (unique.length === 0) {
      return false;
    }
    for (const projectId of unique) {
      if (!(await this.isStrategySelectorEnabled(principalId, projectId))) {
        return false;
      }
    }
    return true;
  }

  /**
   * Fail-closed intersection: principal must hold an explicit
   * PORTFOLIO_ALLOCATOR grant for EVERY project in scope.
   * One-project grants never imply cross-project allocator authority.
   */
  async isPortfolioAllocatorForAllProjects(
    principalId: string,
    projectIds: readonly string[],
  ): Promise<boolean> {
    const unique = [...new Set(projectIds.filter((id) => id.length > 0))];
    if (unique.length === 0) {
      return false;
    }
    for (const projectId of unique) {
      if (!(await this.isPortfolioAllocatorEnabled(principalId, projectId))) {
        return false;
      }
    }
    return true;
  }

  async isApproverEnabled(
    approverId: string,
    projectId: string,
  ): Promise<boolean> {
    const result = await this.db.query<{ ok: number }>(
      `SELECT 1 AS ok
       FROM authority_grants
       WHERE principal_id = $1
         AND principal_type = 'APPROVER'
         AND project_id = $2
         AND enabled = TRUE`,
      [approverId, projectId],
    );
    return result.rows.length > 0;
  }

  async hasAnyRequesterGrant(requesterId: string): Promise<boolean> {
    const result = await this.db.query<{ ok: number }>(
      `SELECT 1 AS ok FROM authority_grants
       WHERE principal_id = $1 AND principal_type = 'REQUESTER' AND enabled = TRUE
       LIMIT 1`,
      [requesterId],
    );
    return result.rows.length > 0;
  }
}

export class PostgresRequesterAuthorization
  implements RequesterAuthorizationService
{
  constructor(private readonly directory: PostgresAuthorityDirectory) {}

  async authorize(query: AuthorizationQuery): Promise<AuthorizationDecision> {
    if (
      query.requesterId.trim() === "" ||
      query.projectId.trim() === "" ||
      query.requestedEnvironment.trim() === ""
    ) {
      return { decision: "UNAUTHORIZED" };
    }

    const known = await this.hasAnyRequesterGrant(query.requesterId);
    if (!known) {
      return { decision: "UNKNOWN_REQUESTER" };
    }

    const environments = await this.directory.listRequesterGrants(
      query.requesterId,
      query.projectId,
    );
    if (environments.length === 0) {
      return { decision: "PROJECT_ACCESS_DENIED" };
    }

    if (!environments.includes(query.requestedEnvironment)) {
      return { decision: "ENVIRONMENT_ACCESS_DENIED" };
    }
    return { decision: "AUTHORIZED" };
  }

  private async hasAnyRequesterGrant(requesterId: string): Promise<boolean> {
    const result = await this.directory.hasAnyRequesterGrant(requesterId);
    return result;
  }
}

export class PostgresApproverAuthorizationService
  implements ApproverAuthorizationService
{
  constructor(
    private readonly controlPlane: ControlPlaneService,
    private readonly directory: PostgresAuthorityDirectory,
  ) {}

  async authorize(
    query: ApproverAuthorizationQuery,
  ): Promise<ApproverAuthorizationOutcome> {
    const enabled = await this.directory.isApproverEnabled(
      query.approverId,
      query.projectId,
    );
    if (!enabled) {
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

export function buildAuthoritySeeds(input: {
  requesterGrants: readonly RequesterGrant[];
  approverIds: readonly string[];
  projectId: string;
  environments: readonly string[];
  portfolioAllocatorGrants?: readonly {
    principalId: string;
    projectId?: string;
    environments?: readonly string[];
  }[];
  strategySelectorGrants?: readonly {
    principalId: string;
    projectId?: string;
    environments?: readonly string[];
  }[];
}): AuthorityGrantSeed[] {
  const seeds: AuthorityGrantSeed[] = input.requesterGrants
    .filter((grant) => grant.projectId === input.projectId)
    .map((grant) => ({
      principalId: grant.requesterId,
      principalType: "REQUESTER" as const,
      projectId: grant.projectId,
      environments: grant.environments,
    }));
  for (const approverId of input.approverIds) {
    seeds.push({
      principalId: approverId,
      principalType: "APPROVER",
      projectId: input.projectId,
      environments: input.environments,
    });
    // Distinct durable role: must be granted explicitly (seeded alongside
    // for bootstrap fixtures; production may separate the principals).
    seeds.push({
      principalId: approverId,
      principalType: "PROGRAM_MATERIALIZER",
      projectId: input.projectId,
      environments: input.environments,
    });
  }
  const allocatorGrants: readonly {
    principalId: string;
    projectId?: string;
    environments?: readonly string[];
  }[] =
    input.portfolioAllocatorGrants ??
    input.approverIds.map((principalId) => ({ principalId }));
  for (const grant of allocatorGrants) {
    seeds.push({
      principalId: grant.principalId,
      principalType: "PORTFOLIO_ALLOCATOR",
      projectId: grant.projectId ?? input.projectId,
      environments: grant.environments ?? input.environments,
    });
  }
  const selectorGrants: readonly {
    principalId: string;
    projectId?: string;
    environments?: readonly string[];
  }[] =
    input.strategySelectorGrants ??
    input.approverIds.map((principalId) => ({ principalId }));
  for (const grant of selectorGrants) {
    seeds.push({
      principalId: grant.principalId,
      principalType: "STRATEGY_SELECTOR",
      projectId: grant.projectId ?? input.projectId,
      environments: grant.environments ?? input.environments,
    });
  }
  return seeds;
}
