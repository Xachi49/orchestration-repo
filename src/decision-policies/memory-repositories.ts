import { parseDecisionContext, type DecisionContext } from "./context.js";
import {
  parseDecisionPolicyCandidate,
  type DecisionPolicyCandidate,
} from "./policy.js";
import { canTransitionDecisionPolicy } from "./policy-state.js";
import { DecisionPolicyError } from "./errors.js";
import {
  DecisionPolicyEvaluationSchema,
  type DecisionPolicyEvaluation,
} from "./evaluation.js";
import {
  DecisionPolicyComparisonSchema,
  type DecisionPolicyComparison,
} from "./comparison.js";
import {
  DecisionPolicyApprovalRecordSchema,
  DecisionPolicyApprovalRequestSchema,
  DecisionPolicyActivationRecordSchema,
  DecisionPolicyActivationRequestSchema,
  type DecisionPolicyApprovalRecord,
  type DecisionPolicyApprovalRequest,
  type DecisionPolicyActivationRecord,
  type DecisionPolicyActivationRequest,
} from "./authority.js";
import {
  DecisionStateSnapshotSchema,
  type DecisionStateSnapshot,
} from "./snapshot.js";
import {
  DecisionOverrideRecordSchema,
  DecisionPolicyEvidenceGapSchema,
  DecisionPolicyPerformanceRecordSchema,
  DecisionPolicyRevisionCandidateSchema,
  DecisionPolicyShadowEvaluationSchema,
  DecisionRecommendationSchema,
  ShadowDecisionRecordSchema,
  type DecisionOverrideRecord,
  type DecisionPolicyEvidenceGap,
  type DecisionPolicyPerformanceRecord,
  type DecisionPolicyRevisionCandidate,
  type DecisionPolicyShadowEvaluation,
  type DecisionRecommendation,
  type ShadowDecisionRecord,
} from "./shadow-recommendation.js";
import type {
  DecisionContextRepository,
  DecisionOverrideRecordRepository,
  DecisionPolicyActivationRecordRepository,
  DecisionPolicyActivationRequestRepository,
  DecisionPolicyApprovalRecordRepository,
  DecisionPolicyApprovalRequestRepository,
  DecisionPolicyCandidateRepository,
  DecisionPolicyComparisonRepository,
  DecisionPolicyEvaluationRepository,
  DecisionPolicyEvidenceGapRepository,
  DecisionPolicyPerformanceRecordRepository,
  DecisionPolicyRevisionCandidateRepository,
  DecisionPolicyShadowEvaluationRepository,
  DecisionPolicyShadowRecordRepository,
  DecisionPolicyUsageLedgerRepository,
  DecisionPolicyUsageSnapshot,
  DecisionRecommendationRepository,
  DecisionStateSnapshotRepository,
} from "./repositories.js";

function mapRepo<T extends { [k: string]: unknown }>(
  getId: (item: T) => string,
  parse: (raw: unknown) => T,
) {
  const byId = new Map<string, T>();
  return {
    byId,
    async getById(id: string): Promise<T | null> {
      return byId.get(id) ?? null;
    },
    async save(item: T): Promise<T> {
      const parsed = parse(item);
      byId.set(getId(parsed), parsed);
      return parsed;
    },
  };
}

export class InMemoryDecisionContextRepository
  implements DecisionContextRepository
{
  private readonly byId = new Map<string, DecisionContext>();

  async getById(id: string): Promise<DecisionContext | null> {
    return this.byId.get(id) ?? null;
  }

  async save(context: DecisionContext): Promise<DecisionContext> {
    const parsed = parseDecisionContext(context);
    this.byId.set(parsed.decisionContextId, parsed);
    return parsed;
  }
}

