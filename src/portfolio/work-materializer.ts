import type { Portfolio } from "./portfolio.js";
import type { PortfolioPlan } from "./plan.js";
import type { PortfolioAuthorizationRecord } from "./lineage.js";
import type { PortfolioRepository } from "./repositories.js";
import type { PortfolioPlanRepository } from "./repositories.js";
import type { PortfolioAuthorizationRecordRepository } from "./repositories.js";
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
  candidatePortfolioWorkKinds,
  portfolioWorkBindingHash,
} from "../scheduling/portfolio-discovery-map.js";
import type { MaterializeResult } from "../scheduling/service.js";

/**
 * Thin producer: materializes durable Phase 13 SchedulerWorkItems for Portfolios.
 * Does NOT execute progression — claim/fence/dispatch owns authority.
 */
export class PortfolioWorkMaterializer {
  constructor(
    private readonly deps: {
      nowIso: () => string;
      portfolios: PortfolioRepository;
      plans: PortfolioPlanRepository;
      authorizationRecords: PortfolioAuthorizationRecordRepository;
      workItems: SchedulerWorkItemRepository;
      projectConfigs: SchedulerProjectConfigRepository;
    },
  ) {}

  async discoverForPortfolio(portfolioId: string): Promise<MaterializeResult> {
    const portfolio = await this.deps.portfolios.getById(portfolioId);
    if (!portfolio) {
      return { created: [], reused: [] };
    }
    const kinds = candidatePortfolioWorkKinds(portfolio.status, portfolio.paused);
    const created: SchedulerWorkItem[] = [];
    const reused: SchedulerWorkItem[] = [];
    const plan = await this.deps.plans.getLatest(portfolioId);
    const authorization = plan
      ? await this.findApproved(portfolio, plan)
      : null;
    const config = await this.deps.projectConfigs.getByProjectId(
      portfolio.primaryProjectId,
    );
    const weight = config?.weight ?? 1;
    const priorityClass = config?.defaultPriorityClass ?? "NORMAL";

    for (const workKind of kinds) {
      const bindingHash = portfolioWorkBindingHash({
        workKind,
        portfolioId: portfolio.portfolioId,
        portfolioVersion: portfolio.portfolioVersion,
        authorizationEnvelopeHash:
          portfolio.authorityFreeze.authorizationEnvelopeHash,
        policyBundleHash: portfolio.authorityFreeze.policyBundleHash,
        capabilitySetFingerprint:
          portfolio.authorityFreeze.capabilitySetFingerprint,
        ...(plan
          ? {
              portfolioPlanVersion: plan.portfolioPlanVersion,
              portfolioPlanHash: plan.portfolioPlanHash,
            }
          : {}),
        ...(authorization
          ? {
              authorizationSubjectHash: authorization.subjectHash,
              allocationPlanHash: authorization.allocationPlanHash,
            }
          : {}),
      });
      const logicalIdentityKey = workLogicalIdentityKey({
        runId: portfolio.portfolioId,
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
        projectId: portfolio.primaryProjectId,
        runId: portfolio.portfolioId,
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
    portfolioIds: readonly string[],
  ): Promise<MaterializeResult> {
    const created: SchedulerWorkItem[] = [];
    const reused: SchedulerWorkItem[] = [];
    for (const id of portfolioIds) {
      const result = await this.discoverForPortfolio(id);
      created.push(...result.created);
      reused.push(...result.reused);
    }
    return { created, reused };
  }

  private async findApproved(
    portfolio: Portfolio,
    plan: PortfolioPlan,
  ): Promise<PortfolioAuthorizationRecord | null> {
    const record = await this.deps.authorizationRecords.getLatest(
      portfolio.portfolioId,
    );
    if (
      !record ||
      record.portfolioPlanVersion !== plan.portfolioPlanVersion ||
      record.portfolioPlanHash !== plan.portfolioPlanHash
    ) {
      return null;
    }
    return record;
  }
}
