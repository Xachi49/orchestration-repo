import type { LearningCandidate } from "../domain/memory/candidate.js";
import type { PromotedPrecedent } from "../domain/memory/precedent.js";
import type {
  PrecedentPromotionDecision,
  PrecedentPromotionPolicy,
} from "../domain/memory/promotion.js";
import type { PrecedentApplicability } from "../domain/memory/applicability.js";
import { PrecedentHasher, PromotionDecisionHasher } from "./hasher.js";
import {
  PrecedentPromotionReadinessService,
} from "./promotion-readiness.js";
import type { LearningCandidateRepository } from "./candidate-repository.js";
import type { PromotedPrecedentRepository } from "./promoted-precedent-repository.js";
import type { PrecedentPromotionDecisionRepository } from "./promotion-decision-repository.js";
import type { HistoricalRunRepository } from "./historical-run-repository.js";
import type { PrecedentContradictionRepository } from "./contradiction-repository.js";
import type { LearningLedgerRepository } from "./ledger-repository.js";
import type { MemoryIdentityGenerator } from "./identity.js";
import { MemoryError } from "./errors.js";
import type { MemoryQualityFinding } from "../domain/memory/finding.js";
import type { OutcomeVerificationRepository } from "../verification/outcome-repository.js";
import { LearningClaimGroundingService } from "./grounding.js";
import {
  isAutoPromotableGrounding,
  isHumanPromoteBlockedByPartialGrounding,
  isHumanPromotableGrounding,
  isNeverPromotableGrounding,
} from "./promotion-grounding.js";
import {
  withOptionalTransaction,
  type TransactionManager,
} from "../durability/transaction.js";

export type PromotionFailpointStage =
  | "AFTER_HUMAN_DECISION"
  | "AFTER_CANDIDATE_STATE"
  | "AFTER_PRECEDENT_WRITE"
  | "AFTER_PROMOTION_LEDGER";

export interface PromotionFailpoint {
  hit(stage: PromotionFailpointStage): Promise<void>;
}

export interface PrecedentPromotionServiceDeps {
  readiness: PrecedentPromotionReadinessService;
  candidates: LearningCandidateRepository;
  precedents: PromotedPrecedentRepository;
  decisions: PrecedentPromotionDecisionRepository;
  historicalRuns: HistoricalRunRepository;
  contradictions: PrecedentContradictionRepository;
  ledger: LearningLedgerRepository;
  identities: MemoryIdentityGenerator;
  policy: PrecedentPromotionPolicy;
  nowIso: () => string;
  outcomes?: OutcomeVerificationRepository;
  transactions?: TransactionManager;
  promotionFailpoint?: PromotionFailpoint;
}

export interface PromotionAttemptResult {
  promoted?: PromotedPrecedent;
  reviewRequired: boolean;
  rejected: boolean;
  findings: MemoryQualityFinding[];
  readinessStatus: string;
}

/**
 * Promotion authority lives here — LearningModel NEVER promotes.
 * Callers cannot POST a PromotedPrecedent directly.
 */
export class PrecedentPromotionService {
  private readonly hasher = new PrecedentHasher();
  private readonly decisionHasher = new PromotionDecisionHasher();
  private readonly grounding = new LearningClaimGroundingService();

  constructor(private readonly deps: PrecedentPromotionServiceDeps) {}

