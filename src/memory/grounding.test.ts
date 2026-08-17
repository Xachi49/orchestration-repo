import { describe, expect, it } from "vitest";
import type { HistoricalRunRecord } from "../domain/memory/historical-run.js";
import type { LearningClaim } from "../domain/memory/claim.js";
import type { OutcomeVerificationRecord } from "../domain/verification/record.js";
import { LearningClaimGroundingService } from "./grounding.js";
import { polarityForCandidateType } from "../domain/memory/claim.js";

function historical(
  overrides: Partial<HistoricalRunRecord> = {},
): HistoricalRunRecord {
  return {
    historicalRunRecordId: "hist_1",
    runId: "run_1",
    projectId: "proj",
    objectiveId: "obj",
    objectiveVersion: 1,
    objectiveFingerprint: "fp",
    planHash: "plan_a",
    outcome: "VERIFIED_SUCCESS",
    runState: "COMPLETED",
    actionTypes: ["CREATE_LOCAL_PATCH"],
    capabilityIds: ["cap_patch"],
    recordHash: "aa".repeat(32),
    ...overrides,
  };
}

function claim(partial: Partial<LearningClaim> & Pick<LearningClaim, "candidateType">): LearningClaim {
  const candidateType = partial.candidateType;
  return {
    candidateType,
    observedOutcome: partial.observedOutcome ?? "VERIFIED_SUCCESS",
    polarity: partial.polarity ?? polarityForCandidateType(candidateType),
    planHash: partial.planHash ?? "plan_a",
    actionTypes: partial.actionTypes ?? ["CREATE_LOCAL_PATCH"],
    capabilityIds: partial.capabilityIds ?? ["cap_patch"],
    verificationMethods: partial.verificationMethods ?? [],
    criterionIds: partial.criterionIds ?? [],
    criterionVerdicts: partial.criterionVerdicts ?? [],
    findingIds: partial.findingIds ?? [],
    evidenceRefs: partial.evidenceRefs ?? [],
    ...(partial.containmentReason !== undefined
      ? { containmentReason: partial.containmentReason }
      : {}),
    ...(partial.resourceObservation !== undefined
      ? { resourceObservation: partial.resourceObservation }
      : {}),
  };
}

function verification(
  overrides: Partial<OutcomeVerificationRecord> = {},
): OutcomeVerificationRecord {
  return {
    outcomeVerificationId: "ov_1",
    verificationAttemptId: "va_1",
    runId: "run_1",
    executionAttemptId: "ex_1",
    planId: "plan_1",
    planVersion: 1,
    planHash: "plan_a",
    authorizationRecordId: "auth_1",
    postExecutionSnapshotHash: "bb".repeat(32),
    verificationSpecificationHash: "cc".repeat(32),
    outcome: "VERIFIED_SUCCESS",
    criterionResults: [
      {
        criterionId: "crit_1",
        criterionText: "done",
        verdict: "SATISFIED",
        evidenceRefs: [],
        stepRefs: [],
        findingRefs: [],
        conciseRationale: "ok",
        verificationMethod: "EXACT",
      },
    ],
    postconditionResults: [],
    findings: [
      {
        findingId: "find_1",
        category: "ACCEPTANCE_CRITERION",
        severity: "ERROR",
        ruleId: "rule_1",
        message: "failed",
        criterionIds: ["crit_1"],
        stepIds: [],
        evidenceRefs: [],
        blocksVerifiedSuccess: true,
      },
    ],
    evidenceRefs: [],
    createdAt: "2026-08-17T00:00:00.000Z",
    ...overrides,
  };
}

