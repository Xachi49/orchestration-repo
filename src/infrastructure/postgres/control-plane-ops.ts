/**
 * Operator-only control-plane inspect / provision service.
 *
 * CONTROL-PLANE PROVISIONING != OUTREACH AUTHORIZATION
 * CLI INVOCATION != PHASE 6 AUTHORIZATION
 * Never creates ApprovalRequest, AuthorizationRecord, or Phase 7 work.
 *
 * Apply transaction boundary:
 * PRECHECK → BEGIN TX → RECHECK → INSERT → VERIFY → AUDIT → COMMIT
 */
import { randomUUID } from "node:crypto";
import { SystemClock } from "../clock.js";
import { hashCanonical } from "../../ingestion/hashing.js";
import type { PostgresDatabase } from "./database.js";
import { PostgresJsonDocuments } from "./documents.js";
import {
  PostgresCapabilityRegistry,
  PostgresPolicyRegistry,
  PostgresProjectRegistry,
  PostgresResourceBudgetRegistry,
} from "./repositories/control-plane.js";
import { PostgresAuthorityDirectory } from "./repositories/authority-directory.js";
import { PostgresRepositorySourceRegistry } from "./repositories/phase-stores.js";
import {
  environmentsEqual,
  materializeControlPlaneManifest,
  parseControlPlaneProvisionManifest,
  budgetMaterialFingerprint,
  capabilityMaterialFingerprint,
  policyMaterialFingerprint,
  projectMaterialFingerprint,
  repositorySourceMaterialFingerprint,
  type ControlPlaneInspectResult,
  type ControlPlaneProvisionResult,
  type ControlPlaneProvisioningAuditRecord,
  type MaterializedControlPlane,
  type ProvisionConflict,
  type ProvisionPlanItem,
} from "../../control-plane/provisioning/index.js";

const PROVISIONING_AUDIT_COLLECTION = "control_plane_provisioning_audits";

export class ControlPlaneOpsService {
  private readonly projects: PostgresProjectRegistry;
  private readonly policies: PostgresPolicyRegistry;
  private readonly budgets: PostgresResourceBudgetRegistry;
  private readonly capabilities: PostgresCapabilityRegistry;
  private readonly authority: PostgresAuthorityDirectory;
  private readonly sources: PostgresRepositorySourceRegistry;
  private readonly docs: PostgresJsonDocuments;
  private readonly clock: SystemClock;

  constructor(private readonly db: PostgresDatabase) {
    this.clock = new SystemClock();
    this.projects = new PostgresProjectRegistry(db);
    this.policies = new PostgresPolicyRegistry(db, this.clock);
    this.budgets = new PostgresResourceBudgetRegistry(db);
    this.capabilities = new PostgresCapabilityRegistry(db);
    this.authority = new PostgresAuthorityDirectory(db);
    this.sources = new PostgresRepositorySourceRegistry(db);
    this.docs = new PostgresJsonDocuments(db);
  }

  async inspect(projectId: string): Promise<ControlPlaneInspectResult> {
    const project = await this.projects.getById(projectId);
    const grants = await this.authority.listProjectAuthorityGrants(projectId);
    const requesterGrants = grants.filter(
      (g) => g.principalType === "REQUESTER" && !g.revoked && g.enabled,
    );
    const approverGrants = grants.filter(
      (g) => g.principalType === "APPROVER" && !g.revoked && g.enabled,
    );

    let activePolicyBundle: unknown | null = null;
    let activePolicyBundleMissing = true;
    let resourceBudgetProfile: unknown | null = null;
    let resourceBudgetProfileMissing = true;

    if (project) {
      activePolicyBundle = await this.policies.getBundleById(
        project.activePolicyBundleId,
      );
      activePolicyBundleMissing = activePolicyBundle === null;
      resourceBudgetProfile = await this.budgets.getById(
        project.resourceBudgetProfileId,
      );
      resourceBudgetProfileMissing = resourceBudgetProfile === null;
    }

    const allCapabilities = await this.capabilities.list();
    const repositorySource = await this.sources.getByProjectId(projectId);

    return {
      projectId,
      project,
      projectMissing: project === null,
      activePolicyBundle,
      activePolicyBundleMissing,
      resourceBudgetProfile,
      resourceBudgetProfileMissing,
      capabilities: [...allCapabilities],
      requesterGrants,
      approverGrants,
      repositorySource,
      repositorySourceMissing: repositorySource === null,
    };
  }

