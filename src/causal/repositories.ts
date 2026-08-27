import type { CausalQuestion } from "./question.js";
import type { CausalGraph } from "./graph.js";
import type { CausalEvidenceReference } from "./evidence.js";
import type { CausalIdentificationAnalysis } from "./identification.js";
import type { CausalEstimate } from "./estimator.js";
import type { CausalEvidenceSynthesis } from "./synthesis.js";
import type { CausalClaimCandidate } from "./claim.js";
import type { CausalReviewRequest, CausalReviewRecord } from "./review.js";
import type { PromotedCausalClaim } from "./promotion.js";
import type {
  CausalEvidenceGap,
  DecisionModelCalibrationCandidate,
} from "./calibration.js";
import type { CausalQuestionState } from "./causal-state.js";

export interface CausalUsageSnapshot {
  graphModelCalls: number;
  modelTokens: number;
  estimators: number;
  synthesisOperations: number;
  recordRevision: number;
  updatedAt: string;
}

export interface CausalQuestionRepository {
  getById(causalQuestionId: string): Promise<CausalQuestion | null>;
  save(question: CausalQuestion): Promise<CausalQuestion>;
  transition(
    causalQuestionId: string,
    fromStatus: CausalQuestionState,
    expectedRevision: number,
    toStatus: CausalQuestionState,
    updatedAt: string,
    patch?: Partial<CausalQuestion>,
  ): Promise<CausalQuestion>;
  listByStates(
    states: readonly CausalQuestionState[],
  ): Promise<CausalQuestion[]>;
  findByIdempotencyKey(key: string): Promise<CausalQuestion | null>;
}

export interface CausalGraphRepository {
  save(graph: CausalGraph): Promise<CausalGraph>;
  getLatestByQuestion(causalQuestionId: string): Promise<CausalGraph | null>;
  getByIdVersion(
    causalGraphId: string,
    version: number,
  ): Promise<CausalGraph | null>;
}

export interface CausalEvidenceReferenceRepository {
  save(ref: CausalEvidenceReference): Promise<CausalEvidenceReference>;
  listByQuestion(causalQuestionId: string): Promise<CausalEvidenceReference[]>;
}

export interface CausalIdentificationAnalysisRepository {
  save(
    analysis: CausalIdentificationAnalysis,
  ): Promise<CausalIdentificationAnalysis>;
  getLatestByQuestion(
    causalQuestionId: string,
  ): Promise<CausalIdentificationAnalysis | null>;
  getById(
    identificationAnalysisId: string,
  ): Promise<CausalIdentificationAnalysis | null>;
}

export interface CausalEstimateRepository {
  save(estimate: CausalEstimate): Promise<CausalEstimate>;
  listByQuestion(causalQuestionId: string): Promise<CausalEstimate[]>;
  getById(causalEstimateId: string): Promise<CausalEstimate | null>;
}

export interface CausalEvidenceSynthesisRepository {
  save(synthesis: CausalEvidenceSynthesis): Promise<CausalEvidenceSynthesis>;
  getLatestByQuestion(
    causalQuestionId: string,
  ): Promise<CausalEvidenceSynthesis | null>;
}

export interface CausalClaimCandidateRepository {
  save(claim: CausalClaimCandidate): Promise<CausalClaimCandidate>;
  getLatestByQuestion(
    causalQuestionId: string,
  ): Promise<CausalClaimCandidate | null>;
  getById(claimId: string): Promise<CausalClaimCandidate | null>;
}

export interface CausalReviewRequestRepository {
  save(request: CausalReviewRequest): Promise<CausalReviewRequest>;
  getById(reviewRequestId: string): Promise<CausalReviewRequest | null>;
  getPendingByQuestion(
    causalQuestionId: string,
  ): Promise<CausalReviewRequest | null>;
  update(request: CausalReviewRequest): Promise<CausalReviewRequest>;
}

export interface CausalReviewRecordRepository {
  save(record: CausalReviewRecord): Promise<CausalReviewRecord>;
  getByRequest(reviewRequestId: string): Promise<CausalReviewRecord | null>;
}

export interface PromotedCausalClaimRepository {
  save(claim: PromotedCausalClaim): Promise<PromotedCausalClaim>;
  getById(promotedCausalClaimId: string): Promise<PromotedCausalClaim | null>;
  listByQuestion(causalQuestionId: string): Promise<PromotedCausalClaim[]>;
  /** Marks claim STALE without rewriting historical claim content. */
  markStale(
    promotedCausalClaimId: string,
    staleReason: string,
  ): Promise<PromotedCausalClaim>;
}

export interface DecisionModelCalibrationCandidateRepository {
  save(
    candidate: DecisionModelCalibrationCandidate,
  ): Promise<DecisionModelCalibrationCandidate>;
  listByPromotedClaim(
    promotedCausalClaimId: string,
  ): Promise<DecisionModelCalibrationCandidate[]>;
}

export interface CausalEvidenceGapRepository {
  save(gap: CausalEvidenceGap): Promise<CausalEvidenceGap>;
  listByQuestion(causalQuestionId: string): Promise<CausalEvidenceGap[]>;
}

export interface CausalUsageLedgerRepository {
  get(causalQuestionId: string): Promise<CausalUsageSnapshot | null>;
  save(
    causalQuestionId: string,
    snapshot: CausalUsageSnapshot,
    expectedRevision: number | null,
  ): Promise<CausalUsageSnapshot>;
}
