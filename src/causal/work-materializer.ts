import type { CausalQuestionRepository } from "./repositories.js";
import type { CausalGraphRepository } from "./repositories.js";
import type { CausalIdentificationAnalysisRepository } from "./repositories.js";
import type { CausalClaimCandidateRepository } from "./repositories.js";
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
  candidateCausalWorkKinds,
  causalWorkBindingHash,
} from "../scheduling/causal-discovery-map.js";
import type { MaterializeResult } from "../scheduling/service.js";

/**
 * Thin producer: materializes durable Phase 13 SchedulerWorkItems for causal work.
 * Does NOT call estimation/promotion/review decision.
 */
export class CausalWorkMaterializer {
  constructor(
    private readonly deps: {
      nowIso: () => string;
      questions: CausalQuestionRepository;
      graphs: CausalGraphRepository;
      identifications: CausalIdentificationAnalysisRepository;
      claims: CausalClaimCandidateRepository;
      workItems: SchedulerWorkItemRepository;
      projectConfigs: SchedulerProjectConfigRepository;
    },
  ) {}

  async discoverForQuestion(
    causalQuestionId: string,
  ): Promise<MaterializeResult> {
    const question = await this.deps.questions.getById(causalQuestionId);
    if (!question) {
      return { created: [], reused: [] };
    }
    const kinds = candidateCausalWorkKinds(question.status);
    const created: SchedulerWorkItem[] = [];
    const reused: SchedulerWorkItem[] = [];
    const graph = await this.deps.graphs.getLatestByQuestion(causalQuestionId);
    const analysis =
      await this.deps.identifications.getLatestByQuestion(causalQuestionId);
    const claim = await this.deps.claims.getLatestByQuestion(causalQuestionId);
    const projectId = question.projectIds[0]!;
    const config = await this.deps.projectConfigs.getByProjectId(projectId);
    const weight = config?.weight ?? 1;
    const priorityClass = config?.defaultPriorityClass ?? "NORMAL";

    for (const workKind of kinds) {
      const bindingHash = causalWorkBindingHash({
        workKind,
        causalQuestionId: question.causalQuestionId,
        causalQuestionVersion: question.causalQuestionVersion,
        ...(graph ? { graphHash: graph.graphHash } : {}),
        ...(analysis
          ? { identificationFingerprint: analysis.identificationFingerprint }
          : {}),
        ...(claim ? { claimHash: claim.claimHash } : {}),
      });
      const logicalIdentityKey = workLogicalIdentityKey({
        runId: question.causalQuestionId,
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
        runId: question.causalQuestionId,
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
      const result = await this.discoverForQuestion(id);
      created.push(...result.created);
      reused.push(...result.reused);
    }
    return { created, reused };
  }
}
