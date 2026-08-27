import type { DecisionContext } from "./context.js";
import type { DecisionPolicyCandidate } from "./policy.js";
import type { DecisionPolicyState } from "./policy-state.js";
import type { DecisionPolicyEvaluation } from "./evaluation.js";
import type { DecisionPolicyComparison } from "./comparison.js";
import type {
  DecisionPolicyApprovalRecord,
  DecisionPolicyApprovalRequest,
  DecisionPolicyActivationRecord,
  DecisionPolicyActivationRequest,
} from "./authority.js";
import type { DecisionStateSnapshot } from "./snapshot.js";
import type {
  DecisionOverrideRecord,
  DecisionPolicyEvidenceGap,
  DecisionPolicyPerformanceRecord,
  DecisionPolicyRevisionCandidate,
  DecisionPolicyShadowEvaluation,
  DecisionRecommendation,
  ShadowDecisionRecord,
} from "./shadow-recommendation.js";

export interface DecisionContextRepository {
  getById(decisionContextId: string): Promise<DecisionContext | null>;
  save(context: DecisionContext): Promise<DecisionContext>;
}

export interface DecisionPolicyCandidateRepository {
  getById(decisionPolicyId: string): Promise<DecisionPolicyCandidate | null>;
  getByIdVersion(
    decisionPolicyId: string,
    version: number,
  ): Promise<DecisionPolicyCandidate | null>;
  save(policy: DecisionPolicyCandidate): Promise<DecisionPolicyCandidate>;
  transition(
    decisionPolicyId: string,
    fromStatus: DecisionPolicyState,
    expectedRevision: number,
    toStatus: DecisionPolicyState,
    updatedAt: string,
    patch?: Partial<DecisionPolicyCandidate>,
  ): Promise<DecisionPolicyCandidate>;
  listByStates(
    states: readonly DecisionPolicyState[],
  ): Promise<DecisionPolicyCandidate[]>;
}

export interface DecisionPolicyEvaluationRepository {
  save(evaluation: DecisionPolicyEvaluation): Promise<DecisionPolicyEvaluation>;
  getById(id: string): Promise<DecisionPolicyEvaluation | null>;
  getLatestByPolicy(
    decisionPolicyId: string,
  ): Promise<DecisionPolicyEvaluation | null>;
}

export interface DecisionPolicyComparisonRepository {
  save(comparison: DecisionPolicyComparison): Promise<DecisionPolicyComparison>;
  getById(id: string): Promise<DecisionPolicyComparison | null>;
}

export interface DecisionPolicyApprovalRequestRepository {
  save(
    request: DecisionPolicyApprovalRequest,
  ): Promise<DecisionPolicyApprovalRequest>;
  getById(id: string): Promise<DecisionPolicyApprovalRequest | null>;
  getLatestByPolicy(
    decisionPolicyId: string,
  ): Promise<DecisionPolicyApprovalRequest | null>;
}

export interface DecisionPolicyApprovalRecordRepository {
  save(
    record: DecisionPolicyApprovalRecord,
  ): Promise<DecisionPolicyApprovalRecord>;
  getById(id: string): Promise<DecisionPolicyApprovalRecord | null>;
}

export interface DecisionPolicyShadowRecordRepository {
  save(record: ShadowDecisionRecord): Promise<ShadowDecisionRecord>;
  listByPolicy(decisionPolicyId: string): Promise<ShadowDecisionRecord[]>;
}

export interface DecisionPolicyShadowEvaluationRepository {
  save(
    evaluation: DecisionPolicyShadowEvaluation,
  ): Promise<DecisionPolicyShadowEvaluation>;
  getById(id: string): Promise<DecisionPolicyShadowEvaluation | null>;
  getLatestByPolicy(
    decisionPolicyId: string,
  ): Promise<DecisionPolicyShadowEvaluation | null>;
}

export interface DecisionPolicyActivationRequestRepository {
  save(
    request: DecisionPolicyActivationRequest,
  ): Promise<DecisionPolicyActivationRequest>;
  getById(id: string): Promise<DecisionPolicyActivationRequest | null>;
  getLatestByPolicy(
    decisionPolicyId: string,
  ): Promise<DecisionPolicyActivationRequest | null>;
}

export interface DecisionPolicyActivationRecordRepository {
  save(
    record: DecisionPolicyActivationRecord,
  ): Promise<DecisionPolicyActivationRecord>;
  getById(id: string): Promise<DecisionPolicyActivationRecord | null>;
  getActiveByPolicy(
    decisionPolicyId: string,
  ): Promise<DecisionPolicyActivationRecord | null>;
}

export interface DecisionStateSnapshotRepository {
  save(snapshot: DecisionStateSnapshot): Promise<DecisionStateSnapshot>;
  getById(id: string): Promise<DecisionStateSnapshot | null>;
  getByHash(snapshotHash: string): Promise<DecisionStateSnapshot | null>;
}

export interface DecisionRecommendationRepository {
  save(
    recommendation: DecisionRecommendation,
  ): Promise<DecisionRecommendation>;
  getById(id: string): Promise<DecisionRecommendation | null>;
  findByIdentityHash(
    recommendationHash: string,
  ): Promise<DecisionRecommendation | null>;
}

export interface DecisionOverrideRecordRepository {
  save(record: DecisionOverrideRecord): Promise<DecisionOverrideRecord>;
  listByRecommendation(
    recommendationId: string,
  ): Promise<DecisionOverrideRecord[]>;
}

export interface DecisionPolicyPerformanceRecordRepository {
  save(
    record: DecisionPolicyPerformanceRecord,
  ): Promise<DecisionPolicyPerformanceRecord>;
  listByPolicy(
    decisionPolicyId: string,
  ): Promise<DecisionPolicyPerformanceRecord[]>;
}

export interface DecisionPolicyRevisionCandidateRepository {
  save(
    candidate: DecisionPolicyRevisionCandidate,
  ): Promise<DecisionPolicyRevisionCandidate>;
  listBySourcePolicy(
    sourcePolicyId: string,
  ): Promise<DecisionPolicyRevisionCandidate[]>;
}

export interface DecisionPolicyEvidenceGapRepository {
  save(gap: DecisionPolicyEvidenceGap): Promise<DecisionPolicyEvidenceGap>;
}

export interface DecisionPolicyUsageSnapshot {
  synthesisCalls: number;
  evaluations: number;
  shadowRecords: number;
  recommendations: number;
  recordRevision: number;
  updatedAt: string;
}

export interface DecisionPolicyUsageLedgerRepository {
  get(decisionPolicyId: string): Promise<DecisionPolicyUsageSnapshot | null>;
  save(
    decisionPolicyId: string,
    snapshot: DecisionPolicyUsageSnapshot,
  ): Promise<DecisionPolicyUsageSnapshot>;
}
