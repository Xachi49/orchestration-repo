import type { DecisionPolicyCandidateRepository } from "./repositories.js";
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
  candidateDecisionPolicyWorkKinds,
  decisionPolicyWorkBindingHash,
} from "../scheduling/decision-policy-discovery-map.js";
import type { MaterializeResult } from "../scheduling/service.js";

/**
 * Thin producer: materializes durable Phase 13 SchedulerWorkItems for
 * decision-policy work. Does NOT approve/activate/recommend.
 */
export class DecisionPolicyWorkMaterializer {
  constructor(
    private readonly deps: {
      nowIso: () => string;
      policies: DecisionPolicyCandidateRepository;
      workItems: SchedulerWorkItemRepository;
      projectConfigs: SchedulerProjectConfigRepository;
    },
  ) {}

  async discoverForPolicy(decisionPolicyId: string): Promise<MaterializeResult> {
    const policy = await this.deps.policies.getById(decisionPolicyId);
    if (!policy) {
      return { created: [], reused: [] };
    }
    const kinds = candidateDecisionPolicyWorkKinds(policy.status);
    const created: SchedulerWorkItem[] = [];
    const reused: SchedulerWorkItem[] = [];
    const projectId = "decision-policy";
    const config = await this.deps.projectConfigs.getByProjectId(projectId);
    const weight = config?.weight ?? 1;
    const priorityClass = config?.defaultPriorityClass ?? "NORMAL";

    for (const workKind of kinds) {
      const bindingHash = decisionPolicyWorkBindingHash({
        workKind,
        decisionPolicyId: policy.decisionPolicyId,
        decisionPolicyVersion: policy.decisionPolicyVersion,
        policyHash: policy.policyHash,
      });
      const logicalIdentityKey = workLogicalIdentityKey({
        runId: policy.decisionPolicyId,
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
        projectId,
        runId: policy.decisionPolicyId,
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

  async discoverBatch(ids: readonly string[]): Promise<MaterializeResult> {
    const created: SchedulerWorkItem[] = [];
    const reused: SchedulerWorkItem[] = [];
    for (const id of ids) {
      const result = await this.discoverForPolicy(id);
      created.push(...result.created);
      reused.push(...result.reused);
    }
    return { created, reused };
  }
}