export class InMemoryDecisionPolicyCandidateRepository
  implements DecisionPolicyCandidateRepository
{
  private readonly byId = new Map<string, DecisionPolicyCandidate>();
  private readonly byIdVersion = new Map<string, DecisionPolicyCandidate>();

  private key(id: string, version: number): string {
    return `${id}@${version}`;
  }

  async getById(id: string): Promise<DecisionPolicyCandidate | null> {
    return this.byId.get(id) ?? null;
  }

  async getByIdVersion(
    id: string,
    version: number,
  ): Promise<DecisionPolicyCandidate | null> {
    return this.byIdVersion.get(this.key(id, version)) ?? null;
  }

  async save(policy: DecisionPolicyCandidate): Promise<DecisionPolicyCandidate> {
    const parsed = parseDecisionPolicyCandidate(policy);
    this.byId.set(parsed.decisionPolicyId, parsed);
    this.byIdVersion.set(
      this.key(parsed.decisionPolicyId, parsed.decisionPolicyVersion),
      parsed,
    );
    return parsed;
  }

  async transition(
    decisionPolicyId: string,
    fromStatus: DecisionPolicyCandidate["status"],
    expectedRevision: number,
    toStatus: DecisionPolicyCandidate["status"],
    updatedAt: string,
    patch: Partial<DecisionPolicyCandidate> = {},
  ): Promise<DecisionPolicyCandidate> {
    const existing = this.byId.get(decisionPolicyId);
    if (!existing) {
      throw new DecisionPolicyError(
        "DECISION_POLICY_NOT_FOUND",
        `Decision policy ${decisionPolicyId} missing`,
      );
    }
    if (
      existing.status !== fromStatus ||
      existing.recordRevision !== expectedRevision
    ) {
      throw new DecisionPolicyError(
        "DECISION_POLICY_STATE_CONFLICT",
        `Decision policy ${decisionPolicyId} state/revision mismatch`,
      );
    }
    if (!canTransitionDecisionPolicy(fromStatus, toStatus)) {
      throw new DecisionPolicyError(
        "INVALID_DECISION_POLICY_TRANSITION",
        `Cannot transition ${fromStatus} → ${toStatus}`,
      );
    }
    const next = parseDecisionPolicyCandidate({
      ...existing,
      ...patch,
      status: toStatus,
      updatedAt,
      recordRevision: existing.recordRevision + 1,
      policyHash: existing.policyHash,
    });
    return this.save(next);
  }

  async listByStates(
    states: readonly DecisionPolicyCandidate["status"][],
  ): Promise<DecisionPolicyCandidate[]> {
    const set = new Set(states);
    return [...this.byId.values()].filter((p) => set.has(p.status));
  }
}

export class InMemoryDecisionPolicyEvaluationRepository
  implements DecisionPolicyEvaluationRepository
{
  private readonly inner = mapRepo<DecisionPolicyEvaluation>(
    (e) => e.decisionPolicyEvaluationId,
    (r) => DecisionPolicyEvaluationSchema.parse(r),
  );
  private readonly byPolicy = new Map<string, string>();

  async getById(id: string) {
    return this.inner.getById(id);
  }

  async save(evaluation: DecisionPolicyEvaluation) {
    const saved = await this.inner.save(evaluation);
    this.byPolicy.set(saved.decisionPolicyId, saved.decisionPolicyEvaluationId);
    return saved;
  }

  async getLatestByPolicy(decisionPolicyId: string) {
    const id = this.byPolicy.get(decisionPolicyId);
    return id ? this.inner.getById(id) : null;
  }
}

export class InMemoryDecisionPolicyComparisonRepository
  implements DecisionPolicyComparisonRepository
{
  private readonly inner = mapRepo<DecisionPolicyComparison>(
    (c) => c.decisionPolicyComparisonId,
    (r) => DecisionPolicyComparisonSchema.parse(r),
  );

  async getById(id: string) {
    return this.inner.getById(id);
  }

  async save(comparison: DecisionPolicyComparison) {
    return this.inner.save(comparison);
  }
}

export class InMemoryDecisionPolicyApprovalRequestRepository
  implements DecisionPolicyApprovalRequestRepository
{
  private readonly inner = mapRepo<DecisionPolicyApprovalRequest>(
    (r) => r.decisionPolicyApprovalRequestId,
    (r) => DecisionPolicyApprovalRequestSchema.parse(r),
  );
  private readonly byPolicy = new Map<string, string>();

  async getById(id: string) {
    return this.inner.getById(id);
  }

  async save(request: DecisionPolicyApprovalRequest) {
    const saved = await this.inner.save(request);
    this.byPolicy.set(
      saved.decisionPolicyId,
      saved.decisionPolicyApprovalRequestId,
    );
    return saved;
  }

  async getLatestByPolicy(decisionPolicyId: string) {
    const id = this.byPolicy.get(decisionPolicyId);
    return id ? this.inner.getById(id) : null;
  }
}

