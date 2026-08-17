import type { LearningCandidate } from "../domain/memory/candidate.js";
import type { PromotedPrecedent } from "../domain/memory/precedent.js";
import type { PrecedentContradictionRecord } from "../domain/memory/contradiction.js";
import type { PrecedentContradictionRepository } from "./contradiction-repository.js";
import type { LearningLedgerRepository } from "./ledger-repository.js";
import type { MemoryIdentityGenerator } from "./identity.js";
import { hashCanonical } from "../ingestion/hashing.js";
import { claimIdentityKey } from "../domain/memory/claim.js";

export interface PrecedentContradictionServiceDeps {
  contradictions: PrecedentContradictionRepository;
  ledger: LearningLedgerRepository;
  identities: MemoryIdentityGenerator;
  nowIso: () => string;
}

/**
 * Deterministic contradiction detection. Never silently deletes precedents.
 */
export class PrecedentContradictionService {
  constructor(private readonly deps: PrecedentContradictionServiceDeps) {}

  async detectForCandidate(
    candidate: LearningCandidate,
    activePrecedents: readonly PromotedPrecedent[],
  ): Promise<PrecedentContradictionRecord[]> {
    const created: PrecedentContradictionRecord[] = [];
    if (candidate.grounding.verdict === "UNGROUNDED") {
      return created;
    }
    const overlapping = activePrecedents.filter((p) =>
      this.applicabilityOverlaps(candidate, p),
    );

    for (const precedent of overlapping) {
      const classification = this.classify(candidate, precedent);
      if (classification === "NO_CONTRADICTION") {
        continue;
      }
      const contradictionId = `contradiction_${hashCanonical({
        candidateId: candidate.learningCandidateId,
        precedentId: precedent.precedentId,
        classification,
      }).slice(0, 16)}`;
      const existing = await this.deps.contradictions.getById(contradictionId);
      if (existing) {
        created.push(existing);
        continue;
      }
      const nowIso = this.deps.nowIso();
      const record: PrecedentContradictionRecord = {
        contradictionId,
        precedentIds: [precedent.precedentId],
        candidateIds: [candidate.learningCandidateId],
        applicabilityOverlap: this.overlapLabels(candidate, precedent),
        classification,
        supportingEvidenceRefs: [
          ...new Set([
            ...candidate.supportingEvidenceRefs,
            ...precedent.provenance.supportingEvidenceRefs,
          ]),
        ].sort(),
        detectedAt: nowIso,
        resolutionStatus: "OPEN",
      };
      await this.deps.contradictions.append(record);
      await this.deps.ledger.append({
        eventId: this.deps.identities.nextLedgerEventId(),
        eventType: "PRECEDENT_CONTRADICTION_DETECTED",
        projectId: candidate.projectId,
        learningCandidateId: candidate.learningCandidateId,
        precedentId: precedent.precedentId,
        contradictionId,
        payload: { classification },
        createdAt: nowIso,
      });
      created.push(record);
    }
    return created;
  }

  private applicabilityOverlaps(
    candidate: LearningCandidate,
    precedent: PromotedPrecedent,
  ): boolean {
    const a = candidate.applicabilityProposal;
    const b = precedent.applicability;
    const projectOverlap = a.projectIds.some((id) => b.projectIds.includes(id));
    if (!projectOverlap) {
      return false;
    }
    const envOverlap =
      a.environments.length === 0 ||
      b.environments.length === 0 ||
      a.environments.some((e) => b.environments.includes(e));
    const actionOverlap =
      a.actionTypes.length === 0 ||
      b.actionTypes.length === 0 ||
      a.actionTypes.some((t) => b.actionTypes.includes(t));
    return envOverlap && actionOverlap;
  }

  private overlapLabels(
    candidate: LearningCandidate,
    precedent: PromotedPrecedent,
  ): string[] {
    const a = candidate.applicabilityProposal;
    const b = precedent.applicability;
    const labels: string[] = [];
    for (const id of a.projectIds) {
      if (b.projectIds.includes(id)) {
        labels.push(`project:${id}`);
      }
    }
    for (const env of a.environments) {
      if (b.environments.includes(env)) {
        labels.push(`env:${env}`);
      }
    }
    for (const action of a.actionTypes) {
      if (b.actionTypes.includes(action)) {
        labels.push(`action:${action}`);
      }
    }
    return labels.sort();
  }

  private classify(
    candidate: LearningCandidate,
    precedent: PromotedPrecedent,
  ): PrecedentContradictionRecord["classification"] {
    const keyA = claimIdentityKey(candidate.claim);
    const keyB = claimIdentityKey(precedent.claim);
    if (keyA === keyB) {
      return "NO_CONTRADICTION";
    }

    const polA = candidate.claim.polarity;
    const polB = precedent.claim.polarity;
    const incompatible =
      (polA === "POSITIVE" && polB === "NEGATIVE") ||
      (polA === "NEGATIVE" && polB === "POSITIVE");

    const actionsA = new Set([
      ...candidate.claim.actionTypes,
      ...candidate.applicabilityProposal.actionTypes,
    ]);
    const actionsB = new Set([
      ...precedent.claim.actionTypes,
      ...precedent.applicability.actionTypes,
    ]);
    const sharedActions = [...actionsA].filter((x) => actionsB.has(x));
    const subjectOverlap =
      sharedActions.length > 0 ||
      (actionsA.size === 0 && actionsB.size === 0);

    if (incompatible && subjectOverlap) {
      return "HARD_CONTRADICTION";
    }
    if (incompatible) {
      return "POTENTIAL_CONTRADICTION";
    }
    return "NO_CONTRADICTION";
  }
}
