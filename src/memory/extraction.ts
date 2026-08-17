import type {
  HistoricalOutcome,
  HistoricalRunRecord,
} from "../domain/memory/historical-run.js";
import type { LearningCandidate } from "../domain/memory/candidate.js";
import type { PrecedentApplicability } from "../domain/memory/applicability.js";
import type { PrecedentProvenance } from "../domain/memory/provenance.js";
import type { OutcomeVerificationRecord } from "../domain/verification/record.js";
import {
  polarityForCandidateType,
  renderClaimStatement,
  type LearningClaim,
} from "../domain/memory/claim.js";
import { hashCanonical } from "../ingestion/hashing.js";
import { CandidateHasher, ProvenanceHasher } from "./hasher.js";
import type { MemoryIdentityGenerator } from "./identity.js";
import { LearningClaimGroundingService } from "./grounding.js";

const AUTHORITY_LIKE_PATTERNS: readonly RegExp[] = [
  /\balways\s+deploy\s+without\s+approval\b/i,
  /\bpolicy\s+can\s+be\s+ignored\b/i,
  /\bbudget\s+may\s+be\s+exceeded\b/i,
  /\bwithout\s+approval\b/i,
  /\bignore\s+policy\b/i,
  /\bbypass\s+(policy|approval|budget|capability)\b/i,
  /\bgrant\s+capability\b/i,
  /\bauthorize\s+execution\b/i,
];

export function containsAuthorityLikeLanguage(statement: string): boolean {
  return AUTHORITY_LIKE_PATTERNS.some((re) => re.test(statement));
}

/**
 * Outcome-quality gate: which candidate types are eligible for an outcome.
 */
export function eligibleCandidateTypesForOutcome(
  outcome: HistoricalOutcome,
): ReadonlySet<string> {
  switch (outcome) {
    case "VERIFIED_SUCCESS":
      return new Set([
        "SUCCESS_PATTERN",
        "RESOURCE_PATTERN",
        "VERIFICATION_PATTERN",
        "DEPENDENCY_PATTERN",
        "PROCESS_PATTERN",
      ]);
    case "PARTIAL_SUCCESS":
      return new Set([
        "FAILURE_PATTERN",
        "VERIFICATION_PATTERN",
        "PROCESS_PATTERN",
        "RESOURCE_PATTERN",
        "EVIDENCE_GAP_PATTERN",
      ]);
    case "VERIFICATION_FAILED":
      return new Set([
        "FAILURE_PATTERN",
        "VERIFICATION_PATTERN",
        "SECURITY_PATTERN",
        "PROCESS_PATTERN",
      ]);
    case "CONTAINED":
      return new Set([
        "CONTAINMENT_PATTERN",
        "FAILURE_PATTERN",
        "SECURITY_PATTERN",
        "PROCESS_PATTERN",
      ]);
    case "INCONCLUSIVE":
      return new Set(["EVIDENCE_GAP_PATTERN", "VERIFICATION_PATTERN"]);
    case "BLOCKED":
    case "REJECTED":
    case "EXPIRED":
    case "ESCALATED":
      return new Set(["PROCESS_PATTERN", "FAILURE_PATTERN"]);
    default:
      return new Set();
  }
}

export function isCandidateTypeEligibleForOutcome(
  candidateType: string,
  outcome: HistoricalOutcome,
): boolean {
  return eligibleCandidateTypesForOutcome(outcome).has(candidateType);
}

export interface LearningExtractionInput {
  historicalRun: HistoricalRunRecord;
  verification?: OutcomeVerificationRecord | null;
  nowIso: string;
}

/**
 * Deterministic candidate extraction from immutable historical records.
 * Does not promote. Does not invent POLICY_RULE candidates.
 */
export class LearningExtractionService {
  private readonly provenanceHasher = new ProvenanceHasher();
  private readonly candidateHasher = new CandidateHasher();
  private readonly grounding = new LearningClaimGroundingService();

  constructor(private readonly identities: MemoryIdentityGenerator) {}