export class InMemoryDecisionPolicyApprovalRecordRepository
  implements DecisionPolicyApprovalRecordRepository
{
  private readonly inner = mapRepo<DecisionPolicyApprovalRecord>(
    (r) => r.decisionPolicyApprovalRecordId,
    (r) => DecisionPolicyApprovalRecordSchema.parse(r),
  );

  async getById(id: string) {
    return this.inner.getById(id);
  }

  async save(record: DecisionPolicyApprovalRecord) {
    return this.inner.save(record);
  }
}

export class InMemoryDecisionPolicyShadowRecordRepository
  implements DecisionPolicyShadowRecordRepository
{
  private readonly byId = new Map<string, ShadowDecisionRecord>();
  private readonly byPolicy = new Map<string, string[]>();

  async save(record: ShadowDecisionRecord): Promise<ShadowDecisionRecord> {
    const parsed = ShadowDecisionRecordSchema.parse(record);
    this.byId.set(parsed.shadowDecisionRecordId, parsed);
    const list = this.byPolicy.get(parsed.decisionPolicyId) ?? [];
    list.push(parsed.shadowDecisionRecordId);
    this.byPolicy.set(parsed.decisionPolicyId, list);
    return parsed;
  }

  async listByPolicy(decisionPolicyId: string): Promise<ShadowDecisionRecord[]> {
    const ids = this.byPolicy.get(decisionPolicyId) ?? [];
    return ids
      .map((id) => this.byId.get(id))
      .filter((r): r is ShadowDecisionRecord => r !== undefined);
  }
}

export class InMemoryDecisionPolicyShadowEvaluationRepository
  implements DecisionPolicyShadowEvaluationRepository
{
  private readonly inner = mapRepo<DecisionPolicyShadowEvaluation>(
    (e) => e.decisionPolicyShadowEvaluationId,
    (r) => DecisionPolicyShadowEvaluationSchema.parse(r),
  );
  private readonly byPolicy = new Map<string, string>();

  async getById(id: string) {
    return this.inner.getById(id);
  }

  async save(evaluation: DecisionPolicyShadowEvaluation) {
    const saved = await this.inner.save(evaluation);
    this.byPolicy.set(
      saved.decisionPolicyId,
      saved.decisionPolicyShadowEvaluationId,
    );
    return saved;
  }

  async getLatestByPolicy(decisionPolicyId: string) {
    const id = this.byPolicy.get(decisionPolicyId);
    return id ? this.inner.getById(id) : null;
  }
}

export class InMemoryDecisionPolicyActivationRequestRepository
  implements DecisionPolicyActivationRequestRepository
{
  private readonly inner = mapRepo<DecisionPolicyActivationRequest>(
    (r) => r.decisionPolicyActivationRequestId,
    (r) => DecisionPolicyActivationRequestSchema.parse(r),
  );
  private readonly byPolicy = new Map<string, string>();

  async getById(id: string) {
    return this.inner.getById(id);
  }

  async save(request: DecisionPolicyActivationRequest) {
    const saved = await this.inner.save(request);
    this.byPolicy.set(
      saved.decisionPolicyId,
      saved.decisionPolicyActivationRequestId,
    );
    return saved;
  }

  async getLatestByPolicy(decisionPolicyId: string) {
    const id = this.byPolicy.get(decisionPolicyId);
    return id ? this.inner.getById(id) : null;
  }
}

export class InMemoryDecisionPolicyActivationRecordRepository
  implements DecisionPolicyActivationRecordRepository
{
  private readonly byId = new Map<string, DecisionPolicyActivationRecord>();
  private readonly activeByPolicy = new Map<string, string>();

  async getById(id: string) {
    return this.byId.get(id) ?? null;
  }

  async save(record: DecisionPolicyActivationRecord) {
    const parsed = DecisionPolicyActivationRecordSchema.parse(record);
    this.byId.set(parsed.decisionPolicyActivationId, parsed);
    if (parsed.status === "ACTIVE") {
      this.activeByPolicy.set(
        parsed.decisionPolicyId,
        parsed.decisionPolicyActivationId,
      );
    }
    return parsed;
  }

  async getActiveByPolicy(decisionPolicyId: string) {
    const id = this.activeByPolicy.get(decisionPolicyId);
    if (!id) return null;
    const rec = this.byId.get(id);
    return rec?.status === "ACTIVE" ? rec : null;
  }
}