  async tryAutoPromote(
    candidate: LearningCandidate,
  ): Promise<PromotionAttemptResult> {
    const historicalRun = await this.deps.historicalRuns.getById(
      candidate.sourceHistoricalRunRecordId,
    );
    const verification = await this.loadVerification(historicalRun);
    const openContradictions = await this.deps.contradictions.listOpen();
    const readiness = await this.deps.readiness.assess({
      candidate,
      historicalRun,
      policy: this.deps.policy,
      openContradictions,
      verification,
    });

    if (readiness.status === "READY_FOR_AUTO_PROMOTION") {
      const promoted = await this.promote(candidate, {
        method: "AUTO_PROMOTE",
        trustClass: "EVIDENCE_BACKED_LOCAL",
        applicability: candidate.applicabilityProposal,
      });
      return {
        promoted,
        reviewRequired: false,
        rejected: false,
        findings: readiness.findings,
        readinessStatus: readiness.status,
      };
    }

    if (
      readiness.status === "READY_FOR_HUMAN_REVIEW" ||
      readiness.status === "CONTRADICTED"
    ) {
      await this.deps.ledger.append({
        eventId: this.deps.identities.nextLedgerEventId(),
        eventType: "PRECEDENT_PROMOTION_REQUESTED",
        runId: candidate.provenance.runId,
        projectId: candidate.projectId,
        learningCandidateId: candidate.learningCandidateId,
        payload: { readiness: readiness.status, reasons: readiness.reasons },
        createdAt: this.deps.nowIso(),
      });
      return {
        reviewRequired: true,
        rejected: false,
        findings: readiness.findings,
        readinessStatus: readiness.status,
      };
    }

    return {
      reviewRequired: false,
      rejected: false,
      findings: readiness.findings,
      readinessStatus: readiness.status,
    };
  }

  async applyHumanDecision(input: {
    learningCandidateId: string;
    reviewerId: string;
    decision: "PROMOTE" | "REJECT" | "REQUEST_NARROWER_SCOPE";
    approvedApplicability?: PrecedentApplicability;
    note?: string;
  }): Promise<{
    decision: PrecedentPromotionDecision;
    promoted?: PromotedPrecedent;
  }> {
    const candidate = await this.deps.candidates.getById(
      input.learningCandidateId,
    );
    if (!candidate) {
      throw new MemoryError(
        "CANDIDATE_NOT_FOUND",
        `Candidate not found: ${input.learningCandidateId}`,
      );
    }

    const historicalRun = await this.deps.historicalRuns.getById(
      candidate.sourceHistoricalRunRecordId,
    );
    const verification = await this.loadVerification(historicalRun);
    const liveGrounding = this.grounding.ground({
      claim: candidate.claim,
      historicalRun,
      verification,
    });
    const openContradictions = await this.deps.contradictions.listOpen();
    const readiness = await this.deps.readiness.assess({
      candidate,
      historicalRun,
      policy: this.deps.policy,
      openContradictions,
      verification,
    });

    if (input.decision === "PROMOTE") {
      if (
        isNeverPromotableGrounding(candidate.grounding.verdict) ||
        isNeverPromotableGrounding(liveGrounding.verdict) ||
        isHumanPromoteBlockedByPartialGrounding(candidate.grounding.verdict) ||
        isHumanPromoteBlockedByPartialGrounding(liveGrounding.verdict) ||
        !isHumanPromotableGrounding(candidate.grounding.verdict) ||
        !isHumanPromotableGrounding(liveGrounding.verdict)
      ) {
        throw new MemoryError(
          "PROMOTION_GROUNDING_INSUFFICIENT",
          "Human review cannot promote an insufficiently grounded claim",
          {
            stored: candidate.grounding.verdict,
            live: liveGrounding.verdict,
          },
        );
      }
      if (
        readiness.status === "INVALID_PROVENANCE" ||
        readiness.status === "INSUFFICIENT_EVIDENCE" ||
        readiness.status === "NOT_ELIGIBLE" ||
        readiness.status === "PROMOTION_GROUNDING_INSUFFICIENT"
      ) {
        throw new MemoryError(
          "PROMOTION_NOT_ELIGIBLE",
          `Cannot promote: ${readiness.status}`,
          { reasons: readiness.reasons },
        );
      }
    }

    if (
      input.decision === "REQUEST_NARROWER_SCOPE" &&
      (isNeverPromotableGrounding(candidate.grounding.verdict) ||
        isNeverPromotableGrounding(liveGrounding.verdict))
    ) {
      throw new MemoryError(
        "PROMOTION_GROUNDING_INSUFFICIENT",
        "UNGROUNDED claims cannot be repaired by scope narrowing; reject and extract a grounded candidate",
      );
    }

    const promotionDecisionId = this.deps.identities.nextPromotionDecisionId();
    const decidedAt = this.deps.nowIso();
    const draftDecision = {
      promotionDecisionId,
      learningCandidateId: input.learningCandidateId,
      candidateHash: candidate.candidateHash,
      groundingVerdict: candidate.grounding.verdict,
      reviewerId: input.reviewerId,
      decision: input.decision,
      ...(input.approvedApplicability !== undefined
        ? { approvedApplicability: input.approvedApplicability }
        : {}),
      decidedAt,
      ...(input.note !== undefined ? { note: input.note } : {}),
    };
    const decision: PrecedentPromotionDecision = {
      ...draftDecision,
      decisionHash: this.decisionHasher.hash(draftDecision),
    };

    return await withOptionalTransaction(this.deps.transactions, async () => {
      await this.deps.decisions.append(decision);
      await this.deps.promotionFailpoint?.hit("AFTER_HUMAN_DECISION");

      if (input.decision === "REJECT") {
        await this.deps.candidates.updateStatus(
          candidate.learningCandidateId,
          "REJECTED",
        );
        await this.deps.ledger.append({
          eventId: this.deps.identities.nextLedgerEventId(),
          eventType: "LEARNING_CANDIDATE_REJECTED",
          runId: candidate.provenance.runId,
          projectId: candidate.projectId,
          learningCandidateId: candidate.learningCandidateId,
          payload: { promotionDecisionId },
          createdAt: decidedAt,
        });
        return { decision };
      }

      if (input.decision === "REQUEST_NARROWER_SCOPE") {
        return { decision };
      }

      const applicability =
        input.approvedApplicability ?? candidate.applicabilityProposal;
      const promoted = await this.promoteWithinTransaction(candidate, {
        method: "HUMAN_REVIEW",
        trustClass: "HUMAN_REVIEWED",
        applicability,
        promotionDecisionId,
      });
      return { decision, promoted };
    });
  }