  extract(input: LearningExtractionInput): LearningCandidate[] {
    const { historicalRun, verification, nowIso } = input;
    const candidates: LearningCandidate[] = [];
    const evidenceRefs = verification?.evidenceRefs ?? [];
    const findingRefs = (verification?.findings ?? []).map((f) => f.findingId);

    const baseApplicability = this.defaultApplicability(historicalRun);
    const provenance = this.buildProvenance(
      historicalRun,
      evidenceRefs,
      findingRefs,
    );

    const push = (
      claim: LearningClaim,
      riskClass: LearningCandidate["riskClass"] = "LOW",
    ): void => {
      if (
        !isCandidateTypeEligibleForOutcome(claim.candidateType, historicalRun.outcome)
      ) {
        return;
      }
      const statement = renderClaimStatement(claim);
      const authorityLike = containsAuthorityLikeLanguage(statement);
      const learningCandidateId = this.deterministicCandidateId(
        historicalRun.historicalRunRecordId,
        claim,
      );
      const grounding = this.grounding.ground({
        claim,
        historicalRun,
        verification,
      });
      const draft = {
        learningCandidateId,
        sourceHistoricalRunRecordId: historicalRun.historicalRunRecordId,
        projectId: historicalRun.projectId,
        candidateType: claim.candidateType,
        origin: "DETERMINISTIC_EXTRACTION" as const,
        claim,
        statement,
        applicabilityProposal: baseApplicability,
        provenance,
        supportingEvidenceRefs: [...evidenceRefs],
        supportingFindingRefs: [...findingRefs],
        sourceOutcome: historicalRun.outcome,
        confidenceClass: "MEDIUM" as const,
        riskClass: authorityLike ? ("HIGH" as const) : riskClass,
        containsAuthorityLikeLanguage: authorityLike,
      };
      const candidateHash = this.candidateHasher.hash(draft);
      candidates.push({
        ...draft,
        grounding,
        createdAt: nowIso,
        candidateHash,
        status: "CANDIDATE",
      });
    };

    const baseClaim = (
      candidateType: LearningClaim["candidateType"],
      extras: Partial<LearningClaim> = {},
    ): LearningClaim => ({
      candidateType,
      observedOutcome: historicalRun.outcome,
      polarity: polarityForCandidateType(
        candidateType,
        extras.criterionVerdicts ?? [],
      ),
      ...(historicalRun.planHash !== undefined
        ? { planHash: historicalRun.planHash }
        : {}),
      actionTypes: [...historicalRun.actionTypes].sort(),
      capabilityIds: [...historicalRun.capabilityIds].sort(),
      verificationMethods: extras.verificationMethods ?? [],
      criterionIds: extras.criterionIds ?? [],
      criterionVerdicts: extras.criterionVerdicts ?? [],
      findingIds: extras.findingIds ?? [],
      evidenceRefs: extras.evidenceRefs ?? [...evidenceRefs],
      ...(extras.containmentReason !== undefined
        ? { containmentReason: extras.containmentReason }
        : {}),
      ...(extras.resourceObservation !== undefined
        ? { resourceObservation: extras.resourceObservation }
        : {}),
    });

    switch (historicalRun.outcome) {
      case "VERIFIED_SUCCESS":
        push(baseClaim("SUCCESS_PATTERN"));
        if (verification) {
          const satisfied = verification.criterionResults.filter(
            (c) => c.verdict === "SATISFIED",
          );
          const methods = [
            ...new Set(satisfied.map((c) => c.verificationMethod)),
          ].sort();
          if (methods.length > 0) {
            push(
              baseClaim("VERIFICATION_PATTERN", {
                verificationMethods: methods,
                criterionIds: satisfied.map((c) => c.criterionId).sort(),
                criterionVerdicts: satisfied.map((c) => c.verdict),
              }),
            );
          }
        }
        break;
      case "PARTIAL_SUCCESS":
        push(
          baseClaim("FAILURE_PATTERN", {
            findingIds: [...findingRefs],
            criterionIds: (verification?.criterionResults ?? [])
              .filter((c) => c.verdict === "UNSATISFIED")
              .map((c) => c.criterionId)
              .sort(),
          }),
        );
        if (verification) {
          const unsatisfied = verification.criterionResults.filter(
            (c) => c.verdict === "UNSATISFIED",
          );
          if (unsatisfied.length > 0) {
            push(
              baseClaim("VERIFICATION_PATTERN", {
                criterionIds: unsatisfied.map((c) => c.criterionId).sort(),
                criterionVerdicts: unsatisfied.map((c) => c.verdict),
                verificationMethods: [
                  ...new Set(unsatisfied.map((c) => c.verificationMethod)),
                ].sort(),
              }),
            );
          }
        }
        break;
      case "VERIFICATION_FAILED":
        push(
          baseClaim("FAILURE_PATTERN", {
            findingIds: [...findingRefs],
            criterionIds: (verification?.criterionResults ?? [])
              .filter((c) => c.verdict === "UNSATISFIED")
              .map((c) => c.criterionId)
              .sort(),
          }),
        );
        break;
      case "CONTAINED":
        push(baseClaim("CONTAINMENT_PATTERN", { containmentReason: "CONTAINED" }), "MEDIUM");
        break;
      case "INCONCLUSIVE":
        push(baseClaim("EVIDENCE_GAP_PATTERN"));
        if (verification) {
          const inconclusive = verification.criterionResults.filter(
            (c) => c.verdict === "INCONCLUSIVE",
          );
          if (inconclusive.length > 0) {
            push(
              baseClaim("EVIDENCE_GAP_PATTERN", {
                criterionIds: inconclusive.map((c) => c.criterionId).sort(),
                criterionVerdicts: inconclusive.map((c) => c.verdict),
              }),
            );
          }
        }
        break;
      case "BLOCKED":
      case "REJECTED":
      case "EXPIRED":
      case "ESCALATED":
        push(baseClaim("PROCESS_PATTERN"));
        break;
    }

    return candidates;
  }