describe("LearningClaimGroundingService", () => {
  const service = new LearningClaimGroundingService();

  it("grounds a verified-success structured success claim", () => {
    const result = service.ground({
      claim: claim({ candidateType: "SUCCESS_PATTERN" }),
      historicalRun: historical(),
    });
    expect(result.verdict).toBe("DETERMINISTICALLY_GROUNDED");
  });

  it("marks hallucinated capability/action claims UNGROUNDED", () => {
    const cap = service.ground({
      claim: claim({
        candidateType: "SUCCESS_PATTERN",
        capabilityIds: ["HALLUCINATED_CAP"],
      }),
      historicalRun: historical(),
    });
    expect(cap.verdict).toBe("UNGROUNDED");
    expect(cap.reasons.join(" ")).toMatch(/capability/i);

    const action = service.ground({
      claim: claim({
        candidateType: "SUCCESS_PATTERN",
        actionTypes: ["HALLUCINATED_ACTION"],
      }),
      historicalRun: historical(),
    });
    expect(action.verdict).toBe("UNGROUNDED");
    expect(action.reasons.join(" ")).toMatch(/action/i);
  });

  it("marks a failure claim referencing a nonexistent finding UNGROUNDED", () => {
    const result = service.ground({
      claim: claim({
        candidateType: "FAILURE_PATTERN",
        observedOutcome: "VERIFICATION_FAILED",
        polarity: "NEGATIVE",
        findingIds: ["missing_finding"],
      }),
      historicalRun: historical({
        outcome: "VERIFICATION_FAILED",
        runState: "COMPLETED",
      }),
      verification: verification({
        outcome: "VERIFICATION_FAILED",
        findings: [],
      }),
    });
    expect(result.verdict).toBe("UNGROUNDED");
    expect(result.reasons.join(" ")).toMatch(/finding/i);
  });

  it("requires resource claims to match ledger evidence", () => {
    const grounded = service.ground({
      claim: claim({
        candidateType: "RESOURCE_PATTERN",
        resourceObservation: { tokensUsed: 42 },
      }),
      historicalRun: historical(),
      resourceLedger: { tokensUsed: 42 },
    });
    expect(grounded.verdict).toBe("DETERMINISTICALLY_GROUNDED");

    const mismatch = service.ground({
      claim: claim({
        candidateType: "RESOURCE_PATTERN",
        resourceObservation: { tokensUsed: 42 },
      }),
      historicalRun: historical(),
      resourceLedger: { tokensUsed: 99 },
    });
    expect(mismatch.verdict).toBe("UNGROUNDED");

    const missing = service.ground({
      claim: claim({
        candidateType: "RESOURCE_PATTERN",
        resourceObservation: { tokensUsed: 42 },
      }),
      historicalRun: historical(),
    });
    expect(missing.verdict).toBe("UNGROUNDED");
  });

  it("distinguishes REQUIRES_HUMAN_REVIEW from missing evidence", () => {
    const service = new LearningClaimGroundingService();
    const review = service.ground({
      claim: claim({
        candidateType: "SECURITY_PATTERN",
        observedOutcome: "CONTAINED",
        polarity: "NEGATIVE",
      }),
      historicalRun: historical({
        outcome: "CONTAINED",
        runState: "CONTAINED",
      }),
    });
    expect(review.verdict).toBe("REQUIRES_HUMAN_REVIEW");

    const missing = service.ground({
      claim: claim({
        candidateType: "SECURITY_PATTERN",
        observedOutcome: "CONTAINED",
        polarity: "NEGATIVE",
        capabilityIds: ["MISSING_CAP"],
      }),
      historicalRun: historical({
        outcome: "CONTAINED",
        runState: "CONTAINED",
      }),
    });
    expect(missing.verdict).toBe("UNGROUNDED");
    expect(missing.verdict).not.toBe("REQUIRES_HUMAN_REVIEW");
  });

  it("marks dependency claims PARTIALLY_GROUNDED when historical indexes exist", () => {
    const service = new LearningClaimGroundingService();
    const result = service.ground({
      claim: claim({ candidateType: "DEPENDENCY_PATTERN" }),
      historicalRun: historical(),
    });
    expect(result.verdict).toBe("PARTIALLY_GROUNDED");
  });

  it("requires containment claims to match the containment record", () => {
    const service = new LearningClaimGroundingService();
    const grounded = service.ground({
      claim: claim({
        candidateType: "CONTAINMENT_PATTERN",
        observedOutcome: "CONTAINED",
        polarity: "NEGATIVE",
        containmentReason: "CONTAINED",
      }),
      historicalRun: historical({
        outcome: "CONTAINED",
        runState: "CONTAINED",
      }),
    });
    expect(grounded.verdict).toBe("DETERMINISTICALLY_GROUNDED");

    const mismatch = service.ground({
      claim: claim({
        candidateType: "CONTAINMENT_PATTERN",
        observedOutcome: "CONTAINED",
        polarity: "NEGATIVE",
        containmentReason: "rollback failed due to aliens",
      }),
      historicalRun: historical({
        outcome: "CONTAINED",
        runState: "CONTAINED",
      }),
    });
    expect(mismatch.verdict).toBe("UNGROUNDED");
  });
});
