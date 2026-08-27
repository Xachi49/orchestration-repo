import { createHash } from "node:crypto";
import { z } from "zod";
import type { CausalAdvisoryRetrievalView } from "../causal/governed-memory.js";
import type { DecisionContext } from "./context.js";
import { DecisionPolicyError } from "./errors.js";

export const CAUSAL_SCOPE_ASSESSMENTS = [
  "DIRECTLY_SUPPORTED",
  "PARTIALLY_SUPPORTED",
  "EXTRAPOLATED",
  "NOT_SUPPORTED",
] as const;

export const CausalScopeAssessmentSchema = z.enum(CAUSAL_SCOPE_ASSESSMENTS);
export type CausalScopeAssessment = z.infer<typeof CausalScopeAssessmentSchema>;

/**
 * Exact governed causal knowledge bound into a Decision Policy.
 * ACTIVE status alone is not proof.
 */
export const GovernedCausalEvidenceSchema = z
  .object({
    promotedCausalClaimId: z.string().min(1),
    promotedClaimHash: z.string().min(1),
    sourceClaimHash: z.string().min(1),
    reviewRecordId: z.string().min(1),
    intervention: z.string().min(1),
    outcome: z.string().min(1),
    populationScope: z.string().min(1),
    environmentScope: z.string().min(1),
    timeScope: z.string().min(1),
    identificationStrategy: z.string().min(1),
    generalizability: z.enum([
      "DIRECTLY_SUPPORTED",
      "PARTIALLY_SUPPORTED",
      "EXTRAPOLATED",
      "NOT_SUPPORTED",
      "UNKNOWN",
    ]),
    uncertainty: z.unknown().optional(),
    limitations: z.array(z.string()).default([]),
    contradictions: z.array(z.string()).default([]),
    synthesisStatus: z.string().min(1),
    status: z.enum(["ACTIVE", "STALE", "SUPERSEDED", "MISSING"]),
  })
  .strict();

export type GovernedCausalEvidence = z.infer<
  typeof GovernedCausalEvidenceSchema
>;

export const CausalEvidenceBindingSchema = z
  .object({
    promotedCausalClaimId: z.string().min(1),
    promotedClaimHash: z.string().min(1),
    sourceClaimHash: z.string().min(1),
    reviewRecordId: z.string().min(1),
    scopeAssessment: CausalScopeAssessmentSchema,
    generalizability: z.string().min(1),
  })
  .strict();

export type CausalEvidenceBinding = z.infer<typeof CausalEvidenceBindingSchema>;

export interface CausalGovernedEvidencePort {
  resolve(input: {
    promotedCausalClaimId: string;
    requestingProjectIds: readonly string[];
    requestingEnvironment: string;
  }): Promise<GovernedCausalEvidence | null>;
}

export function governedEvidenceFromAdvisoryView(input: {
  view: CausalAdvisoryRetrievalView;
  reviewRecordId: string;
  sourceClaimHash: string;
}): GovernedCausalEvidence {
  return GovernedCausalEvidenceSchema.parse({
    promotedCausalClaimId: input.view.promotedCausalClaimId,
    promotedClaimHash: input.view.claimHash,
    sourceClaimHash: input.sourceClaimHash,
    reviewRecordId: input.reviewRecordId,
    intervention: input.view.intervention,
    outcome: input.view.outcome,
    populationScope: input.view.populationScope,
    environmentScope: input.view.environmentScope,
    timeScope: input.view.timeScope,
    identificationStrategy: input.view.identificationStrategy,
    generalizability: input.view.generalizability.status,
    ...(input.view.uncertainty !== undefined
      ? { uncertainty: input.view.uncertainty }
      : {}),
    limitations: [...input.view.limitations],
    contradictions: [...input.view.contradictoryEvidenceRefs],
    synthesisStatus: input.view.synthesisStatus,
    status: input.view.status === "STALE" ? "STALE" : "ACTIVE",
  });
}

/**
 * Compare causal evidence scope to DecisionContext.
 * Cross-project / cross-environment without transport → not DIRECTLY_SUPPORTED.
 */
export function assessCausalScopeCompatibility(input: {
  evidence: GovernedCausalEvidence;
  context: DecisionContext;
}): CausalScopeAssessment {
  const projectMatch = input.context.projectIds.some(
    (id) =>
      id === input.evidence.populationScope ||
      input.evidence.populationScope.includes(id),
  );
  const envMatch = input.context.environmentScope.includes(
    input.evidence.environmentScope,
  );
  if (input.evidence.generalizability === "NOT_SUPPORTED") {
    return "NOT_SUPPORTED";
  }
  if (!projectMatch || !envMatch) {
    if (
      input.evidence.generalizability === "EXTRAPOLATED" ||
      input.evidence.generalizability === "PARTIALLY_SUPPORTED"
    ) {
      return "EXTRAPOLATED";
    }
    return "NOT_SUPPORTED";
  }
  if (input.evidence.generalizability === "DIRECTLY_SUPPORTED") {
    return "DIRECTLY_SUPPORTED";
  }
  if (input.evidence.generalizability === "PARTIALLY_SUPPORTED") {
    return "PARTIALLY_SUPPORTED";
  }
  if (input.evidence.generalizability === "EXTRAPOLATED") {
    return "EXTRAPOLATED";
  }
  return "NOT_SUPPORTED";
}