  async listProvisioningAudits(
    projectId: string,
  ): Promise<readonly ControlPlaneProvisioningAuditRecord[]> {
    return this.docs.listByProject(
      PROVISIONING_AUDIT_COLLECTION,
      projectId,
      (raw) => raw as ControlPlaneProvisioningAuditRecord,
    );
  }

  async provision(input: {
    manifest: unknown;
    mode: "dry-run" | "apply";
    /** Required for --apply. Non-secret operator identity for durable audit. */
    operatorId?: string;
  }): Promise<ControlPlaneProvisionResult> {
    const parsed = parseControlPlaneProvisionManifest(input.manifest);
    const nowIso = this.clock.nowIso();
    const materialized = materializeControlPlaneManifest(parsed, nowIso);
    const manifestFingerprint = hashCanonical(parsed);
    const { conflicts, plan } = await this.precheck(materialized);

    // --apply always requires operator identity before any apply-path result
    // (including conflict reports). Dry-run / inspect remain non-mutating.
    let operatorId: string | undefined;
    if (input.mode === "apply") {
      operatorId = input.operatorId?.trim();
      if (!operatorId) {
        throw new ControlPlaneProvisionError(
          "OPERATOR_ID_REQUIRED",
          "--apply requires --operator-id (non-secret operator identity)",
        );
      }
    }

    const base: ControlPlaneProvisionResult = {
      mode: input.mode,
      projectId: materialized.project.projectId,
      doctrine: {
        provisioningNotExecutionAuthority:
          "CONTROL-PLANE PROVISIONING != OUTREACH AUTHORIZATION",
        cliNotPhase6: "BUTTON/CLI INVOCATION != PHASE 6 AUTHORIZATION",
        passNotApproved: "PASS != APPROVED",
      },
      conflicts,
      plan,
      applied: false,
      manifestFingerprint,
    };

    if (conflicts.length > 0) {
      return base;
    }

    if (input.mode === "dry-run") {
      return base;
    }

    if (!operatorId) {
      throw new ControlPlaneProvisionError(
        "OPERATOR_ID_REQUIRED",
        "--apply requires --operator-id (non-secret operator identity)",
      );
    }

    const provisioningOperationId = `cpprov_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
    let verified: ControlPlaneInspectResult | undefined;
    let committedPlan = plan;

    await this.db.withTransaction(async () => {
      const again = await this.precheck(materialized);
      if (again.conflicts.length > 0) {
        throw new ControlPlaneProvisionError(
          "PROVISION_CONFLICT",
          "Conflict detected during transactional apply",
          again.conflicts,
        );
      }
      committedPlan = again.plan;
      for (const item of again.plan) {
        if (item.outcome !== "CREATE") continue;
        await this.applyCreate(item, materialized);
      }
      verified = await this.inspect(materialized.project.projectId);
      this.assertProvisioned(materialized, verified);
      const audit: ControlPlaneProvisioningAuditRecord = {
        provisioningOperationId,
        operatorId,
        projectId: materialized.project.projectId,
        manifestFingerprint,
        occurredAt: nowIso,
        mode: "apply",
        planSummary: again.plan,
        outcome: "SUCCEEDED",
      };
      await this.docs.insert({
        collection: PROVISIONING_AUDIT_COLLECTION,
        documentId: provisioningOperationId,
        projectId: materialized.project.projectId,
        uniqueKey: provisioningOperationId,
        payload: audit,
        immutable: true,
      });
    });

    if (!verified) {
      throw new ControlPlaneProvisionError(
        "PROVISION_VERIFY_FAILED",
        "Missing verification result after transactional apply",
      );
    }

    return {
      ...base,
      plan: committedPlan,
      applied: true,
      provisioningOperationId,
      operatorId,
      verified,
    };
  }

  private assertProvisioned(
    materialized: MaterializedControlPlane,
    verified: ControlPlaneInspectResult,
  ): void {
    if (verified.projectMissing || !verified.project) {
      throw new ControlPlaneProvisionError(
        "PROVISION_VERIFY_FAILED",
        "Project missing after apply",
      );
    }
    if (
      projectMaterialFingerprint(verified.project as never) !==
      projectMaterialFingerprint(materialized.project)
    ) {
      throw new ControlPlaneProvisionError(
        "PROVISION_VERIFY_FAILED",
        "Project material mismatch after apply",
      );
    }
    if (verified.activePolicyBundleMissing || !verified.activePolicyBundle) {
      throw new ControlPlaneProvisionError(
        "PROVISION_VERIFY_FAILED",
        "Policy bundle missing after apply",
      );
    }
    if (
      policyMaterialFingerprint(verified.activePolicyBundle as never) !==
      policyMaterialFingerprint(materialized.policyBundle)
    ) {
      throw new ControlPlaneProvisionError(
        "PROVISION_VERIFY_FAILED",
        "Policy material mismatch after apply",
      );
    }
    if (
      verified.resourceBudgetProfileMissing ||
      !verified.resourceBudgetProfile
    ) {
      throw new ControlPlaneProvisionError(
        "PROVISION_VERIFY_FAILED",
        "Budget profile missing after apply",
      );
    }
    if (
      budgetMaterialFingerprint(verified.resourceBudgetProfile as never) !==
      budgetMaterialFingerprint(materialized.budgetProfile)
    ) {
      throw new ControlPlaneProvisionError(
        "PROVISION_VERIFY_FAILED",
        "Budget material mismatch after apply",
      );
    }
    for (const capability of materialized.capabilities) {
      const found = verified.capabilities.find(
        (c) =>
          c &&
          typeof c === "object" &&
          "capabilityId" in c &&
          (c as { capabilityId: string }).capabilityId ===
            capability.capabilityId,
      );
      if (!found) {
        throw new ControlPlaneProvisionError(
          "PROVISION_VERIFY_FAILED",
          `Capability ${capability.capabilityId} missing after apply`,
        );
      }
      if (
        capabilityMaterialFingerprint(found as never) !==
        capabilityMaterialFingerprint(capability)
      ) {
        throw new ControlPlaneProvisionError(
          "PROVISION_VERIFY_FAILED",
          `Capability ${capability.capabilityId} material mismatch after apply`,
        );
      }
    }
    for (const grant of materialized.requesterGrants) {
      const found = verified.requesterGrants.find(
        (g) =>
          g &&
          typeof g === "object" &&
          "principalId" in g &&
          (g as { principalId: string }).principalId === grant.requesterId,
      );
      if (!found) {
        throw new ControlPlaneProvisionError(
          "PROVISION_VERIFY_FAILED",
          `Requester grant ${grant.requesterId} missing after apply`,
        );
      }
    }
    for (const grant of materialized.approverGrants) {
      const found = verified.approverGrants.find(
        (g) =>
          g &&
          typeof g === "object" &&
          "principalId" in g &&
          (g as { principalId: string }).principalId === grant.approverId,
      );
      if (!found) {
        throw new ControlPlaneProvisionError(
          "PROVISION_VERIFY_FAILED",
          `Approver grant ${grant.approverId} missing after apply`,
        );
      }
    }
    if (materialized.repositorySource) {
      if (verified.repositorySourceMissing || !verified.repositorySource) {
        throw new ControlPlaneProvisionError(
          "PROVISION_VERIFY_FAILED",
          "Repository source missing after apply",
        );
      }
      if (
        repositorySourceMaterialFingerprint(
          verified.repositorySource as never,
        ) !==
        repositorySourceMaterialFingerprint(materialized.repositorySource)
      ) {
        throw new ControlPlaneProvisionError(
          "PROVISION_VERIFY_FAILED",
          "Repository source material mismatch after apply",
        );
      }
    }
  }

  private async precheck(materialized: MaterializedControlPlane): Promise<{
    conflicts: ProvisionConflict[];
    plan: ProvisionPlanItem[];
  }> {
    const conflicts: ProvisionConflict[] = [];
    const plan: ProvisionPlanItem[] = [];

    const existingProject = await this.projects.getById(
      materialized.project.projectId,
    );
    if (!existingProject) {
      plan.push({
        recordType: "project",
        identity: materialized.project.projectId,
        outcome: "CREATE",
      });
    } else if (
      projectMaterialFingerprint(existingProject) ===
      projectMaterialFingerprint(materialized.project)
    ) {
      plan.push({
        recordType: "project",
        identity: materialized.project.projectId,
        outcome: "UNCHANGED",
      });
    } else {
      conflicts.push({
        recordType: "project",
        identity: materialized.project.projectId,
        reasonCode: "PROJECT_CONTENT_CONFLICT",
        message:
          "Existing project differs materially from manifest; refuse overwrite",
      });
    }

    const existingPolicy = await this.policies.getBundleById(
      materialized.policyBundle.policyBundleId,
    );
    if (!existingPolicy) {
      plan.push({
        recordType: "policyBundle",
        identity: materialized.policyBundle.policyBundleId,
        outcome: "CREATE",
      });
    } else if (
      policyMaterialFingerprint(existingPolicy) ===
      policyMaterialFingerprint(materialized.policyBundle)
    ) {
      plan.push({
        recordType: "policyBundle",
        identity: materialized.policyBundle.policyBundleId,
        outcome: "UNCHANGED",
      });
    } else {
      conflicts.push({
        recordType: "policyBundle",
        identity: materialized.policyBundle.policyBundleId,
        reasonCode: "POLICY_CONTENT_CONFLICT",
        message:
          "Existing policy bundle differs materially; require a new versioned identity",
      });
    }

    const existingBudget = await this.budgets.getById(
      materialized.budgetProfile.budgetProfileId,
    );
    if (!existingBudget) {
      plan.push({
        recordType: "budgetProfile",
        identity: materialized.budgetProfile.budgetProfileId,
        outcome: "CREATE",
      });
    } else if (
      budgetMaterialFingerprint(existingBudget) ===
      budgetMaterialFingerprint(materialized.budgetProfile)
    ) {
      plan.push({
        recordType: "budgetProfile",
        identity: materialized.budgetProfile.budgetProfileId,
        outcome: "UNCHANGED",
      });
    } else {
      conflicts.push({
        recordType: "budgetProfile",
        identity: materialized.budgetProfile.budgetProfileId,
        reasonCode: "BUDGET_CONTENT_CONFLICT",
        message:
          "Existing budget profile differs materially from manifest; refuse overwrite",
      });
    }

    for (const capability of materialized.capabilities) {
      const existing = await this.capabilities.getById(capability.capabilityId);
      if (!existing) {
        plan.push({
          recordType: "capability",
          identity: capability.capabilityId,
          outcome: "CREATE",
        });
      } else if (
        capabilityMaterialFingerprint(existing) ===
        capabilityMaterialFingerprint(capability)
      ) {
        plan.push({
          recordType: "capability",
          identity: capability.capabilityId,
          outcome: "UNCHANGED",
        });
      } else {
        conflicts.push({
          recordType: "capability",
          identity: capability.capabilityId,
          reasonCode: "CAPABILITY_CONTENT_CONFLICT",
          message:
            "Existing capability differs materially from manifest; refuse overwrite",
        });
      }
    }

    for (const grant of materialized.requesterGrants) {
      await this.precheckGrant(
        {
          principalId: grant.requesterId,
          principalType: "REQUESTER",
          projectId: grant.projectId,
          environments: grant.environments,
        },
        conflicts,
        plan,
      );
    }
    for (const grant of materialized.approverGrants) {
      await this.precheckGrant(
        {
          principalId: grant.approverId,
          principalType: "APPROVER",
          projectId: grant.projectId,
          environments: grant.environments,
        },
        conflicts,
        plan,
      );
    }

    if (materialized.repositorySource) {
      const existing = await this.sources.getByProjectId(
        materialized.repositorySource.projectId,
      );
      if (!existing) {
        plan.push({
          recordType: "repositorySource",
          identity: materialized.repositorySource.projectId,
          outcome: "CREATE",
        });
      } else if (
        repositorySourceMaterialFingerprint(existing) ===
        repositorySourceMaterialFingerprint(materialized.repositorySource)
      ) {
        plan.push({
          recordType: "repositorySource",
          identity: materialized.repositorySource.projectId,
          outcome: "UNCHANGED",
        });
      } else {
        conflicts.push({
          recordType: "repositorySource",
          identity: materialized.repositorySource.projectId,
          reasonCode: "REPOSITORY_SOURCE_CONTENT_CONFLICT",
          message:
            "Existing repository source differs materially; refuse overwrite",
        });
      }
    }

    return { conflicts, plan };
  }

  private async precheckGrant(
    grant: {
      principalId: string;
      principalType: "REQUESTER" | "APPROVER";
      projectId: string;
      environments: readonly string[];
    },
    conflicts: ProvisionConflict[],
    plan: ProvisionPlanItem[],
  ): Promise<void> {
    const identity = `${grant.principalType}:${grant.principalId}@${grant.projectId}`;
    const current = await this.authority.getUnrevokedGrantEnvironments(
      grant.principalId,
      grant.principalType,
      grant.projectId,
    );
    if (current !== null) {
      if (environmentsEqual(current, grant.environments)) {
        plan.push({
          recordType: "authorityGrant",
          identity,
          outcome: "UNCHANGED",
        });
        return;
      }
      conflicts.push({
        recordType: "authorityGrant",
        identity,
        reasonCode: "GRANT_ENVIRONMENT_CONFLICT",
        message:
          "Unrevoked grant exists with different environments; refuse mutation",
      });
      return;
    }
    if (
      await this.authority.hasRevokedGrantOnly(
        grant.principalId,
        grant.principalType,
        grant.projectId,
      )
    ) {
      conflicts.push({
        recordType: "authorityGrant",
        identity,
        reasonCode: "REVOKED_GRANT_BLOCKS_RESURRECTION",
        message:
          "Revoked grant exists for this principal/project; refuse silent resurrection",
      });
      return;
    }
    plan.push({
      recordType: "authorityGrant",
      identity,
      outcome: "CREATE",
    });
  }

  private async applyCreate(
    item: ProvisionPlanItem,
    materialized: MaterializedControlPlane,
  ): Promise<void> {
    switch (item.recordType) {
      case "project":
        await this.projects.insertExclusive(materialized.project);
        return;
      case "policyBundle":
        await this.policies.insertExclusive(materialized.policyBundle);
        return;
      case "budgetProfile":
        await this.budgets.insertExclusive(materialized.budgetProfile);
        return;
      case "capability": {
        const capability = materialized.capabilities.find(
          (c) => c.capabilityId === item.identity,
        );
        if (!capability) {
          throw new ControlPlaneProvisionError(
            "PROVISION_INTERNAL",
            `Missing capability ${item.identity} in materialized set`,
          );
        }
        await this.capabilities.insertExclusive(capability);
        return;
      }
      case "authorityGrant": {
        const [type, rest] = item.identity.split(":", 2);
        const [principalId, projectId] = (rest ?? "").split("@", 2);
        if (type === "REQUESTER") {
          const grant = materialized.requesterGrants.find(
            (g) =>
              g.requesterId === principalId && g.projectId === projectId,
          );
          if (!grant) {
            throw new ControlPlaneProvisionError(
              "PROVISION_INTERNAL",
              `Missing requester grant ${item.identity}`,
            );
          }
          await this.authority.insertExclusiveGrant({
            principalId: grant.requesterId,
            principalType: "REQUESTER",
            projectId: grant.projectId,
            environments: grant.environments,
          });
          return;
        }
        if (type === "APPROVER") {
          const grant = materialized.approverGrants.find(
            (g) => g.approverId === principalId && g.projectId === projectId,
          );
          if (!grant) {
            throw new ControlPlaneProvisionError(
              "PROVISION_INTERNAL",
              `Missing approver grant ${item.identity}`,
            );
          }
          await this.authority.insertExclusiveGrant({
            principalId: grant.approverId,
            principalType: "APPROVER",
            projectId: grant.projectId,
            environments: grant.environments,
          });
          return;
        }
        throw new ControlPlaneProvisionError(
          "PROVISION_INTERNAL",
          `Unknown grant type in ${item.identity}`,
        );
      }
      case "repositorySource":
        if (!materialized.repositorySource) {
          throw new ControlPlaneProvisionError(
            "PROVISION_INTERNAL",
            "Missing repository source in materialized set",
          );
        }
        await this.sources.insertExclusive(materialized.repositorySource);
        return;
      default:
        throw new ControlPlaneProvisionError(
          "PROVISION_INTERNAL",
          `Unknown record type ${item.recordType}`,
        );
    }
  }
}

export class ControlPlaneProvisionError extends Error {
  readonly code: string;
  readonly conflicts?: readonly ProvisionConflict[];

  constructor(
    code: string,
    message: string,
    conflicts?: readonly ProvisionConflict[],
  ) {
    super(message);
    this.name = "ControlPlaneProvisionError";
    this.code = code;
    if (conflicts) this.conflicts = conflicts;
  }
}

export function isControlPlaneProvisionError(
  error: unknown,
): error is ControlPlaneProvisionError {
  return error instanceof ControlPlaneProvisionError;
}
