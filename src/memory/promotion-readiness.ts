import type { LearningCandidate } from "../domain/memory/candidate.js";
import type { HistoricalRunRecord } from "../domain/memory/historical-run.js";
import type {
  PrecedentPromotionPolicy,
  PrecedentPromotionReadinessStatus,
} from "../domain/memory/promotion.js";
import type { PrecedentContradictionRecord } from "../domain/memory/contradiction.js";
import type { MemoryQualityFinding } from "../domain/memory/finding.js";
import type { OutcomeVerificationRecord } from "../domain/verification/record.js";
import { CandidateHasher, ProvenanceHasher } from "./hasher.js";
import {
  containsAuthorityLikeLanguage,
  isCandidateTypeEligibleForOutcome,
} from "./extraction.js";
import type { MemoryIdentityGenerator } from "./identity.js";
import type { VerificationEvidenceRepository } from "../verification/evidence-repository.js";
import { LearningClaimGroundingService } from "./grounding.js";
import {
  isAutoPromotableGrounding,
  isNeverPromotableGrounding,
} from "./promotion-grounding.js";

export interface PromotionReadinessResult {
  status: PrecedentPromotionReadinessStatus;
  reasons: string[];
  findings: MemoryQualityFinding[];
}

const RISK_ORDER = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;

function riskAtMost(
  actual: (typeof RISK_ORDER)[number],
  max: (typeof RISK_ORDER)[number],
): boolean {
  return RISK_ORDER.indexOf(actual) <= RISK_ORDER.indexOf(max);
}

export interface PrecedentPromotionReadinessServiceDeps {
  identities: MemoryIdentityGenerator;
  evidence?: VerificationEvidenceRepository;
  nowIso: () => string;
}

/**
 * Deterministic promotion readiness. LearningModel cannot satisfy this gate.
 */
export class PrecedentPromotionReadinessService {
  private readonly candidateHasher = new CandidateHasher();
  private readonly provenanceHasher = new ProvenanceHasher();
  private readonly grounding = new LearningClaimGroundingService();

  constructor(private readonly deps: PrecedentPromotionReadinessServiceDeps) {}