  private defaultApplicability(
    historicalRun: HistoricalRunRecord,
  ): PrecedentApplicability {
    return {
      scopeClass: "PROJECT_LOCAL",
      projectIds: [historicalRun.projectId],
      objectiveClasses: [],
      repositoryCharacteristics: historicalRun.repositoryFingerprint
        ? [`fingerprint:${historicalRun.repositoryFingerprint.slice(0, 12)}`]
        : [],
      actionTypes: [...historicalRun.actionTypes].sort(),
      capabilityIds: [...historicalRun.capabilityIds].sort(),
      environments: historicalRun.environment
        ? [historicalRun.environment]
        : [],
      executionModes: [],
      riskClasses: ["LOW"],
      outcomeTypes: [historicalRun.outcome],
      policyBundleCompatibility: historicalRun.policyBundleHash
        ? [historicalRun.policyBundleHash]
        : [],
      technologyTags: [],
    };
  }

  private buildProvenance(
    historicalRun: HistoricalRunRecord,
    evidenceRefs: readonly string[],
    findingRefs: readonly string[],
  ): PrecedentProvenance {
    const draft = {
      sourceHistoricalRunRecordId: historicalRun.historicalRunRecordId,
      runId: historicalRun.runId,
      ...(historicalRun.planHash !== undefined
        ? { planHash: historicalRun.planHash }
        : {}),
      ...(historicalRun.outcomeVerificationId !== undefined
        ? { outcomeVerificationId: historicalRun.outcomeVerificationId }
        : {}),
      outcome: historicalRun.outcome,
      ...(historicalRun.repositoryFingerprint !== undefined
        ? { repositoryFingerprint: historicalRun.repositoryFingerprint }
        : {}),
      ...(historicalRun.policyBundleHash !== undefined
        ? { policyBundleHash: historicalRun.policyBundleHash }
        : {}),
      ...(historicalRun.capabilitySetFingerprint !== undefined
        ? {
            capabilitySetFingerprint: historicalRun.capabilitySetFingerprint,
          }
        : {}),
      supportingEvidenceRefs: [...evidenceRefs],
      supportingFindingRefs: [...findingRefs],
    };
    return {
      ...draft,
      provenanceHash: this.provenanceHasher.hash(draft),
    };
  }

  private deterministicCandidateId(
    historicalRunRecordId: string,
    claim: LearningClaim,
  ): string {
    const digest = hashCanonical({
      historicalRunRecordId,
      candidateType: claim.candidateType,
      observedOutcome: claim.observedOutcome,
      polarity: claim.polarity,
      planHash: claim.planHash ?? null,
      actionTypes: [...claim.actionTypes].sort(),
      capabilityIds: [...claim.capabilityIds].sort(),
      verificationMethods: [...claim.verificationMethods].sort(),
      criterionIds: [...claim.criterionIds].sort(),
      findingIds: [...claim.findingIds].sort(),
      containmentReason: claim.containmentReason ?? null,
      resourceObservation: claim.resourceObservation ?? null,
    }).slice(0, 16);
    return `learn_cand_${digest}`;
  }
}
