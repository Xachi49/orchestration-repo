import type { Program } from "./program.js";
import type { ProgramPlan } from "./program-plan.js";
import type { ProgramMaterializationApproval } from "./lineage.js";
import type { ProgramRepository } from "./repositories.js";
import type { ProgramPlanRepository } from "./repositories.js";
import type { ProgramMaterializationApprovalRepository } from "./repositories.js";
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
  candidateProgramWorkKinds,
  programWorkBindingHash,
} from "../scheduling/program-discovery-map.js";
import { budgetAllocationFingerprint } from "./budget.js";
import type { MaterializeResult } from "../scheduling/service.js";

/**
 * Thin producer: materializes durable Phase 13 SchedulerWorkItems for Programs.
 * Does NOT execute progression — claim/fence/dispatch owns authority.
 */
export class ProgramWorkMaterializer {
  constructor(
    private readonly deps: {
      nowIso: () => string;
      programs: ProgramRepository;
      plans: ProgramPlanRepository;
      materializationApprovals: ProgramMaterializationApprovalRepository;
      workItems: SchedulerWorkItemRepository;
      projectConfigs: SchedulerProjectConfigRepository;
    },
  ) {}

  async discoverForProgram(programId: string): Promise<MaterializeResult> {
    const program = await this.deps.programs.getById(programId);
    if (!program) {
      return { created: [], reused: [] };
    }
    const kinds = candidateProgramWorkKinds(program.status, program.paused);
    const created: SchedulerWorkItem[] = [];
    const reused: SchedulerWorkItem[] = [];
    const plan = await this.deps.plans.getLatest(programId);
    const approval = plan
      ? await this.findApproved(program, plan)
      : null;
    const config = await this.deps.projectConfigs.getByProjectId(
      program.projectId,
    );
    const weight = config?.weight ?? 1;
    const priorityClass = config?.defaultPriorityClass ?? "NORMAL";

    for (const workKind of kinds) {
      const bindingHash = programWorkBindingHash({
        workKind,
        programId: program.programId,
        programVersion: program.programVersion,
        delegationEnvelopeHash:
          program.authorityFreeze.delegationEnvelopeHash,
        policyBundleHash: program.authorityFreeze.policyBundleHash,
        capabilitySetFingerprint:
          program.authorityFreeze.capabilitySetFingerprint,
        ...(plan
          ? {
              programPlanVersion: plan.programPlanVersion,
              programPlanHash: plan.programPlanHash,
            }
          : {}),
        ...(approval
          ? {
              materializationSubjectHash: approval.subjectHash,
              budgetAllocationFingerprint:
                approval.budgetAllocationFingerprint,
            }
          : {}),
      });
      const logicalIdentityKey = workLogicalIdentityKey({
        runId: program.programId,
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
        projectId: program.projectId,
        runId: program.programId,
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

  async discoverBatch(programIds: readonly string[]): Promise<MaterializeResult> {
    const created: SchedulerWorkItem[] = [];
    const reused: SchedulerWorkItem[] = [];
    for (const id of programIds) {
      const result = await this.discoverForProgram(id);
      created.push(...result.created);
      reused.push(...result.reused);
    }
    return { created, reused };
  }

  private async findApproved(
    program: Program,
    plan: ProgramPlan,
  ): Promise<ProgramMaterializationApproval | null> {
    const approvalId = `pma_${program.programId}_${plan.programPlanVersion}`;
    const approval =
      await this.deps.materializationApprovals.getById(approvalId);
    return approval?.status === "APPROVED" ? approval : null;
  }
}

/** Convenience for allocation fingerprint from a plan. */
export function planBudgetAllocationFingerprint(plan: ProgramPlan): string {
  return budgetAllocationFingerprint(
    plan.nodes.map((n) => ({ nodeId: n.nodeId, amount: n.requestedBudget })),
  );
}
