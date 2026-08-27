import type { ExperimentRepository } from "./repositories.js";
import type { ExperimentPlanRepository } from "./repositories.js";
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
  candidateExperimentWorkKinds,
  experimentWorkBindingHash,
} from "../scheduling/experiment-discovery-map.js";
import type { MaterializeResult } from "../scheduling/service.js";

/**
 * Thin producer: materializes durable Phase 13 SchedulerWorkItems for experiments.
 * Does NOT call ExperimentOrchestrationService design/validate/authorize/execute.
 */
export class ExperimentWorkMaterializer {
  constructor(
    private readonly deps: {
      nowIso: () => string;
      experiments: ExperimentRepository;
      plans: ExperimentPlanRepository;
      workItems: SchedulerWorkItemRepository;
      projectConfigs: SchedulerProjectConfigRepository;
    },
  ) {}

  async discoverForExperiment(
    experimentId: string,
  ): Promise<MaterializeResult> {
    const experiment = await this.deps.experiments.getById(experimentId);
    if (!experiment) {
      return { created: [], reused: [] };
    }
    const kinds = candidateExperimentWorkKinds(experiment.status);
    const created: SchedulerWorkItem[] = [];
    const reused: SchedulerWorkItem[] = [];
    const plan = await this.deps.plans.getLatest(experimentId);
    const config = await this.deps.projectConfigs.getByProjectId(
      experiment.projectId,
    );
    const weight = config?.weight ?? 1;
    const priorityClass = config?.defaultPriorityClass ?? "NORMAL";

    for (const workKind of kinds) {
      const bindingHash = experimentWorkBindingHash({
        workKind,
        experimentId: experiment.experimentId,
        experimentVersion: experiment.experimentVersion,
        policyBundleFingerprint: experiment.policyBundleFingerprint,
        capabilitySetFingerprint: experiment.capabilitySetFingerprint,
        ...(experiment.truthSnapshotFingerprint
          ? { truthSnapshotFingerprint: experiment.truthSnapshotFingerprint }
          : {}),
        ...(plan
          ? {
              experimentPlanVersion: plan.experimentPlanVersion,
              experimentPlanHash: plan.experimentPlanHash,
            }
          : {}),
      });
      const logicalIdentityKey = workLogicalIdentityKey({
        runId: experiment.experimentId,
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
        projectId: experiment.projectId,
        runId: experiment.experimentId,
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
    experimentIds: readonly string[],
  ): Promise<MaterializeResult> {
    const created: SchedulerWorkItem[] = [];
    const reused: SchedulerWorkItem[] = [];
    for (const id of experimentIds) {
      const result = await this.discoverForExperiment(id);
      created.push(...result.created);
      reused.push(...result.reused);
    }
    return { created, reused };
  }
}
