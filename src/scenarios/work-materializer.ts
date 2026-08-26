import type { DecisionProblemRepository } from "./repositories.js";
import type { ScenarioSetRepository } from "./repositories.js";
import type { DecisionPackageRepository } from "./repositories.js";
import type { SchedulerWorkItemRepository } from "../scheduling/repositories.js";
import type { SchedulerProjectConfigRepository } from "../scheduling/repositories.js";
import {
  emptyDependencySetHash,
  hashSchedulingMetadata,
  workItemIdFromIdentity,
  workLogicalIdentityKey,
} from "../scheduling/identity.js";
import {
  DEFAULT_WORK_MAX_ATTEMPTS,
  parseSchedulerWorkItem,
  type SchedulerWorkItem,
} from "../scheduling/work-item.js";
import {
  candidateScenarioWorkKinds,
  scenarioWorkBindingHash,
} from "../scheduling/scenario-discovery-map.js";
import type { MaterializeResult } from "../scheduling/service.js";

/**
 * Thin producer: materializes durable Phase 13 SchedulerWorkItems for scenarios.
 * Does NOT call ScenarioOrchestrationService simulate/validate/select.
 */
export class ScenarioWorkMaterializer {
  constructor(
    private readonly deps: {
      nowIso: () => string;
      decisionProblems: DecisionProblemRepository;
      scenarioSets: ScenarioSetRepository;
      decisionPackages: DecisionPackageRepository;
      workItems: SchedulerWorkItemRepository;
      projectConfigs: SchedulerProjectConfigRepository;
    },
  ) {}

  async discoverForDecisionProblem(
    decisionProblemId: string,
  ): Promise<MaterializeResult> {
    const problem = await this.deps.decisionProblems.getById(decisionProblemId);
    if (!problem) {
      return { created: [], reused: [] };
    }
    const kinds = candidateScenarioWorkKinds(problem.status);
    const created: SchedulerWorkItem[] = [];
    const reused: SchedulerWorkItem[] = [];
    const scenarioSet = await this.deps.scenarioSets.getLatest(decisionProblemId);
    const decisionPackage = await this.deps.decisionPackages.getLatest(
      decisionProblemId,
    );
    const config = await this.deps.projectConfigs.getByProjectId(
      problem.primaryProjectId,
    );
    const weight = config?.weight ?? 1;
    const priorityClass = config?.defaultPriorityClass ?? "NORMAL";

    for (const workKind of kinds) {
      const bindingHash = scenarioWorkBindingHash({
        workKind,
        decisionProblemId: problem.decisionProblemId,
        decisionProblemVersion: problem.decisionProblemVersion,
        policyBundleFingerprint: problem.policyBundleFingerprint,
        capabilitySetFingerprint: problem.capabilitySetFingerprint,
        ...(problem.truthSnapshotFingerprint
          ? { truthSnapshotFingerprint: problem.truthSnapshotFingerprint }
          : {}),
        ...(scenarioSet
          ? {
              scenarioSetVersion: scenarioSet.scenarioSetVersion,
              scenarioSetHash: scenarioSet.scenarioSetHash,
            }
          : {}),
        ...(decisionPackage
          ? { decisionPackageHash: decisionPackage.decisionPackageHash }
          : {}),
      });
      const logicalIdentityKey = workLogicalIdentityKey({
        runId: problem.decisionProblemId,
        workKind,
        bindingHash,
      });
      const existing =
        await this.deps.workItems.getByLogicalIdentity(logicalIdentityKey);
      if (existing) {
        reused.push(existing);
        continue;
      }
      const now = this.deps.nowIso();
      const item = parseSchedulerWorkItem({
        workItemId: workItemIdFromIdentity(logicalIdentityKey),
        projectId: problem.primaryProjectId,
        runId: problem.decisionProblemId,
        workKind,
        status: "ELIGIBLE",
        priorityClass,
        logicalIdentityKey,
        bindingHash,
        createdAt: now,
        eligibleAt: now,
        attemptCount: 0,
        maxAttempts: DEFAULT_WORK_MAX_ATTEMPTS,
        recordRevision: 1,
        dependencySetHash: emptyDependencySetHash(),
        schedulingMetadataHash: hashSchedulingMetadata({
          priorityClass,
          projectWeight: weight,
        }),
      });
      await this.deps.workItems.save(item);
      created.push(item);
    }
    return { created, reused };
  }

  async discoverBatch(
    decisionProblemIds: readonly string[],
  ): Promise<MaterializeResult> {
    const created: SchedulerWorkItem[] = [];
    const reused: SchedulerWorkItem[] = [];
    for (const id of decisionProblemIds) {
      const result = await this.discoverForDecisionProblem(id);
      created.push(...result.created);
      reused.push(...result.reused);
    }
    return { created, reused };
  }
}