  async assess(input: {
    candidate: LearningCandidate;
    historicalRun: HistoricalRunRecord | null;
    policy: PrecedentPromotionPolicy;
    openContradictions: readonly PrecedentContradictionRecord[];
    verification?: OutcomeVerificationRecord | null | undefined;
    resourceLedger?:
      | Readonly<Record<string, string | number | boolean>>
      | null
      | undefined;
  }): Promise<PromotionReadinessResult> {
    const reasons: string[] = [];
    const findings: MemoryQualityFinding[] = [];
    const nowIso = this.deps.nowIso();
    const { candidate, historicalRun, policy } = input;

    if (!historicalRun) {
      findings.push({
        findingId: this.deps.identities.nextFindingId(),
        category: "WEAK_PROVENANCE",
        severity: "BLOCKING",
        message: "Missing source historical run record",
        relatedCandidateId: candidate.learningCandidateId,
        createdAt: nowIso,
      });
      return { status: "INVALID_PROVENANCE", reasons: ["missing historical run"], findings };
    }

    const expectedProvHash = this.provenanceHasher.hash({
      sourceHistoricalRunRecordId:
        candidate.provenance.sourceHistoricalRunRecordId,
      runId: candidate.provenance.runId,
      ...(candidate.provenance.planHash !== undefined
        ? { planHash: candidate.provenance.planHash }
        : {}),
      ...(candidate.provenance.outcomeVerificationId !== undefined
        ? { outcomeVerificationId: candidate.provenance.outcomeVerificationId }
        : {}),
      outcome: candidate.provenance.outcome,
      ...(candidate.provenance.repositoryFingerprint !== undefined
        ? { repositoryFingerprint: candidate.provenance.repositoryFingerprint }
        : {}),
      ...(candidate.provenance.policyBundleHash !== undefined
        ? { policyBundleHash: candidate.provenance.policyBundleHash }
        : {}),
      ...(candidate.provenance.capabilitySetFingerprint !== undefined
        ? {
            capabilitySetFingerprint:
              candidate.provenance.capabilitySetFingerprint,
          }
        : {}),
      supportingEvidenceRefs: candidate.provenance.supportingEvidenceRefs,
      supportingFindingRefs: candidate.provenance.supportingFindingRefs,
    });
    if (expectedProvHash !== candidate.provenance.provenanceHash) {
      findings.push({
        findingId: this.deps.identities.nextFindingId(),
        category: "WEAK_PROVENANCE",
        severity: "BLOCKING",
        message: "Provenance hash mismatch",
        relatedCandidateId: candidate.learningCandidateId,
        createdAt: nowIso,
      });
      return {
        status: "INVALID_PROVENANCE",
        reasons: ["tampered provenance hash"],
        findings,
      };
    }

    const expectedCandHash = this.candidateHasher.hash({
      learningCandidateId: candidate.learningCandidateId,
      sourceHistoricalRunRecordId: candidate.sourceHistoricalRunRecordId,
      projectId: candidate.projectId,
      candidateType: candidate.candidateType,
      origin: candidate.origin,
      claim: candidate.claim,
      statement: candidate.statement,
      applicabilityProposal: candidate.applicabilityProposal,
      provenance: candidate.provenance,
      supportingEvidenceRefs: candidate.supportingEvidenceRefs,
      supportingFindingRefs: candidate.supportingFindingRefs,
      sourceOutcome: candidate.sourceOutcome,
      confidenceClass: candidate.confidenceClass,
      riskClass: candidate.riskClass,
      containsAuthorityLikeLanguage: candidate.containsAuthorityLikeLanguage,
    });
    if (expectedCandHash !== candidate.candidateHash) {
      return {
        status: "NOT_ELIGIBLE",
        reasons: ["candidate hash mismatch"],
        findings,
      };
    }

    if (
      candidate.provenance.sourceHistoricalRunRecordId !==
      historicalRun.historicalRunRecordId
    ) {
      return {
        status: "INVALID_PROVENANCE",
        reasons: ["provenance source mismatch"],
        findings,
      };
    }

    if (this.deps.evidence) {
      for (const ref of candidate.supportingEvidenceRefs) {
        const ev = await this.deps.evidence.getById(ref);
        if (!ev) {
          findings.push({
            findingId: this.deps.identities.nextFindingId(),
            category: "WEAK_PROVENANCE",
            severity: "BLOCKING",
            message: `Missing evidence ref: ${ref}`,
            relatedCandidateId: candidate.learningCandidateId,
            createdAt: nowIso,
          });
          return {
            status: "INSUFFICIENT_EVIDENCE",
            reasons: [`missing evidence ${ref}`],
            findings,
          };
        }
      }
    }

    if (
      candidate.supportingEvidenceRefs.length < policy.minimumEvidenceCount
    ) {
      return {
        status: "INSUFFICIENT_EVIDENCE",
        reasons: ["below minimum evidence count"],
        findings,
      };
    }

    if (
      !isCandidateTypeEligibleForOutcome(
        candidate.candidateType,
        candidate.sourceOutcome,
      )
    ) {
      reasons.push("candidate type incompatible with outcome");
      return { status: "NOT_ELIGIBLE", reasons, findings };
    }

    if (candidate.candidateType === "SUCCESS_PATTERN") {
      if (candidate.sourceOutcome !== "VERIFIED_SUCCESS") {
        reasons.push("SUCCESS_PATTERN requires VERIFIED_SUCCESS");
        return { status: "NOT_ELIGIBLE", reasons, findings };
      }
    }

    if (
      !policy.allowedCandidateTypes.includes(candidate.candidateType) ||
      !policy.minimumOutcomeQuality.includes(candidate.sourceOutcome)
    ) {
      reasons.push("outside promotion policy");
      return { status: "NOT_ELIGIBLE", reasons, findings };
    }

    const grounding = this.grounding.ground({
      claim: candidate.claim,
      historicalRun,
      verification: input.verification,
      resourceLedger: input.resourceLedger,
    });
    if (isNeverPromotableGrounding(grounding.verdict)) {
      findings.push({
        findingId: this.deps.identities.nextFindingId(),
        category: "WEAK_PROVENANCE",
        severity: "BLOCKING",
        message:
          "UNGROUNDED claims are never promotable; human review is not factual evidence",
        relatedCandidateId: candidate.learningCandidateId,
        createdAt: nowIso,
      });
      return {
        status: "PROMOTION_GROUNDING_INSUFFICIENT",
        reasons: ["UNGROUNDED is never promotable", ...grounding.reasons],
        findings,
      };
    }
    if (!isAutoPromotableGrounding(grounding.verdict)) {
      findings.push({
        findingId: this.deps.identities.nextFindingId(),
        category: "WEAK_PROVENANCE",
        severity: "WARNING",
        message: `Claim grounding ${grounding.verdict} is not auto-promotable`,
        relatedCandidateId: candidate.learningCandidateId,
        createdAt: nowIso,
      });
      return {
        status: "READY_FOR_HUMAN_REVIEW",
        reasons: [`claim grounding ${grounding.verdict}`, ...grounding.reasons],
        findings,
      };
    }

    if (
      candidate.containsAuthorityLikeLanguage ||
      containsAuthorityLikeLanguage(candidate.statement)
    ) {
      findings.push({
        findingId: this.deps.identities.nextFindingId(),
        category: "AUTHORITY_LIKE_LANGUAGE",
        severity: "BLOCKING",
        message: "Authority-like language blocks auto-promotion",
        relatedCandidateId: candidate.learningCandidateId,
        createdAt: nowIso,
      });
      return {
        status: "READY_FOR_HUMAN_REVIEW",
        reasons: ["authority-like language"],
        findings,
      };
    }

    const scope = candidate.applicabilityProposal.scopeClass;
    if (scope === "GLOBAL_ADVISORY" || scope === "PROJECT_CLASS") {
      findings.push({
        findingId: this.deps.identities.nextFindingId(),
        category: "OVERGENERALIZED_SCOPE",
        severity: "WARNING",
        message: `Scope ${scope} requires human review`,
        relatedCandidateId: candidate.learningCandidateId,
        createdAt: nowIso,
      });
      return {
        status: "READY_FOR_HUMAN_REVIEW",
        reasons: [`scope ${scope} requires review`],
        findings,
      };
    }

    if (policy.requiresHumanReviewForScopeClasses.includes(scope)) {
      return {
        status: "READY_FOR_HUMAN_REVIEW",
        reasons: [`policy requires review for ${scope}`],
        findings,
      };
    }

    const hard = input.openContradictions.filter(
      (c) =>
        c.classification === "HARD_CONTRADICTION" &&
        c.resolutionStatus === "OPEN" &&
        (c.candidateIds.includes(candidate.learningCandidateId) ||
          c.precedentIds.length > 0),
    );
    if (policy.requireNoUnresolvedContradictions && hard.length > 0) {
      findings.push({
        findingId: this.deps.identities.nextFindingId(),
        category: "CONTRADICTED",
        severity: "BLOCKING",
        message: "Unresolved hard contradiction",
        relatedCandidateId: candidate.learningCandidateId,
        createdAt: nowIso,
      });
      return { status: "CONTRADICTED", reasons: ["hard contradiction"], findings };
    }

    if (
      !riskAtMost(
        candidate.riskClass,
        policy.maximumRiskClassForAutoPromotion,
      )
    ) {
      return {
        status: "READY_FOR_HUMAN_REVIEW",
        reasons: [`risk ${candidate.riskClass} exceeds auto-promote max`],
        findings,
      };
    }

    if (candidate.riskClass === "HIGH" || candidate.riskClass === "CRITICAL") {
      return {
        status: "READY_FOR_HUMAN_REVIEW",
        reasons: ["high/critical risk"],
        findings,
      };
    }

    if (candidate.candidateType === "SECURITY_PATTERN") {
      return {
        status: "READY_FOR_HUMAN_REVIEW",
        reasons: ["security pattern requires review"],
        findings,
      };
    }

    if (candidate.origin !== "DETERMINISTIC_EXTRACTION") {
      findings.push({
        findingId: this.deps.identities.nextFindingId(),
        category: "WEAK_PROVENANCE",
        severity: "WARNING",
        message:
          "MODEL_SUGGESTION is not auto-promotable; valid provenance is not claim grounding",
        relatedCandidateId: candidate.learningCandidateId,
        createdAt: nowIso,
      });
      return {
        status: "READY_FOR_HUMAN_REVIEW",
        reasons: ["MODEL_SUGGESTION requires human review"],
        findings,
      };
    }

    if (!policy.allowAutoPromotion) {
      return {
        status: "READY_FOR_HUMAN_REVIEW",
        reasons: ["auto-promotion disabled"],
        findings,
      };
    }

    const autoOkOutcomes = new Set([
      "VERIFIED_SUCCESS",
      "VERIFICATION_FAILED",
      "CONTAINED",
      "INCONCLUSIVE",
      "PARTIAL_SUCCESS",
    ]);
    if (
      scope === "PROJECT_LOCAL" &&
      riskAtMost(candidate.riskClass, "LOW") &&
      autoOkOutcomes.has(candidate.sourceOutcome)
    ) {
      return { status: "READY_FOR_AUTO_PROMOTION", reasons: [], findings };
    }

    return {
      status: "READY_FOR_HUMAN_REVIEW",
      reasons: ["conservative default: human review"],
      findings,
    };
  }
}
