import type { PromotedPrecedent } from "../domain/memory/precedent.js";
import type { RetrievedPrecedentContext } from "../domain/memory/result.js";
import type { PromotedPrecedentRepository } from "./promoted-precedent-repository.js";
import type { PrecedentContradictionRepository } from "./contradiction-repository.js";
import type { LearningLedgerRepository } from "./ledger-repository.js";
import type { MemoryIdentityGenerator } from "./identity.js";
import { PrecedentIntegrityService } from "./integrity.js";
import { hashCanonical } from "../ingestion/hashing.js";

export interface PrecedentRetrievalQuery {
  projectId: string;
  environment?: string;
  actionTypes?: readonly string[];
  capabilityIds?: readonly string[];
  objectiveText?: string;
  currentRepositoryFingerprint?: string;
}

export interface PrecedentRetrievalBudget {
  maximumPrecedentsPerPlanningRun: number;
  maximumPrecedentCharacters: number;
  maximumPrecedentEvidenceRefs: number;
}

export const DEFAULT_RETRIEVAL_BUDGET: PrecedentRetrievalBudget = {
  maximumPrecedentsPerPlanningRun: 8,
  maximumPrecedentCharacters: 12_000,
  maximumPrecedentEvidenceRefs: 32,
};

export interface PrecedentRetrievalResult {
  precedents: RetrievedPrecedentContext[];
  retrievalContextFingerprint: string;
  excludedPrecedentIds: string[];
}

/**
 * Exact applicability filters before deterministic ranking. Top-K bounded.
 * Precedents are ADVISORY_PRECEDENT only — never SYSTEM_AUTHORITY.
 */
export class PrecedentRetriever {
  constructor(
    private readonly deps: {
      precedents: PromotedPrecedentRepository;
      contradictions: PrecedentContradictionRepository;
      integrity: PrecedentIntegrityService;
      ledger: LearningLedgerRepository;
      identities: MemoryIdentityGenerator;
      nowIso: () => string;
      budget?: PrecedentRetrievalBudget;
    },
  ) {}

  async retrieve(
    query: PrecedentRetrievalQuery,
  ): Promise<PrecedentRetrievalResult> {
    const budget = this.deps.budget ?? DEFAULT_RETRIEVAL_BUDGET;
    const active = await this.deps.precedents.listActiveByProject(
      query.projectId,
    );
    const excluded: string[] = [];
    const filtered: PromotedPrecedent[] = [];

    for (const precedent of active) {
      const integrity = await this.deps.integrity.check(precedent);
      if (!integrity.ok) {
        excluded.push(precedent.precedentId);
        continue;
      }
      if (!this.matchesApplicability(precedent, query)) {
        excluded.push(precedent.precedentId);
        continue;
      }
      filtered.push(precedent);
    }

    const ranked = [...filtered].sort((a, b) => {
      const scoreDiff =
        this.score(b, query) - this.score(a, query);
      if (scoreDiff !== 0) {
        return scoreDiff;
      }
      const idCmp = a.precedentId.localeCompare(b.precedentId);
      if (idCmp !== 0) {
        return idCmp;
      }
      return a.version - b.version;
    });

    const selected: RetrievedPrecedentContext[] = [];
    let usedChars = 0;
    let usedEvidenceRefs = 0;

    for (const precedent of ranked) {
      if (selected.length >= budget.maximumPrecedentsPerPlanningRun) {
        excluded.push(precedent.precedentId);
        continue;
      }
      if (usedChars + precedent.statement.length > budget.maximumPrecedentCharacters) {
        excluded.push(precedent.precedentId);
        continue;
      }
      const evidenceCount = precedent.provenance.supportingEvidenceRefs.length;
      if (
        usedEvidenceRefs + evidenceCount >
        budget.maximumPrecedentEvidenceRefs
      ) {
        excluded.push(precedent.precedentId);
        continue;
      }

      const contradictions = await this.deps.contradictions.listForPrecedent(
        precedent.precedentId,
      );
      const openHard = contradictions.find(
        (c) =>
          c.classification === "HARD_CONTRADICTION" &&
          c.resolutionStatus === "OPEN",
      );

      const ctx: RetrievedPrecedentContext = {
        precedentId: precedent.precedentId,
        precedentVersion: precedent.version,
        precedentHash: precedent.precedentHash,
        origin: precedent.origin,
        claim: precedent.claim,
        statement: precedent.statement,
        candidateType: precedent.candidateType,
        applicability: precedent.applicability,
        trustClass: precedent.trustClass,
        sourceOutcome: precedent.sourceOutcome,
        relevanceScore: this.score(precedent, query),
        relevanceMetadata: {
          ranking: "deterministic-overlap",
        },
        provenanceSummary: {
          sourceHistoricalRunRecordId:
            precedent.provenance.sourceHistoricalRunRecordId,
          runId: precedent.provenance.runId,
          outcome: precedent.provenance.outcome,
          provenanceHash: precedent.provenance.provenanceHash,
        },
        ...(openHard
          ? {
              contradictionWarning: `Open hard contradiction ${openHard.contradictionId}`,
            }
          : {}),
        label: "ADVISORY_PRECEDENT",
      };
      selected.push(ctx);
      usedChars += precedent.statement.length;
      usedEvidenceRefs += evidenceCount;
    }

    selected.sort((a, b) => a.precedentId.localeCompare(b.precedentId));
    excluded.sort((a, b) => a.localeCompare(b));

    const retrievalContextFingerprint = hashCanonical({
      projectId: query.projectId,
      environment: query.environment ?? null,
      actionTypes: [...(query.actionTypes ?? [])].sort(),
      capabilityIds: [...(query.capabilityIds ?? [])].sort(),
      currentRepositoryFingerprint:
        query.currentRepositoryFingerprint ?? null,
      selected: selected.map((p) => ({
        precedentId: p.precedentId,
        version: p.precedentVersion,
        precedentHash: p.precedentHash,
      })),
    });

    const nowIso = this.deps.nowIso();
    for (const p of selected) {
      await this.deps.ledger.append({
        eventId: this.deps.identities.nextLedgerEventId(),
        eventType: "PRECEDENT_RETRIEVED",
        projectId: query.projectId,
        precedentId: p.precedentId,
        payload: {
          version: p.precedentVersion,
          precedentHash: p.precedentHash,
          retrievalContextFingerprint,
        },
        createdAt: nowIso,
      });
    }

    return {
      precedents: selected,
      retrievalContextFingerprint,
      excludedPrecedentIds: excluded,
    };
  }

