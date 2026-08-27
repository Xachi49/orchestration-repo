import type {
  OutcomeVerificationRecord,
  OutcomeVerdict,
} from "../domain/verification/index.js";
import type { OutcomeVerificationRepository } from "../verification/outcome-repository.js";
import type { ExperimentExecutionLineage } from "./evidence.js";
import { ExperimentError } from "./errors.js";
import type { ExperimentEvidenceQuality } from "./doctrine.js";

/**
 * Narrow Phase 8 resolution for experiment evidence authority.
 * Caller-provided verification strings are never authoritative.
 */
export interface ExperimentOutcomeVerificationPort {
  resolveOutcomeVerification(
    outcomeVerificationId: string,
  ): Promise<OutcomeVerificationRecord | null>;
}

export class Phase8ExperimentOutcomeVerificationPort
  implements ExperimentOutcomeVerificationPort
{
  constructor(private readonly outcomes: OutcomeVerificationRepository) {}

  async resolveOutcomeVerification(
    outcomeVerificationId: string,
  ): Promise<OutcomeVerificationRecord | null> {
    return this.outcomes.getById(outcomeVerificationId);
  }
}

export class FakeExperimentOutcomeVerificationPort
  implements ExperimentOutcomeVerificationPort
{
  private readonly byId = new Map<string, OutcomeVerificationRecord>();

  seed(record: OutcomeVerificationRecord): void {
    this.byId.set(record.outcomeVerificationId, record);
  }

  async resolveOutcomeVerification(
    outcomeVerificationId: string,
  ): Promise<OutcomeVerificationRecord | null> {
    return this.byId.get(outcomeVerificationId) ?? null;
  }
}

export interface BoundPhase8Verification {
  record: OutcomeVerificationRecord;
  authoritativeQuality: ExperimentEvidenceQuality;
}

/**
 * Derive evidence quality from Phase 8 verdict — never from caller/model assertion.
 */
export function deriveEvidenceQualityFromVerdict(
  outcome: OutcomeVerdict,
): ExperimentEvidenceQuality {
  switch (outcome) {
    case "VERIFIED_SUCCESS":
      return "VALIDATED";
    case "PARTIAL_SUCCESS":
      return "PARTIAL";
    case "INCONCLUSIVE":
      return "UNKNOWN";
    case "VERIFICATION_FAILED":
    case "CONTAINED":
      return "DEGRADED";
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

/**
 * Resolve and bind Phase 8 verification to experiment execution lineage.
 * Cross-run, missing, or fabricated refs fail closed.
 */
export async function resolveBoundPhase8Verifications(input: {
  verificationPort: ExperimentOutcomeVerificationPort;
  outcomeVerificationIds: readonly string[];
  lineage: ExperimentExecutionLineage | null;
  experimentProjectId: string;
  expectedRunProjectId?: string;
}): Promise<BoundPhase8Verification[]> {
  if (input.outcomeVerificationIds.length === 0) {
    return [];
  }
  if (!input.lineage?.compiledRunId) {
    throw new ExperimentError(
      "PHASE8_VERIFICATION_REQUIRED",
      "Phase 8 verification requires experiment execution lineage with compiled run identity",
    );
  }

  const bound: BoundPhase8Verification[] = [];
  for (const id of input.outcomeVerificationIds) {
    const record = await input.verificationPort.resolveOutcomeVerification(id);
    if (!record) {
      throw new ExperimentError(
        "PHASE8_VERIFICATION_INVALID",
        `Fabricated or unknown Phase 8 outcome verification ref: ${id}`,
        { outcomeVerificationId: id },
      );
    }
    if (record.runId !== input.lineage.compiledRunId) {
      throw new ExperimentError(
        "PHASE8_VERIFICATION_RUN_MISMATCH",
        "Phase 8 verification run identity does not match experiment execution lineage",
        {
          outcomeVerificationId: id,
          verificationRunId: record.runId,
          lineageRunId: input.lineage.compiledRunId,
        },
      );
    }
    if (
      input.expectedRunProjectId !== undefined &&
      input.expectedRunProjectId !== input.experimentProjectId
    ) {
      throw new ExperimentError(
        "PHASE8_VERIFICATION_PROJECT_MISMATCH",
        "Phase 8 verification project does not match experiment project",
        {
          experimentProjectId: input.experimentProjectId,
          runProjectId: input.expectedRunProjectId,
        },
      );
    }
    bound.push({
      record,
      authoritativeQuality: deriveEvidenceQualityFromVerdict(record.outcome),
    });
  }
  return bound;
}

/**
 * Whether Phase 8 binding may authorize SUPPORTED / NOT_SUPPORTED hypothesis outcomes.
 * INCONCLUSIVE / failed / partial verification cannot silently become conclusive support.
 */
export function phase8AllowsConclusiveHypothesis(
  bindings: readonly BoundPhase8Verification[],
): boolean {
  if (bindings.length === 0) return false;
  return bindings.every((b) => b.record.outcome === "VERIFIED_SUCCESS");
}

export function worstAuthoritativeQuality(
  bindings: readonly BoundPhase8Verification[],
): ExperimentEvidenceQuality {
  if (bindings.length === 0) return "UNKNOWN";
  const order = { UNKNOWN: 0, DEGRADED: 1, PARTIAL: 2, VALIDATED: 3 } as const;
  return bindings.reduce<ExperimentEvidenceQuality>((acc, b) => {
    return order[b.authoritativeQuality] < order[acc]
      ? b.authoritativeQuality
      : acc;
  }, "VALIDATED");
}
