import type { PromotedCausalClaim } from "./promotion.js";
import type { CausalClaimCandidate } from "./claim.js";
import type { CausalEvidenceSynthesis } from "./synthesis.js";
import type { GeneralizabilityAssessment } from "./claim.js";

/**
 * Phase 9–compatible advisory retrieval view for promoted causal knowledge.
 *
 * DIRECT CAUSAL REPOSITORY READ != PLANNING MEMORY AUTHORITY.
 *
 * Planners/scenarios/programs/portfolios must not import PromotedCausalClaimRepository.
 * They may only consume this scoped advisory view through the governed memory boundary.
 */
export const CAUSAL_MEMORY_BOUNDARY = {
  directRepoReadNotPlanningAuthority:
    "DIRECT CAUSAL REPOSITORY READ != PLANNING MEMORY AUTHORITY",
  advisoryOnly: "Promoted causal knowledge is ADVISORY_PRECEDENT-class data",
  noSecondMemoryAuthority:
    "Dedicated causal storage; retrieval under Phase 9 scope/provenance rules",
} as const;

export interface CausalAdvisoryRetrievalView {
  label: "ADVISORY_CAUSAL_PRECEDENT";
  promotedCausalClaimId: string;
  claimHash: string;
  claimType: string;
  intervention: string;
  outcome: string;
  populationScope: string;
  environmentScope: string;
  timeScope: string;
  identificationStrategy: string;
  identificationStatus: string;
  generalizability: GeneralizabilityAssessment;
  uncertainty?: unknown;
  effectEstimate?: number;
  unit?: string;
  limitations: string[];
  contradictoryEvidenceRefs: string[];
  synthesisStatus: string;
  status: "ACTIVE" | "STALE";
  /** Never reduced to bare "X causes Y". */
  scopedStatement: string;
}

export function toCausalAdvisoryRetrievalView(input: {
  promoted: PromotedCausalClaim;
  claim: CausalClaimCandidate;
  synthesis: CausalEvidenceSynthesis;
  intervention: string;
  outcome: string;
}): CausalAdvisoryRetrievalView {
  const status = input.promoted.status;
  const gen = input.claim.generalizability;
  const scopedStatement = [
    `Bounded causal claim ${input.claim.claimType}`,
    `intervention=${input.intervention}`,
    `outcome=${input.outcome}`,
    `population=${input.claim.populationScope}`,
    `environment=${input.claim.environmentScope}`,
    `time=${input.claim.timeScope}`,
    `identification=${input.claim.identificationStrategy}/${input.claim.identificationStatus}`,
    `generalizability=${gen.status}`,
    `synthesis=${input.synthesis.synthesisStatus}`,
    input.claim.effectEstimate !== undefined
      ? `effectEstimate=${input.claim.effectEstimate}${input.claim.unit ? ` ${input.claim.unit}` : ""}`
      : "effectEstimate=none",
    `limitations=${input.claim.limitations.join("; ") || "none"}`,
    `contradictions=${input.claim.contradictoryEvidenceRefs.length}`,
    status === "STALE" ? "STATUS=STALE" : "STATUS=ACTIVE",
  ].join(" | ");

  return {
    label: "ADVISORY_CAUSAL_PRECEDENT",
    promotedCausalClaimId: input.promoted.promotedCausalClaimId,
    claimHash: input.promoted.claimHash,
    claimType: input.claim.claimType,
    intervention: input.intervention,
    outcome: input.outcome,
    populationScope: input.claim.populationScope,
    environmentScope: input.claim.environmentScope,
    timeScope: input.claim.timeScope,
    identificationStrategy: input.claim.identificationStrategy,
    identificationStatus: input.claim.identificationStatus,
    generalizability: gen,
    ...(input.claim.uncertainty !== undefined
      ? { uncertainty: input.claim.uncertainty }
      : {}),
    ...(input.claim.effectEstimate !== undefined
      ? { effectEstimate: input.claim.effectEstimate }
      : {}),
    ...(input.claim.unit !== undefined ? { unit: input.claim.unit } : {}),
    limitations: [...input.claim.limitations],
    contradictoryEvidenceRefs: [...input.claim.contradictoryEvidenceRefs],
    synthesisStatus: input.synthesis.synthesisStatus,
    status,
    scopedStatement,
  };
}

/**
 * Governed retrieval adapter — the only supported planning-facing causal read path.
 */
export class CausalGovernedMemoryAdapter {
  constructor(
    private readonly deps: {
      getPromoted: (
        promotedCausalClaimId: string,
      ) => Promise<PromotedCausalClaim | null>;
      getClaim: (claimId: string) => Promise<CausalClaimCandidate | null>;
      getSynthesis: (
        evidenceSynthesisId: string,
      ) => Promise<CausalEvidenceSynthesis | null>;
      resolveInterventionOutcome: (claim: CausalClaimCandidate) => Promise<{
        intervention: string;
        outcome: string;
      }>;
    },
  ) {}

  async retrieveForPlanning(input: {
    promotedCausalClaimId: string;
    requestingProjectId: string;
    requestingEnvironment: string;
  }): Promise<CausalAdvisoryRetrievalView | null> {
    const promoted = await this.deps.getPromoted(input.promotedCausalClaimId);
    if (!promoted) return null;
    const claim = await this.deps.getClaim(promoted.claimId);
    const synthesis = await this.deps.getSynthesis(
      promoted.evidenceSynthesisId,
    );
    if (!claim || !synthesis) return null;

    const { intervention, outcome } =
      await this.deps.resolveInterventionOutcome(claim);
    const view = toCausalAdvisoryRetrievalView({
      promoted,
      claim,
      synthesis,
      intervention,
      outcome,
    });

    const projectMatch = promoted.populationScope === input.requestingProjectId ||
      claim.populationScope.includes(input.requestingProjectId);
    const envMatch =
      promoted.environmentScope === input.requestingEnvironment;
    if (!projectMatch || !envMatch) {
      return {
        ...view,
        generalizability: {
          ...view.generalizability,
          status:
            view.generalizability.status === "DIRECTLY_SUPPORTED"
              ? "EXTRAPOLATED"
              : view.generalizability.status === "PARTIALLY_SUPPORTED"
                ? "EXTRAPOLATED"
                : "NOT_SUPPORTED",
          notes: [
            ...view.generalizability.notes,
            "Cross-project/out-of-scope causal precedent — advisory only",
          ],
        },
        scopedStatement: `${view.scopedStatement} | retrieval_scope=EXTRAPOLATED_OR_NOT_SUPPORTED`,
      };
    }
    return view;
  }
}