  private matchesApplicability(
    precedent: PromotedPrecedent,
    query: PrecedentRetrievalQuery,
  ): boolean {
    const app = precedent.applicability;
    if (!app.projectIds.includes(query.projectId)) {
      return false;
    }
    if (
      query.environment &&
      app.environments.length > 0 &&
      !app.environments.includes(query.environment)
    ) {
      return false;
    }
    if (
      query.actionTypes &&
      query.actionTypes.length > 0 &&
      app.actionTypes.length > 0
    ) {
      const overlap = query.actionTypes.some((a) =>
        app.actionTypes.includes(a),
      );
      if (!overlap) {
        return false;
      }
    }
    if (
      query.capabilityIds &&
      query.capabilityIds.length > 0 &&
      app.capabilityIds.length > 0
    ) {
      const overlap = query.capabilityIds.some((c) =>
        app.capabilityIds.includes(c),
      );
      if (!overlap) {
        return false;
      }
    }
    return true;
  }

  private score(
    precedent: PromotedPrecedent,
    query: PrecedentRetrievalQuery,
  ): number {
    let score = 0;
    const app = precedent.applicability;
    if (query.actionTypes) {
      for (const a of query.actionTypes) {
        if (app.actionTypes.includes(a)) {
          score += 3;
        }
      }
    }
    if (query.capabilityIds) {
      for (const c of query.capabilityIds) {
        if (app.capabilityIds.includes(c)) {
          score += 3;
        }
      }
    }
    if (
      query.environment &&
      app.environments.includes(query.environment)
    ) {
      score += 2;
    }
    if (query.objectiveText) {
      const terms = query.objectiveText
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 4);
      const hay = precedent.statement.toLowerCase();
      for (const term of terms) {
        if (hay.includes(term)) {
          score += 1;
        }
      }
    }
    if (precedent.candidateType === "FAILURE_PATTERN") {
      score += 1;
    }
    if (precedent.candidateType === "CONTAINMENT_PATTERN") {
      score += 1;
    }
    if (precedent.trustClass === "MULTI_RUN_CORROBORATED") {
      score += 2;
    }
    if (precedent.trustClass === "HUMAN_REVIEWED") {
      score += 1;
    }
    return score;
  }
}
