import {
  evaluateActionAllowance,
  parseCapability,
  type ActionAllowance,
  type Capability,
} from "../../../control-plane/capabilities/capability.js";
import type { CapabilityRegistry } from "../../../control-plane/capabilities/registry.js";
import {
  parsePolicyBundle,
  type PolicyBundle,
} from "../../../control-plane/policies/policy.js";
import type { PolicyRegistry } from "../../../control-plane/policies/registry.js";
import { ControlPlaneError } from "../../../control-plane/errors.js";
import type { ControlPlaneClock } from "../../../control-plane/service.js";
import { parseProject, type Project } from "../../../control-plane/projects/project.js";
import type { ProjectRegistry } from "../../../control-plane/projects/registry.js";
import {
  parseResourceBudgetProfile,
  type ResourceBudgetProfile,
} from "../../../control-plane/budgets/budget.js";
import type { ResourceBudgetRegistry } from "../../../control-plane/budgets/registry.js";
import { hydrateRecord } from "../hydrate.js";
import type { PostgresDatabase } from "../database.js";

export class PostgresProjectRegistry implements ProjectRegistry {
  constructor(private readonly db: PostgresDatabase) {}

  async seed(projects: readonly Project[]): Promise<void> {
    for (const project of projects) {
      const parsed = parseProject(project);
      await this.db.query(
        `INSERT INTO projects (project_id, payload) VALUES ($1, $2::jsonb)
         ON CONFLICT (project_id) DO UPDATE SET payload = EXCLUDED.payload`,
        [parsed.projectId, JSON.stringify(parsed)],
      );
    }
  }

  async getById(projectId: string): Promise<Project | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM projects WHERE project_id = $1`,
      [projectId],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(parseProject, row.payload, `projects:${projectId}`)
      : null;
  }

  async exists(projectId: string): Promise<boolean> {
    const result = await this.db.query(
      `SELECT 1 FROM projects WHERE project_id = $1`,
      [projectId],
    );
    return result.rows.length > 0;
  }

  async list(): Promise<readonly Project[]> {
    const result = await this.db.query<{ payload: unknown; project_id: string }>(
      `SELECT project_id, payload FROM projects ORDER BY project_id`,
    );
    return result.rows.map((row) =>
      hydrateRecord(parseProject, row.payload, `projects:${row.project_id}`),
    );
  }
}

export class PostgresCapabilityRegistry implements CapabilityRegistry {
  constructor(private readonly db: PostgresDatabase) {}

  async seed(capabilities: readonly Capability[]): Promise<void> {
    for (const capability of capabilities) {
      const parsed = parseCapability(capability);
      await this.db.query(
        `INSERT INTO capabilities (capability_id, version, payload)
         VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (capability_id) DO UPDATE
         SET version = EXCLUDED.version, payload = EXCLUDED.payload`,
        [parsed.capabilityId, parsed.version, JSON.stringify(parsed)],
      );
    }
  }

  async getById(capabilityId: string): Promise<Capability | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM capabilities WHERE capability_id = $1`,
      [capabilityId],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(parseCapability, row.payload, `capabilities:${capabilityId}`)
      : null;
  }

  async exists(capabilityId: string): Promise<boolean> {
    const result = await this.db.query(
      `SELECT 1 FROM capabilities WHERE capability_id = $1`,
      [capabilityId],
    );
    return result.rows.length > 0;
  }

  async list(): Promise<readonly Capability[]> {
    const result = await this.db.query<{ payload: unknown; capability_id: string }>(
      `SELECT capability_id, payload FROM capabilities ORDER BY capability_id`,
    );
    return result.rows.map((row) =>
      hydrateRecord(
        parseCapability,
        row.payload,
        `capabilities:${row.capability_id}`,
      ),
    );
  }

  async isActionAllowed(
    capabilityId: string,
    action: string,
    environment: string,
  ): Promise<ActionAllowance> {
    return evaluateActionAllowance(await this.getById(capabilityId), action, environment);
  }
}

export class PostgresPolicyRegistry implements PolicyRegistry {
  constructor(
    private readonly db: PostgresDatabase,
    private readonly clock: ControlPlaneClock,
  ) {}

  async seed(bundles: readonly PolicyBundle[]): Promise<void> {
    for (const bundle of bundles) {
      const parsed = parsePolicyBundle(bundle);
      await this.db.query(
        `INSERT INTO policy_bundles (policy_bundle_id, policy_hash, status, payload)
         VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (policy_bundle_id) DO UPDATE
         SET policy_hash = EXCLUDED.policy_hash,
             status = EXCLUDED.status,
             payload = EXCLUDED.payload`,
        [
          parsed.policyBundleId,
          parsed.policyHash,
          parsed.status,
          JSON.stringify(parsed),
        ],
      );
    }
  }

