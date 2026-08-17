import { hashCanonical } from "../ingestion/hashing.js";
import type { HistoricalRunRecord } from "../domain/memory/historical-run.js";
import type { LearningCandidate } from "../domain/memory/candidate.js";
import type { PrecedentProvenance } from "../domain/memory/provenance.js";
import type { PromotedPrecedent } from "../domain/memory/precedent.js";
import type { PrecedentPromotionDecision } from "../domain/memory/promotion.js";

/**
 * Hash authoritative references and classifications.
 * Excludes display text, non-identity timestamps, absolute paths, insertion order.
 */
export class HistoricalRunRecordHasher {
  hash(
    record: Omit<HistoricalRunRecord, "recordHash" | "startedAt" | "finishedAt">,
  ): string {
    return hashCanonical({
      historicalRunRecordId: record.historicalRunRecordId,
      runId: record.runId,
      projectId: record.projectId,
      objectiveId: record.objectiveId,
      objectiveVersion: record.objectiveVersion,
      objectiveFingerprint: record.objectiveFingerprint,
      planId: record.planId ?? null,
      planVersion: record.planVersion ?? null,
      planHash: record.planHash ?? null,
      validationDecisionId: record.validationDecisionId ?? null,
      authorizationRecordId: record.authorizationRecordId ?? null,
      executionAttemptId: record.executionAttemptId ?? null,
      outcomeVerificationId: record.outcomeVerificationId ?? null,
      completionRecordId: record.completionRecordId ?? null,
      outcome: record.outcome,
      runState: record.runState,
      repositoryFingerprint: record.repositoryFingerprint ?? null,
      policyBundleHash: record.policyBundleHash ?? null,
      capabilitySetFingerprint: record.capabilitySetFingerprint ?? null,
      environment: record.environment ?? null,
      actionTypes: [...record.actionTypes].sort(),
      capabilityIds: [...record.capabilityIds].sort(),
    });
  }
}

export class ProvenanceHasher {
  hash(provenance: Omit<PrecedentProvenance, "provenanceHash">): string {
    return hashCanonical({
      sourceHistoricalRunRecordId: provenance.sourceHistoricalRunRecordId,
      runId: provenance.runId,
      planHash: provenance.planHash ?? null,
      outcomeVerificationId: provenance.outcomeVerificationId ?? null,
      outcome: provenance.outcome,
      repositoryFingerprint: provenance.repositoryFingerprint ?? null,
      policyBundleHash: provenance.policyBundleHash ?? null,
      capabilitySetFingerprint: provenance.capabilitySetFingerprint ?? null,
      supportingEvidenceRefs: [...provenance.supportingEvidenceRefs].sort(),
      supportingFindingRefs: [...provenance.supportingFindingRefs].sort(),
    });
  }
}

export class CandidateHasher {
  hash(
    candidate: Omit<
      LearningCandidate,
      "candidateHash" | "createdAt" | "status" | "grounding"
    >,
  ): string {
    return hashCanonical({
      learningCandidateId: candidate.learningCandidateId,
      sourceHistoricalRunRecordId: candidate.sourceHistoricalRunRecordId,
      projectId: candidate.projectId,
      candidateType: candidate.candidateType,
      origin: candidate.origin,
      claim: {
        candidateType: candidate.claim.candidateType,
        observedOutcome: candidate.claim.observedOutcome,
        polarity: candidate.claim.polarity,
        planHash: candidate.claim.planHash ?? null,
        actionTypes: [...candidate.claim.actionTypes].sort(),
        capabilityIds: [...candidate.claim.capabilityIds].sort(),
        verificationMethods: [...candidate.claim.verificationMethods].sort(),
        criterionIds: [...candidate.claim.criterionIds].sort(),
        criterionVerdicts: [...candidate.claim.criterionVerdicts].sort(),
        findingIds: [...candidate.claim.findingIds].sort(),
        evidenceRefs: [...candidate.claim.evidenceRefs].sort(),
        containmentReason: candidate.claim.containmentReason ?? null,
        resourceObservation: candidate.claim.resourceObservation ?? null,
      },
      statement: candidate.statement,
      applicabilityProposal: candidate.applicabilityProposal,
      provenanceHash: candidate.provenance.provenanceHash,
      supportingEvidenceRefs: [...candidate.supportingEvidenceRefs].sort(),
      supportingFindingRefs: [...candidate.supportingFindingRefs].sort(),
      sourceOutcome: candidate.sourceOutcome,
      confidenceClass: candidate.confidenceClass,
      riskClass: candidate.riskClass,
      containsAuthorityLikeLanguage: candidate.containsAuthorityLikeLanguage,
    });
  }
}

export class PrecedentHasher {
  hash(
    precedent: Omit<
      PromotedPrecedent,
      "precedentHash" | "createdAt" | "status" | "label"
    >,
  ): string {
    return hashCanonical({
      precedentId: precedent.precedentId,
      version: precedent.version,
      candidateId: precedent.candidateId,
      candidateHash: precedent.candidateHash,
      projectId: precedent.projectId,
      candidateType: precedent.candidateType,
      origin: precedent.origin,
      claim: {
        candidateType: precedent.claim.candidateType,
        observedOutcome: precedent.claim.observedOutcome,
        polarity: precedent.claim.polarity,
        planHash: precedent.claim.planHash ?? null,
        actionTypes: [...precedent.claim.actionTypes].sort(),
        capabilityIds: [...precedent.claim.capabilityIds].sort(),
        verificationMethods: [...precedent.claim.verificationMethods].sort(),
        criterionIds: [...precedent.claim.criterionIds].sort(),
        criterionVerdicts: [...precedent.claim.criterionVerdicts].sort(),
        findingIds: [...precedent.claim.findingIds].sort(),
        evidenceRefs: [...precedent.claim.evidenceRefs].sort(),
        containmentReason: precedent.claim.containmentReason ?? null,
        resourceObservation: precedent.claim.resourceObservation ?? null,
      },
      groundingVerdict: precedent.grounding.verdict,
      groundingReasons: [...precedent.grounding.reasons].sort(),
      groundingMatchedFactKeys: [...precedent.grounding.matchedFactKeys].sort(),
      statement: precedent.statement,
      applicability: precedent.applicability,
      provenanceHash: precedent.provenance.provenanceHash,
      sourceOutcome: precedent.sourceOutcome,
      trustClass: precedent.trustClass,
      promotionMethod: precedent.promotionMethod,
      promotionDecisionId: precedent.promotionDecisionId ?? null,
      supersedesPrecedentIds: [...precedent.supersedesPrecedentIds].sort(),
    });
  }
}

export class PromotionDecisionHasher {
  hash(
    decision: Omit<PrecedentPromotionDecision, "decisionHash">,
  ): string {
    return hashCanonical({
      promotionDecisionId: decision.promotionDecisionId,
      learningCandidateId: decision.learningCandidateId,
      candidateHash: decision.candidateHash,
      groundingVerdict: decision.groundingVerdict,
      reviewerId: decision.reviewerId,
      decision: decision.decision,
      approvedApplicability: decision.approvedApplicability ?? null,
      decidedAt: decision.decidedAt,
    });
  }
}
