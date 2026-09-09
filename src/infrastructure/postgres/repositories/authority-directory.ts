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
    | "STRATEGY_SELECTOR"
    | "EXPERIMENT_SPONSOR"
    | "CAUSAL_REVIEWER"
    | "DECISION_POLICY_APPROVER"
    | "DECISION_POLICY_ACTIVATOR"
    | "GOVERNANCE_ADMIN"
    | "GOVERNANCE_HOLD_OPERATOR"
    | "RISK_REVIEWER"
    | "SECURITY_REVIEWER"
    | "CONSTITUTIONAL_REVIEWER"
    | "CONSTITUTIONAL_ACTIVATOR"
    | "FEDERATION_NEGOTIATOR"
    | "FEDERATION_RATIFIER"
    | "FEDERATION_WORK_ACCEPTOR"
    | "FEDERATION_EVIDENCE_SHARER"
    | "ASSURANCE_OPERATOR"
    | "ASSURANCE_CERTIFIER";
  projectId: string;
  environments: readonly string[];
}

export class PostgresAuthorityDirectory {
  constructor(private readonly db: PostgresDatabase) {}

  /**
   * Test/bootstrap seed only — not a production regrant API.
   *
   * Retry of the same bootstrap material reuses the current unrevoked grant.
   * After authority_revocations overlay on that grant, a later seed inserts a
   * distinct grant_id. Never mutates historical grant rows; never resurrects
   * a revoked grant by ON CONFLICT UPDATE.
   */
  async seed(grants: readonly AuthorityGrantSeed[]): Promise<void> {
    for (const grant of grants) {
      const current = await this.findCurrentUnrevokedGrant(
        grant.principalId,
        grant.principalType,
        grant.projectId,
      );
      if (current) {
        continue;
      }
      await this.db.query(
        `INSERT INTO authority_grants (
           grant_id, principal_id, principal_type, project_id,
           authorized_environments, enabled, authority_version
         ) VALUES ($1, $2, $3, $4, $5::jsonb, TRUE, '1')`,
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

  private async findCurrentUnrevokedGrant(
    principalId: string,
    principalType: string,
    projectId: string,
  ): Promise<boolean> {
    const result = await this.db.query<{ grant_id: string }>(
      `SELECT g.grant_id
       FROM authority_grants g
       WHERE g.principal_id = $1
         AND g.principal_type = $2
         AND g.project_id = $3
         AND g.enabled = TRUE
         AND NOT EXISTS (
           SELECT 1 FROM authority_revocations r
           WHERE r.target_type = 'DIRECT_GRANT'
             AND r.target_id = g.grant_id
             AND r.effective_at <= NOW()
         )
       LIMIT 1`,
      [principalId, principalType, projectId],
    );
    return result.rows.length > 0;
  }

  private async hasUnrevokedGrant(
    principalId: string,
    principalType: string,
    projectId: string,
  ): Promise<boolean> {
    return this.findCurrentUnrevokedGrant(
      principalId,
      principalType,
      projectId,
    );
  }

  async listRequesterGrants(
    requesterId: string,
    projectId: string,
  ): Promise<readonly string[]> {
    const result = await this.db.query<{
      authorized_environments: string[];
    }>(
      `SELECT g.authorized_environments
       FROM authority_grants g
       WHERE g.principal_id = $1
         AND g.principal_type = 'REQUESTER'
         AND g.project_id = $2
         AND g.enabled = TRUE
         AND NOT EXISTS (
           SELECT 1 FROM authority_revocations r
           WHERE r.target_type = 'DIRECT_GRANT'
             AND r.target_id = g.grant_id
             AND r.effective_at <= NOW()
         )
       ORDER BY g.created_at ASC, g.grant_id ASC`,
      [requesterId, projectId],
    );
    const envs = new Set<string>();
    for (const row of result.rows) {
      for (const env of row.authorized_environments) {
        envs.add(env);
      }
    }
    return [...envs].sort();
  }

  async isProgramMaterializerEnabled(
    principalId: string,
    projectId: string,
  ): Promise<boolean> {
    return this.hasUnrevokedGrant(
      principalId,
      "PROGRAM_MATERIALIZER",
      projectId,
    );
  }

  async isPortfolioAllocatorEnabled(
    principalId: string,
    projectId: string,
  ): Promise<boolean> {
    return this.hasUnrevokedGrant(principalId, "PORTFOLIO_ALLOCATOR", projectId);
  }

  async isStrategySelectorEnabled(
    principalId: string,
    projectId: string,
  ): Promise<boolean> {
    return this.hasUnrevokedGrant(principalId, "STRATEGY_SELECTOR", projectId);
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

  async isExperimentSponsorEnabled(
    principalId: string,
    projectId: string,
  ): Promise<boolean> {
    return this.hasUnrevokedGrant(principalId, "EXPERIMENT_SPONSOR", projectId);
  }

  /**
   * Fail-closed intersection: principal must hold an explicit
   * EXPERIMENT_SPONSOR grant for EVERY project in scope.
   */
  async isExperimentSponsorForAllProjects(
    principalId: string,
    projectIds: readonly string[],
  ): Promise<boolean> {
    const unique = [...new Set(projectIds.filter((id) => id.length > 0))];
    if (unique.length === 0) {
      return false;
    }
    for (const projectId of unique) {
      if (!(await this.isExperimentSponsorEnabled(principalId, projectId))) {
        return false;
      }
    }
    return true;
  }

  async isCausalReviewerEnabled(
    principalId: string,
    projectId: string,
  ): Promise<boolean> {
    return this.hasUnrevokedGrant(principalId, "CAUSAL_REVIEWER", projectId);
  }

  /**
   * Fail-closed intersection: principal must hold an explicit
   * CAUSAL_REVIEWER grant for EVERY project in scope.
   */
  async isCausalReviewerForAllProjects(
    principalId: string,
    projectIds: readonly string[],
  ): Promise<boolean> {
    const unique = [...new Set(projectIds.filter((id) => id.length > 0))];
    if (unique.length === 0) {
      return false;
    }
    for (const projectId of unique) {
      if (!(await this.isCausalReviewerEnabled(principalId, projectId))) {
        return false;
      }
    }
    return true;
  }

  async isDecisionPolicyApproverEnabled(
    principalId: string,
    projectId: string,
  ): Promise<boolean> {
    return this.hasUnrevokedGrant(principalId, "DECISION_POLICY_APPROVER", projectId);
  }

  /**
   * Fail-closed intersection: principal must hold an explicit
   * DECISION_POLICY_APPROVER grant for EVERY project in scope.
   */
  async isDecisionPolicyApproverForAllProjects(
    principalId: string,
    projectIds: readonly string[],
  ): Promise<boolean> {
    const unique = [...new Set(projectIds.filter((id) => id.length > 0))];
    if (unique.length === 0) {
      return false;
    }
    for (const projectId of unique) {
      if (!(await this.isDecisionPolicyApproverEnabled(principalId, projectId))) {
        return false;
      }
    }
    return true;
  }

  async isDecisionPolicyActivatorEnabled(
    principalId: string,
    projectId: string,
  ): Promise<boolean> {
    return this.hasUnrevokedGrant(principalId, "DECISION_POLICY_ACTIVATOR", projectId);
  }

  /**
   * Fail-closed intersection: principal must hold an explicit
   * DECISION_POLICY_ACTIVATOR grant for EVERY project in scope.
   */
  async isDecisionPolicyActivatorForAllProjects(
    principalId: string,
    projectIds: readonly string[],
  ): Promise<boolean> {
    const unique = [...new Set(projectIds.filter((id) => id.length > 0))];
    if (unique.length === 0) {
      return false;
    }
    for (const projectId of unique) {
      if (!(await this.isDecisionPolicyActivatorEnabled(principalId, projectId))) {
        return false;
      }
    }
    return true;
  }

  async isGovernanceAdminEnabled(
    principalId: string,
    projectId: string,
  ): Promise<boolean> {
    return this.hasUnrevokedGrant(principalId, "GOVERNANCE_ADMIN", projectId);
  }

  /**
   * Fail-closed intersection: principal must hold an explicit
   * GOVERNANCE_ADMIN grant for EVERY project in scope.
   */
  async isGovernanceAdminForAllProjects(
    principalId: string,
    projectIds: readonly string[],
  ): Promise<boolean> {
    const unique = [...new Set(projectIds.filter((id) => id.length > 0))];
    if (unique.length === 0) {
      return false;
    }
    for (const projectId of unique) {
      if (!(await this.isGovernanceAdminEnabled(principalId, projectId))) {
        return false;
      }
    }
    return true;
  }

  async isGovernanceHoldOperatorEnabled(
    principalId: string,
    projectId: string,
  ): Promise<boolean> {
    return this.hasUnrevokedGrant(principalId, "GOVERNANCE_HOLD_OPERATOR", projectId);
  }

  /**
   * Fail-closed intersection: principal must hold an explicit
   * GOVERNANCE_HOLD_OPERATOR grant for EVERY project in scope.
   */
  async isGovernanceHoldOperatorForAllProjects(
    principalId: string,
    projectIds: readonly string[],
  ): Promise<boolean> {
    const unique = [...new Set(projectIds.filter((id) => id.length > 0))];
    if (unique.length === 0) {
      return false;
    }
    for (const projectId of unique) {
      if (!(await this.isGovernanceHoldOperatorEnabled(principalId, projectId))) {
        return false;
      }
    }
    return true;
  }

  async isRiskReviewerEnabled(
    principalId: string,
    projectId: string,
  ): Promise<boolean> {
    return this.hasUnrevokedGrant(principalId, "RISK_REVIEWER", projectId);
  }

  /**
   * Fail-closed intersection: principal must hold an explicit
   * RISK_REVIEWER grant for EVERY project in scope.
   */
  async isRiskReviewerForAllProjects(
    principalId: string,
    projectIds: readonly string[],
  ): Promise<boolean> {
    const unique = [...new Set(projectIds.filter((id) => id.length > 0))];
    if (unique.length === 0) {
      return false;
    }
    for (const projectId of unique) {
      if (!(await this.isRiskReviewerEnabled(principalId, projectId))) {
        return false;
      }
    }
    return true;
  }

  async isSecurityReviewerEnabled(
    principalId: string,
    projectId: string,
  ): Promise<boolean> {
    return this.hasUnrevokedGrant(principalId, "SECURITY_REVIEWER", projectId);
  }

  /**
   * Fail-closed intersection: principal must hold an explicit
   * SECURITY_REVIEWER grant for EVERY project in scope.
   */
  async isSecurityReviewerForAllProjects(
    principalId: string,
    projectIds: readonly string[],
  ): Promise<boolean> {
    const unique = [...new Set(projectIds.filter((id) => id.length > 0))];
    if (unique.length === 0) {
      return false;
    }
    for (const projectId of unique) {
      if (!(await this.isSecurityReviewerEnabled(principalId, projectId))) {
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
    return this.hasUnrevokedGrant(approverId, "APPROVER", projectId);
  }

  async hasAnyRequesterGrant(requesterId: string): Promise<boolean> {
    const result = await this.db.query<{ ok: number }>(
      `SELECT 1 AS ok FROM authority_grants g
       WHERE g.principal_id = $1 AND g.principal_type = 'REQUESTER' AND g.enabled = TRUE
         AND NOT EXISTS (
           SELECT 1 FROM authority_revocations r
           WHERE r.target_type = 'DIRECT_GRANT'
             AND r.target_id = g.grant_id
             AND r.effective_at <= NOW()
         )
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
  experimentSponsorGrants?: readonly {
    principalId: string;
    projectId?: string;
    environments?: readonly string[];
  }[];
  causalReviewerGrants?: readonly {
    principalId: string;
    projectId?: string;
    environments?: readonly string[];
  }[];
  decisionPolicyApproverGrants?: readonly {
    principalId: string;
    projectId?: string;
    environments?: readonly string[];
  }[];
  decisionPolicyActivatorGrants?: readonly {
    principalId: string;
    projectId?: string;
    environments?: readonly string[];
  }[];
  governanceAdminGrants?: readonly {
    principalId: string;
    projectId?: string;
    environments?: readonly string[];
  }[];
  holdOperatorGrants?: readonly {
    principalId: string;
    projectId?: string;
    environments?: readonly string[];
  }[];
  riskReviewerGrants?: readonly {
    principalId: string;
    projectId?: string;
    environments?: readonly string[];
  }[];
  securityReviewerGrants?: readonly {
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
  const sponsorGrants: readonly {
    principalId: string;
    projectId?: string;
    environments?: readonly string[];
  }[] =
    input.experimentSponsorGrants ??
    input.approverIds.map((principalId) => ({ principalId }));
  for (const grant of sponsorGrants) {
    seeds.push({
      principalId: grant.principalId,
      principalType: "EXPERIMENT_SPONSOR",
      projectId: grant.projectId ?? input.projectId,
      environments: grant.environments ?? input.environments,
    });
  }
  const causalReviewerGrants: readonly {
    principalId: string;
    projectId?: string;
    environments?: readonly string[];
  }[] =
    input.causalReviewerGrants ??
    input.approverIds.map((principalId) => ({ principalId }));
  for (const grant of causalReviewerGrants) {
    seeds.push({
      principalId: grant.principalId,
      principalType: "CAUSAL_REVIEWER",
      projectId: grant.projectId ?? input.projectId,
      environments: grant.environments ?? input.environments,
    });
  }
  const decisionPolicyApproverGrants: readonly {
    principalId: string;
    projectId?: string;
    environments?: readonly string[];
  }[] =
    input.decisionPolicyApproverGrants ??
    input.approverIds.map((principalId) => ({ principalId }));
  for (const grant of decisionPolicyApproverGrants) {
    seeds.push({
      principalId: grant.principalId,
      principalType: "DECISION_POLICY_APPROVER",
      projectId: grant.projectId ?? input.projectId,
      environments: grant.environments ?? input.environments,
    });
  }
  const decisionPolicyActivatorGrants: readonly {
    principalId: string;
    projectId?: string;
    environments?: readonly string[];
  }[] =
    input.decisionPolicyActivatorGrants ??
    input.approverIds.map((principalId) => ({ principalId }));
  for (const grant of decisionPolicyActivatorGrants) {
    seeds.push({
      principalId: grant.principalId,
      principalType: "DECISION_POLICY_ACTIVATOR",
      projectId: grant.projectId ?? input.projectId,
      environments: grant.environments ?? input.environments,
    });
  }
  // Phase 20 institutional roles — fail closed (default empty; never infer).
  for (const grant of input.governanceAdminGrants ?? []) {
    seeds.push({
      principalId: grant.principalId,
      principalType: "GOVERNANCE_ADMIN",
      projectId: grant.projectId ?? input.projectId,
      environments: grant.environments ?? input.environments,
    });
  }
  for (const grant of input.holdOperatorGrants ?? []) {
    seeds.push({
      principalId: grant.principalId,
      principalType: "GOVERNANCE_HOLD_OPERATOR",
      projectId: grant.projectId ?? input.projectId,
      environments: grant.environments ?? input.environments,
    });
  }
  for (const grant of input.riskReviewerGrants ?? []) {
    seeds.push({
      principalId: grant.principalId,
      principalType: "RISK_REVIEWER",
      projectId: grant.projectId ?? input.projectId,
      environments: grant.environments ?? input.environments,
    });
  }
  for (const grant of input.securityReviewerGrants ?? []) {
    seeds.push({
      principalId: grant.principalId,
      principalType: "SECURITY_REVIEWER",
      projectId: grant.projectId ?? input.projectId,
      environments: grant.environments ?? input.environments,
    });
  }
  return seeds;
}