  async getBundleById(policyBundleId: string): Promise<PolicyBundle | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM policy_bundles WHERE policy_bundle_id = $1`,
      [policyBundleId],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          parsePolicyBundle,
          row.payload,
          `policy_bundles:${policyBundleId}`,
        )
      : null;
  }

  async getActiveBundleForProject(
    projectId: string,
    environment: string,
  ): Promise<PolicyBundle> {
    const asOf = this.clock.nowIso();
    const all = await this.listAll();
    const matches = all.filter((bundle) => {
      if (bundle.status !== "ACTIVE") {
        return false;
      }
      if (bundle.effectiveAt > asOf) {
        return false;
      }
      if (!bundle.applicableProjectIds.includes(projectId)) {
        return false;
      }
      if (!bundle.applicableEnvironments.includes(environment)) {
        return false;
      }
      return true;
    });
    if (matches.length === 0) {
      throw new ControlPlaneError(
        "POLICY_BUNDLE_NOT_FOUND",
        `No active policy bundle for project ${projectId} in ${environment}`,
        { projectId, environment, asOf },
      );
    }
    if (matches.length > 1) {
      throw new ControlPlaneError(
        "POLICY_CONFLICT",
        `Multiple active policy bundles for project ${projectId} in ${environment}`,
        {
          projectId,
          environment,
          asOf,
          policyBundleIds: matches.map((bundle) => bundle.policyBundleId),
        },
      );
    }
    return matches[0]!;
  }

  async listVersions(policyBundleId: string): Promise<readonly PolicyBundle[]> {
    const all = await this.listAll();
    const start = all.find((bundle) => bundle.policyBundleId === policyBundleId);
    if (!start) {
      return [];
    }
    const byId = new Map(all.map((bundle) => [bundle.policyBundleId, bundle]));
    const lineageIds = new Set<string>();
    let current: PolicyBundle | undefined = start;
    while (current) {
      lineageIds.add(current.policyBundleId);
      current = current.supersedes ? byId.get(current.supersedes) : undefined;
    }
    let grew = true;
    while (grew) {
      grew = false;
      for (const bundle of all) {
        if (
          bundle.supersedes !== null &&
          lineageIds.has(bundle.supersedes) &&
          !lineageIds.has(bundle.policyBundleId)
        ) {
          lineageIds.add(bundle.policyBundleId);
          grew = true;
        }
      }
    }
    return all
      .filter((bundle) => lineageIds.has(bundle.policyBundleId))
      .sort((a, b) => a.effectiveAt.localeCompare(b.effectiveAt));
  }

  private async listAll(): Promise<PolicyBundle[]> {
    const result = await this.db.query<{
      payload: unknown;
      policy_bundle_id: string;
    }>(`SELECT policy_bundle_id, payload FROM policy_bundles`);
    return result.rows.map((row) =>
      hydrateRecord(
        parsePolicyBundle,
        row.payload,
        `policy_bundles:${row.policy_bundle_id}`,
      ),
    );
  }
}

export class PostgresResourceBudgetRegistry implements ResourceBudgetRegistry {
  constructor(private readonly db: PostgresDatabase) {}

  async seed(profiles: readonly ResourceBudgetProfile[]): Promise<void> {
    for (const profile of profiles) {
      const parsed = parseResourceBudgetProfile(profile);
      await this.db.query(
        `INSERT INTO budget_profiles (budget_profile_id, payload)
         VALUES ($1, $2::jsonb)
         ON CONFLICT (budget_profile_id) DO UPDATE SET payload = EXCLUDED.payload`,
        [parsed.budgetProfileId, JSON.stringify(parsed)],
      );
    }
  }

  async getById(
    budgetProfileId: string,
  ): Promise<ResourceBudgetProfile | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM budget_profiles WHERE budget_profile_id = $1`,
      [budgetProfileId],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          parseResourceBudgetProfile,
          row.payload,
          `budget_profiles:${budgetProfileId}`,
        )
      : null;
  }

  async exists(budgetProfileId: string): Promise<boolean> {
    const result = await this.db.query(
      `SELECT 1 FROM budget_profiles WHERE budget_profile_id = $1`,
      [budgetProfileId],
    );
    return result.rows.length > 0;
  }

  async list(): Promise<readonly ResourceBudgetProfile[]> {
    const result = await this.db.query<{
      payload: unknown;
      budget_profile_id: string;
    }>(`SELECT budget_profile_id, payload FROM budget_profiles ORDER BY budget_profile_id`);
    return result.rows.map((row) =>
      hydrateRecord(
        parseResourceBudgetProfile,
        row.payload,
        `budget_profiles:${row.budget_profile_id}`,
      ),
    );
  }
}