  private async promote(
    candidate: LearningCandidate,
    opts: {
      method: "AUTO_PROMOTE" | "HUMAN_REVIEW";
      trustClass: PromotedPrecedent["trustClass"];
      applicability: PrecedentApplicability;
      promotionDecisionId?: string;
    },
  ): Promise<PromotedPrecedent> {
    return withOptionalTransaction(this.deps.transactions, () =>
      this.promoteWithinTransaction(candidate, opts),
    );
  }

  private async promoteWithinTransaction(
    candidate: LearningCandidate,
    opts: {
      method: "AUTO_PROMOTE" | "HUMAN_REVIEW";
      trustClass: PromotedPrecedent["trustClass"];
      applicability: PrecedentApplicability;
      promotionDecisionId?: string;
    },
  ): Promise<PromotedPrecedent> {
    if (opts.method === "AUTO_PROMOTE") {
      if (candidate.origin !== "DETERMINISTIC_EXTRACTION") {
        throw new MemoryError(
          "PROMOTION_NOT_ELIGIBLE",
          "MODEL_SUGGESTION cannot auto-promote",
        );
      }
    }

    const historicalRun = await this.deps.historicalRuns.getById(
      candidate.sourceHistoricalRunRecordId,
    );
    const verification = await this.loadVerification(historicalRun);
    const liveGrounding = this.grounding.ground({
      claim: candidate.claim,
      historicalRun,
      verification,
    });
    const frozenGrounding = candidate.grounding;
    if (
      isNeverPromotableGrounding(frozenGrounding.verdict) ||
      isNeverPromotableGrounding(liveGrounding.verdict)
    ) {
      throw new MemoryError(
        "PROMOTION_GROUNDING_INSUFFICIENT",
        "UNGROUNDED claims are never promotable",
      );
    }
    if (opts.method === "AUTO_PROMOTE") {
      if (
        !isAutoPromotableGrounding(frozenGrounding.verdict) ||
        !isAutoPromotableGrounding(liveGrounding.verdict)
      ) {
        throw new MemoryError(
          "PROMOTION_NOT_ELIGIBLE",
          "Auto-promotion requires DETERMINISTICALLY_GROUNDED claim",
        );
      }
    } else if (
      !isHumanPromotableGrounding(frozenGrounding.verdict) ||
      !isHumanPromotableGrounding(liveGrounding.verdict) ||
      isHumanPromoteBlockedByPartialGrounding(frozenGrounding.verdict) ||
      isHumanPromoteBlockedByPartialGrounding(liveGrounding.verdict)
    ) {
      throw new MemoryError(
        "PROMOTION_GROUNDING_INSUFFICIENT",
        "Human review cannot promote an insufficiently grounded claim",
      );
    }

    if (opts.promotionDecisionId !== undefined) {
      const bound = await this.deps.decisions.getById(opts.promotionDecisionId);
      if (
        !bound ||
        bound.learningCandidateId !== candidate.learningCandidateId ||
        bound.candidateHash !== candidate.candidateHash
      ) {
        throw new MemoryError(
          "INVALID_PROMOTION_DECISION",
          "Promotion decision does not bind this candidate hash",
        );
      }
    }

    const existingForCandidate = (
      await this.deps.precedents.listByProject(candidate.projectId)
    ).find(
      (record) =>
        record.candidateId === candidate.learningCandidateId &&
        record.candidateHash === candidate.candidateHash &&
        record.status === "ACTIVE",
    );
    if (existingForCandidate) {
      return existingForCandidate;
    }

    const trustClass =
      opts.method === "HUMAN_REVIEW" ? "HUMAN_REVIEWED" : opts.trustClass;

    const precedentId = this.deps.identities.nextPrecedentId();
    const createdAt = this.deps.nowIso();
    const draft = {
      precedentId,
      version: 1,
      candidateId: candidate.learningCandidateId,
      candidateHash: candidate.candidateHash,
      projectId: candidate.projectId,
      candidateType: candidate.candidateType,
      origin: candidate.origin,
      claim: candidate.claim,
      grounding: frozenGrounding,
      statement: candidate.statement,
      applicability: opts.applicability,
      provenance: candidate.provenance,
      sourceOutcome: candidate.sourceOutcome,
      trustClass,
      promotionMethod: opts.method,
      ...(opts.promotionDecisionId !== undefined
        ? { promotionDecisionId: opts.promotionDecisionId }
        : {}),
      supersedesPrecedentIds: [] as string[],
    };
    const precedent: PromotedPrecedent = {
      ...draft,
      createdAt,
      precedentHash: this.hasher.hash(draft),
      status: "ACTIVE",
      label: "ADVISORY_PRECEDENT",
    };
    await this.deps.precedents.append(precedent);
    await this.deps.promotionFailpoint?.hit("AFTER_PRECEDENT_WRITE");
    await this.deps.candidates.updateStatus(
      candidate.learningCandidateId,
      "PROMOTED",
    );
    await this.deps.promotionFailpoint?.hit("AFTER_CANDIDATE_STATE");
    await this.deps.ledger.append({
      eventId: this.deps.identities.nextLedgerEventId(),
      eventType: "PRECEDENT_PROMOTED",
      runId: candidate.provenance.runId,
      projectId: candidate.projectId,
      learningCandidateId: candidate.learningCandidateId,
      precedentId: precedent.precedentId,
      payload: {
        version: precedent.version,
        precedentHash: precedent.precedentHash,
        method: opts.method,
        origin: candidate.origin,
        groundingVerdict: frozenGrounding.verdict,
        trustClass,
      },
      createdAt,
    });
    await this.deps.promotionFailpoint?.hit("AFTER_PROMOTION_LEDGER");
    return precedent;
  }

  private async loadVerification(
    historicalRun: Awaited<
      ReturnType<HistoricalRunRepository["getById"]>
    >,
  ) {
    if (!historicalRun?.outcomeVerificationId || !this.deps.outcomes) {
      return null;
    }
    return this.deps.outcomes.getById(historicalRun.outcomeVerificationId);
  }
}
