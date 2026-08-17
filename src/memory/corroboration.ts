import type { LearningCandidate } from "../domain/memory/candidate.js";
import type { PromotedPrecedent } from "../domain/memory/precedent.js";
import type { HistoricalRunRecord } from "../domain/memory/historical-run.js";
import { hashCanonical } from "../ingestion/hashing.js";
import { claimIdentityKey } from "../domain/memory/claim.js";
import { PrecedentHasher } from "./hasher.js";
import { isCorroborationEligibleGrounding } from "./promotion-grounding.js";
import type { PromotedPrecedentRepository } from "./promoted-precedent-repository.js";
import type { LearningLedgerRepository } from "./ledger-repository.js";
import type { MemoryIdentityGenerator } from "./identity.js";

export interface CorroborationStats {
  propositionKey: string;
  supportingRunIds: string[];
  supportingOutcomeIds: string[];
  independentRunCount: number;
  contradictingRunCount: number;
}

/**
 * Multi-run corroboration. Same run retries do not count twice.
 * Trust upgrade requires deterministic threshold + new version.
 */
export class PrecedentCorroborationService {
  private readonly hasher = new PrecedentHasher();

  constructor(
    private readonly deps: {
      precedents: PromotedPrecedentRepository;
      ledger: LearningLedgerRepository;
      identities: MemoryIdentityGenerator;
      nowIso: () => string;
      minimumIndependentRunsForUpgrade?: number;
    },
  ) {}

  propositionKey(
    candidate: Pick<LearningCandidate, "candidateType" | "projectId" | "claim">,
  ): string {
    return hashCanonical({
      projectId: candidate.projectId,
      candidateType: candidate.candidateType,
      claimIdentity: claimIdentityKey(candidate.claim),
    });
  }

  collect(
    propositionKey: string,
    historicalRuns: readonly HistoricalRunRecord[],
    candidates: readonly LearningCandidate[],
  ): CorroborationStats {
    const matching = candidates.filter(
      (c) =>
        this.propositionKey(c) === propositionKey &&
        isCorroborationEligibleGrounding(c.grounding.verdict),
    );
    const runIds = new Set<string>();
    const outcomeIds = new Set<string>();
    for (const c of matching) {
      runIds.add(c.provenance.runId);
      if (c.provenance.outcomeVerificationId) {
        outcomeIds.add(c.provenance.outcomeVerificationId);
      }
    }
    // Independent = unique runIds (retries of same run already collapsed by runId)
    const contradicting = historicalRuns.filter((h) => {
      if (!runIds.has(h.runId)) {
        return false;
      }
      return (
        h.outcome === "VERIFICATION_FAILED" ||
        h.outcome === "CONTAINED" ||
        h.outcome === "INCONCLUSIVE"
      );
    });
    return {
      propositionKey,
      supportingRunIds: [...runIds].sort(),
      supportingOutcomeIds: [...outcomeIds].sort(),
      independentRunCount: runIds.size,
      contradictingRunCount: contradicting.length,
    };
  }

  async maybeUpgradeTrust(
    precedent: PromotedPrecedent,
    stats: CorroborationStats,
  ): Promise<PromotedPrecedent | null> {
    if (precedent.grounding.verdict === "UNGROUNDED") {
      return null;
    }
    const threshold = this.deps.minimumIndependentRunsForUpgrade ?? 2;
    if (precedent.trustClass === "MULTI_RUN_CORROBORATED") {
      return null;
    }
    if (stats.independentRunCount < threshold) {
      return null;
    }
    if (precedent.status !== "ACTIVE") {
      return null;
    }

    // New version with upgraded trust — do not mutate old version content.
    const createdAt = this.deps.nowIso();
    const draft = {
      precedentId: precedent.precedentId,
      version: precedent.version + 1,
      candidateId: precedent.candidateId,
      candidateHash: precedent.candidateHash,
      projectId: precedent.projectId,
      candidateType: precedent.candidateType,
      origin: precedent.origin,
      claim: precedent.claim,
      grounding: precedent.grounding,
      statement: precedent.statement,
      applicability: precedent.applicability,
      provenance: precedent.provenance,
      sourceOutcome: precedent.sourceOutcome,
      trustClass: "MULTI_RUN_CORROBORATED" as const,
      promotionMethod: precedent.promotionMethod,
      ...(precedent.promotionDecisionId !== undefined
        ? { promotionDecisionId: precedent.promotionDecisionId }
        : {}),
      supersedesPrecedentIds: [
        `${precedent.precedentId}:v${precedent.version}`,
      ],
    };
    const next: PromotedPrecedent = {
      ...draft,
      createdAt,
      precedentHash: this.hasher.hash(draft),
      status: "ACTIVE",
      label: "ADVISORY_PRECEDENT",
    };
    await this.deps.precedents.updateStatus(
      precedent.precedentId,
      precedent.version,
      "SUPERSEDED",
    );
    await this.deps.precedents.append(next);
    await this.deps.ledger.append({
      eventId: this.deps.identities.nextLedgerEventId(),
      eventType: "TRUST_CLASS_UPGRADED",
      projectId: precedent.projectId,
      precedentId: precedent.precedentId,
      payload: {
        fromVersion: precedent.version,
        toVersion: next.version,
        independentRunCount: stats.independentRunCount,
      },
      createdAt,
    });
    await this.deps.ledger.append({
      eventId: this.deps.identities.nextLedgerEventId(),
      eventType: "PRECEDENT_SUPERSEDED",
      projectId: precedent.projectId,
      precedentId: precedent.precedentId,
      payload: {
        supersededVersion: precedent.version,
        supersedingVersion: next.version,
      },
      createdAt,
    });
    return next;
  }
}
