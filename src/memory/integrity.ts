import type { PromotedPrecedent } from "../domain/memory/precedent.js";
import type { HistoricalRunRecord } from "../domain/memory/historical-run.js";
import { PrecedentHasher, ProvenanceHasher } from "./hasher.js";
import { MemoryError } from "./errors.js";
import type { HistoricalRunRepository } from "./historical-run-repository.js";
import type { PrecedentContradictionRepository } from "./contradiction-repository.js";
import {
  isAutoPromotableGrounding,
  isHumanPromotableGrounding,
  isNeverPromotableGrounding,
} from "./promotion-grounding.js";

export interface IntegrityCheckResult {
  ok: boolean;
  code?: "PRECEDENT_INTEGRITY_FAILED";
  reasons: string[];
}

/**
 * Memory poisoning defense. Tampered precedents are not retrieved.
 */
export class PrecedentIntegrityService {
  private readonly precedentHasher = new PrecedentHasher();
  private readonly provenanceHasher = new ProvenanceHasher();

  constructor(
    private readonly deps: {
      historicalRuns: HistoricalRunRepository;
      contradictions: PrecedentContradictionRepository;
    },
  ) {}

  async check(precedent: PromotedPrecedent): Promise<IntegrityCheckResult> {
    const reasons: string[] = [];

    const expectedHash = this.precedentHasher.hash({
      precedentId: precedent.precedentId,
      version: precedent.version,
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
      trustClass: precedent.trustClass,
      promotionMethod: precedent.promotionMethod,
      ...(precedent.promotionDecisionId !== undefined
        ? { promotionDecisionId: precedent.promotionDecisionId }
        : {}),
      supersedesPrecedentIds: precedent.supersedesPrecedentIds,
    });
    if (expectedHash !== precedent.precedentHash) {
      reasons.push("precedent hash mismatch");
    }

    const expectedProv = this.provenanceHasher.hash({
      sourceHistoricalRunRecordId:
        precedent.provenance.sourceHistoricalRunRecordId,
      runId: precedent.provenance.runId,
      ...(precedent.provenance.planHash !== undefined
        ? { planHash: precedent.provenance.planHash }
        : {}),
      ...(precedent.provenance.outcomeVerificationId !== undefined
        ? {
            outcomeVerificationId: precedent.provenance.outcomeVerificationId,
          }
        : {}),
      outcome: precedent.provenance.outcome,
      ...(precedent.provenance.repositoryFingerprint !== undefined
        ? {
            repositoryFingerprint: precedent.provenance.repositoryFingerprint,
          }
        : {}),
      ...(precedent.provenance.policyBundleHash !== undefined
        ? { policyBundleHash: precedent.provenance.policyBundleHash }
        : {}),
      ...(precedent.provenance.capabilitySetFingerprint !== undefined
        ? {
            capabilitySetFingerprint:
              precedent.provenance.capabilitySetFingerprint,
          }
        : {}),
      supportingEvidenceRefs: precedent.provenance.supportingEvidenceRefs,
      supportingFindingRefs: precedent.provenance.supportingFindingRefs,
    });
    if (expectedProv !== precedent.provenance.provenanceHash) {
      reasons.push("provenance hash mismatch");
    }

    const historical = await this.deps.historicalRuns.getById(
      precedent.provenance.sourceHistoricalRunRecordId,
    );
    if (!historical) {
      reasons.push("missing source historical run");
    } else if (historical.outcome !== precedent.sourceOutcome) {
      reasons.push("source outcome mismatch");
    }

    if (precedent.status !== "ACTIVE") {
      reasons.push(`status ${precedent.status} not ACTIVE`);
    }

    if (
      precedent.promotionMethod === "AUTO_PROMOTE" &&
      precedent.origin !== "DETERMINISTIC_EXTRACTION"
    ) {
      reasons.push(
        "AUTO promotion from MODEL_SUGGESTION is invalid without deterministic reconstruction",
      );
    }

    if (
      precedent.promotionMethod === "AUTO_PROMOTE" &&
      !isAutoPromotableGrounding(precedent.grounding.verdict)
    ) {
      reasons.push("AUTO promotion requires DETERMINISTICALLY_GROUNDED claim");
    }

    if (
      precedent.promotionMethod === "HUMAN_REVIEW" &&
      (isNeverPromotableGrounding(precedent.grounding.verdict) ||
        !isHumanPromotableGrounding(precedent.grounding.verdict))
    ) {
      reasons.push(
        "HUMAN_REVIEWED cannot rest on an UNGROUNDED or otherwise unpromotable claim",
      );
    }

    if (
      precedent.trustClass === "HUMAN_REVIEWED" &&
      isNeverPromotableGrounding(precedent.grounding.verdict)
    ) {
      reasons.push("HUMAN_REVIEWED trust class cannot describe an UNGROUNDED claim");
    }

    if (precedent.claim.candidateType !== precedent.candidateType) {
      reasons.push("structured claim type does not match candidateType");
    }

    if (!precedent.candidateHash || precedent.candidateHash.length < 16) {
      reasons.push("missing candidateHash");
    }

    if (!precedent.origin) {
      reasons.push("missing candidate origin");
    }

    if (!precedent.claim) {
      reasons.push("missing structured claim");
    }

    if (!precedent.grounding?.verdict) {
      reasons.push("missing claim grounding");
    }

    if (!precedent.promotionMethod) {
      reasons.push("missing promotion method");
    }

    if (reasons.length > 0) {
      return {
        ok: false,
        code: "PRECEDENT_INTEGRITY_FAILED",
        reasons,
      };
    }
    return { ok: true, reasons: [] };
  }

  assertOk(result: IntegrityCheckResult): void {
    if (!result.ok) {
      throw new MemoryError(
        "PRECEDENT_INTEGRITY_FAILED",
        result.reasons.join("; "),
      );
    }
  }

  async requireValidSource(
    historicalRunRecordId: string,
  ): Promise<HistoricalRunRecord> {
    const record = await this.deps.historicalRuns.getById(historicalRunRecordId);
    if (!record) {
      throw new MemoryError(
        "PROMOTION_PROVENANCE_INVALID",
        `Historical run not found: ${historicalRunRecordId}`,
      );
    }
    return record;
  }
}
