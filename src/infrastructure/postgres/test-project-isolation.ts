import { SystemClock } from "../clock.js";
import {
  EXAMPLE_BUDGET,
  EXAMPLE_ENVIRONMENT,
  EXAMPLE_PROJECT,
  EXAMPLE_POLICY_BUNDLE,
} from "../../control-plane/fixtures.js";
import { EXAMPLE_REQUESTER_ID } from "../../admission/fixtures.js";
import { EXAMPLE_REPOSITORY_SOURCE } from "../../ingestion/fixtures.js";
import { PostgresProjectRegistry } from "./repositories/control-plane.js";
import { PostgresPolicyRegistry } from "./repositories/control-plane.js";
import { PostgresResourceBudgetRegistry } from "./repositories/control-plane.js";
import {
  PostgresAuthorityDirectory,
  buildAuthoritySeeds,
} from "./repositories/authority-directory.js";
import { PostgresRepositorySourceRegistry } from "./repositories/phase-stores.js";
import type { PostgresDatabase } from "./database.js";

/** Test-only second project. Not a production project-admin API. */
export const ISOLATION_PROJECT_B_ID = "phase11-isolation-project-b";

export async function seedIsolationProjectB(
  db: PostgresDatabase,
): Promise<string> {
  const clock = new SystemClock();
  const projects = new PostgresProjectRegistry(db);
  const policies = new PostgresPolicyRegistry(db, clock);
  const budgets = new PostgresResourceBudgetRegistry(db);
  const authority = new PostgresAuthorityDirectory(db);
  const sources = new PostgresRepositorySourceRegistry(db);

  const projectB = {
    ...EXAMPLE_PROJECT,
    projectId: ISOLATION_PROJECT_B_ID,
    projectName: "Phase 11 Isolation Project B",
    activePolicyBundleId: "pol_phase11_isolation_b",
  };
  const policyB = {
    ...EXAMPLE_POLICY_BUNDLE,
    policyBundleId: "pol_phase11_isolation_b",
    policyHash: "sha256:example-policy-phase11-isolation-b",
    applicableProjectIds: [ISOLATION_PROJECT_B_ID],
  };

  await projects.seed([projectB]);
  await policies.seed([policyB]);
  await budgets.seed([EXAMPLE_BUDGET]);
  await authority.seed(
    buildAuthoritySeeds({
      requesterGrants: [
        {
          requesterId: EXAMPLE_REQUESTER_ID,
          projectId: ISOLATION_PROJECT_B_ID,
          environments: [EXAMPLE_ENVIRONMENT, "development"],
        },
      ],
      approverIds: ["approver_bootstrap"],
      projectId: ISOLATION_PROJECT_B_ID,
      environments: projectB.allowedEnvironments,
    }),
  );
  await sources.seed([
    {
      ...EXAMPLE_REPOSITORY_SOURCE,
      projectId: ISOLATION_PROJECT_B_ID,
    },
  ]);
  return ISOLATION_PROJECT_B_ID;
}

/**
 * Test-only dedicated project so bounded retrieval is not crowded by
 * accumulated EXAMPLE_PROJECT_ID precedents from prior suite runs.
 * Does not delete history. Repeatable without TRUNCATE.
 */
export async function seedDedicatedPostgresTestProject(
  db: PostgresDatabase,
  projectId: string,
): Promise<string> {
  const clock = new SystemClock();
  const projects = new PostgresProjectRegistry(db);
  const policies = new PostgresPolicyRegistry(db, clock);
  const budgets = new PostgresResourceBudgetRegistry(db);
  const authority = new PostgresAuthorityDirectory(db);
  const sources = new PostgresRepositorySourceRegistry(db);
  const policyBundleId = `pol_${projectId}`;

  const project = {
    ...EXAMPLE_PROJECT,
    projectId,
    projectName: `Phase 11 dedicated ${projectId}`,
    activePolicyBundleId: policyBundleId,
  };
  const policy = {
    ...EXAMPLE_POLICY_BUNDLE,
    policyBundleId,
    policyHash: `sha256:example-policy-${projectId}`,
    applicableProjectIds: [projectId],
  };

  await projects.seed([project]);
  await policies.seed([policy]);
  await budgets.seed([EXAMPLE_BUDGET]);
  await authority.seed(
    buildAuthoritySeeds({
      requesterGrants: [
        {
          requesterId: EXAMPLE_REQUESTER_ID,
          projectId,
          environments: [EXAMPLE_ENVIRONMENT, "development"],
        },
      ],
      approverIds: ["approver_bootstrap"],
      projectId,
      environments: project.allowedEnvironments,
    }),
  );
  await sources.seed([
    {
      ...EXAMPLE_REPOSITORY_SOURCE,
      projectId,
    },
  ]);
  return projectId;
}