export class InMemoryDecisionStateSnapshotRepository
  implements DecisionStateSnapshotRepository
{
  private readonly byId = new Map<string, DecisionStateSnapshot>();
  private readonly byHash = new Map<string, string>();

  async save(snapshot: DecisionStateSnapshot) {
    const parsed = DecisionStateSnapshotSchema.parse(snapshot);
    this.byId.set(parsed.decisionStateSnapshotId, parsed);
    this.byHash.set(parsed.snapshotHash, parsed.decisionStateSnapshotId);
    return parsed;
  }

  async getById(id: string) {
    return this.byId.get(id) ?? null;
  }

  async getByHash(snapshotHash: string) {
    const id = this.byHash.get(snapshotHash);
    return id ? (this.byId.get(id) ?? null) : null;
  }
}

export class InMemoryDecisionRecommendationRepository
  implements DecisionRecommendationRepository
{
  private readonly byId = new Map<string, DecisionRecommendation>();
  private readonly byHash = new Map<string, string>();

  async save(recommendation: DecisionRecommendation) {
    const parsed = DecisionRecommendationSchema.parse(recommendation);
    this.byId.set(parsed.decisionRecommendationId, parsed);
    this.byHash.set(parsed.recommendationHash, parsed.decisionRecommendationId);
    return parsed;
  }

  async getById(id: string) {
    return this.byId.get(id) ?? null;
  }

  async findByIdentityHash(recommendationHash: string) {
    const id = this.byHash.get(recommendationHash);
    return id ? (this.byId.get(id) ?? null) : null;
  }
}

export class InMemoryDecisionOverrideRecordRepository
  implements DecisionOverrideRecordRepository
{
  private readonly byRec = new Map<string, DecisionOverrideRecord[]>();

  async save(record: DecisionOverrideRecord) {
    const parsed = DecisionOverrideRecordSchema.parse(record);
    const list = this.byRec.get(parsed.recommendationId) ?? [];
    list.push(parsed);
    this.byRec.set(parsed.recommendationId, list);
    return parsed;
  }

  async listByRecommendation(recommendationId: string) {
    return [...(this.byRec.get(recommendationId) ?? [])];
  }
}

export class InMemoryDecisionPolicyPerformanceRecordRepository
  implements DecisionPolicyPerformanceRecordRepository
{
  private readonly byPolicy = new Map<string, DecisionPolicyPerformanceRecord[]>();

  async save(record: DecisionPolicyPerformanceRecord) {
    const parsed = DecisionPolicyPerformanceRecordSchema.parse(record);
    const list = this.byPolicy.get(parsed.decisionPolicyId) ?? [];
    list.push(parsed);
    this.byPolicy.set(parsed.decisionPolicyId, list);
    return parsed;
  }

  async listByPolicy(decisionPolicyId: string) {
    return [...(this.byPolicy.get(decisionPolicyId) ?? [])];
  }
}

export class InMemoryDecisionPolicyRevisionCandidateRepository
  implements DecisionPolicyRevisionCandidateRepository
{
  private readonly bySource = new Map<
    string,
    DecisionPolicyRevisionCandidate[]
  >();

  async save(candidate: DecisionPolicyRevisionCandidate) {
    const parsed = DecisionPolicyRevisionCandidateSchema.parse(candidate);
    const list = this.bySource.get(parsed.sourcePolicyId) ?? [];
    list.push(parsed);
    this.bySource.set(parsed.sourcePolicyId, list);
    return parsed;
  }

  async listBySourcePolicy(sourcePolicyId: string) {
    return [...(this.bySource.get(sourcePolicyId) ?? [])];
  }
}

export class InMemoryDecisionPolicyEvidenceGapRepository
  implements DecisionPolicyEvidenceGapRepository
{
  private readonly byId = new Map<string, DecisionPolicyEvidenceGap>();

  async save(gap: DecisionPolicyEvidenceGap) {
    const parsed = DecisionPolicyEvidenceGapSchema.parse(gap);
    this.byId.set(parsed.decisionPolicyEvidenceGapId, parsed);
    return parsed;
  }
}

export class InMemoryDecisionPolicyUsageLedgerRepository
  implements DecisionPolicyUsageLedgerRepository
{
  private readonly byId = new Map<string, DecisionPolicyUsageSnapshot>();

  async get(decisionPolicyId: string) {
    return this.byId.get(decisionPolicyId) ?? null;
  }

  async save(decisionPolicyId: string, snapshot: DecisionPolicyUsageSnapshot) {
    this.byId.set(decisionPolicyId, snapshot);
    return snapshot;
  }
}