export function assertCausalEvidenceUsableForAuthority(input: {
  evidence: GovernedCausalEvidence;
  scope: CausalScopeAssessment;
  allowPartial?: boolean;
}): void {
  if (input.evidence.status !== "ACTIVE") {
    throw new DecisionPolicyError(
      "DECISION_CAUSAL_EVIDENCE_STALE",
      `Promoted causal claim ${input.evidence.promotedCausalClaimId} is ${input.evidence.status}`,
    );
  }
  if (input.scope === "NOT_SUPPORTED") {
    throw new DecisionPolicyError(
      "DECISION_CAUSAL_EVIDENCE_NOT_SUPPORTED",
      "Causal evidence is NOT_SUPPORTED for this decision context — excluded from expected-value authority",
      { promotedCausalClaimId: input.evidence.promotedCausalClaimId },
    );
  }
  if (input.scope === "EXTRAPOLATED" && !input.allowPartial) {
    throw new DecisionPolicyError(
      "DECISION_CAUSAL_EVIDENCE_NOT_SUPPORTED",
      "EXTRAPOLATED causal evidence is not authoritative expected-value support",
      { promotedCausalClaimId: input.evidence.promotedCausalClaimId },
    );
  }
}

export function bindCausalEvidence(
  evidence: GovernedCausalEvidence,
  scope: CausalScopeAssessment,
): CausalEvidenceBinding {
  return CausalEvidenceBindingSchema.parse({
    promotedCausalClaimId: evidence.promotedCausalClaimId,
    promotedClaimHash: evidence.promotedClaimHash,
    sourceClaimHash: evidence.sourceClaimHash,
    reviewRecordId: evidence.reviewRecordId,
    scopeAssessment: scope,
    generalizability: evidence.generalizability,
  });
}

export function causalBindingsFingerprint(
  bindings: readonly CausalEvidenceBinding[],
): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        [...bindings].sort((a, b) =>
          a.promotedCausalClaimId.localeCompare(b.promotedCausalClaimId),
        ),
      ),
      "utf8",
    )
    .digest("hex");
}

export function mintGovernedCausalEvidence(input: {
  promotedCausalClaimId: string;
  projectId: string;
  environment: string;
  status?: GovernedCausalEvidence["status"];
  generalizability?: GovernedCausalEvidence["generalizability"];
  promotedClaimHash?: string;
}): GovernedCausalEvidence {
  return GovernedCausalEvidenceSchema.parse({
    promotedCausalClaimId: input.promotedCausalClaimId,
    promotedClaimHash: input.promotedClaimHash ?? `pch_${input.promotedCausalClaimId}`,
    sourceClaimHash: `sch_${input.promotedCausalClaimId}`,
    reviewRecordId: `crrrec_${input.promotedCausalClaimId}`,
    intervention: "flag",
    outcome: "conversion",
    populationScope: input.projectId,
    environmentScope: input.environment,
    timeScope: "14d",
    identificationStrategy: "RANDOMIZED_TREATMENT",
    generalizability: input.generalizability ?? "DIRECTLY_SUPPORTED",
    limitations: ["Bounded claim"],
    contradictions: [],
    synthesisStatus: "CONSISTENT",
    status: input.status ?? "ACTIVE",
  });
}

export class InMemoryCausalGovernedEvidencePort
  implements CausalGovernedEvidencePort
{
  private readonly byId = new Map<string, GovernedCausalEvidence>();

  seed(evidence: GovernedCausalEvidence): void {
    this.byId.set(
      evidence.promotedCausalClaimId,
      GovernedCausalEvidenceSchema.parse(evidence),
    );
  }

  async resolve(input: {
    promotedCausalClaimId: string;
    requestingProjectIds: readonly string[];
    requestingEnvironment: string;
  }): Promise<GovernedCausalEvidence | null> {
    void input.requestingProjectIds;
    void input.requestingEnvironment;
    return this.byId.get(input.promotedCausalClaimId) ?? null;
  }
}

/**
 * Production port: resolve exact governed causal knowledge via Phase 18
 * CausalGovernedMemoryAdapter — ACTIVE status alone is never enough.
 */
export class CausalGovernedMemoryEvidencePort
  implements CausalGovernedEvidencePort
{
  constructor(
    private readonly deps: {
      retrieve: (input: {
        promotedCausalClaimId: string;
        requestingProjectId: string;
        requestingEnvironment: string;
      }) => Promise<CausalAdvisoryRetrievalView | null>;
      getReviewAndSourceHashes: (
        promotedCausalClaimId: string,
      ) => Promise<{
        reviewRecordId: string;
        sourceClaimHash: string;
      } | null>;
    },
  ) {}

  async resolve(input: {
    promotedCausalClaimId: string;
    requestingProjectIds: readonly string[];
    requestingEnvironment: string;
  }): Promise<GovernedCausalEvidence | null> {
    const projectId = input.requestingProjectIds[0];
    if (!projectId) return null;
    const view = await this.deps.retrieve({
      promotedCausalClaimId: input.promotedCausalClaimId,
      requestingProjectId: projectId,
      requestingEnvironment: input.requestingEnvironment,
    });
    if (!view) return null;
    const hashes = await this.deps.getReviewAndSourceHashes(
      input.promotedCausalClaimId,
    );
    if (!hashes) return null;
    return governedEvidenceFromAdvisoryView({
      view,
      reviewRecordId: hashes.reviewRecordId,
      sourceClaimHash: hashes.sourceClaimHash,
    });
  }
}
