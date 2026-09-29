import { describe, expect, it } from "vitest";
import {
  hasNonApprovalEligibleBlockingFinding,
  isNonApprovalEligibleBlockingFinding,
  type ValidationFinding,
} from "../domain/validation/index.js";
import {
  boundedHumanEscalation,
  ValidationDecisionEngine,
} from "./decision-engine.js";
import { ValidationFindingFactory } from "./finding-factory.js";

const factory = new ValidationFindingFactory();

function finding(
  ruleId: string,
  flags: { blocking: boolean; repairable: boolean; approvalEligible: boolean },
): ValidationFinding {
  return factory.create({
    validatorType: "CONTEXTUAL",
    category: "semantic-coverage",
    severity: flags.blocking ? "ERROR" : "WARNING",
    ruleId,
    message: `${ruleId} message`,
    ...flags,
  });
}

/** The two model-emitted blockers observed on the pilot v2 validation. */
const PLAN_COVERAGE_GAP = finding("PLAN_COVERAGE_GAP", {
  blocking: true,
  repairable: true,
  approvalEligible: false,
});
const ACCEPTANCE_CRITERIA_UNSATISFIED = finding(
  "ACCEPTANCE_CRITERIA_UNSATISFIED",
  { blocking: true, repairable: true, approvalEligible: false },
);
const REVISION_FAILED = factory.create({
  validatorType: "STATE",
  category: "revision",
  severity: "ERROR",
  ruleId: "REVISION_FAILED",
  message: "Revised plan could not be compiled",
  repairable: false,
  approvalEligible: true,
  blocking: true,
});
const POLICY_APPROVAL_REQUIRED = finding("POLICY_APPROVAL_REQUIRED", {
  blocking: false,
  repairable: false,
  approvalEligible: true,
});
const REPAIRABLE_APPROVABLE = finding("REPAIRABLE_APPROVABLE", {
  blocking: true,
  repairable: true,
  approvalEligible: true,
});

const engine = new ValidationDecisionEngine();

describe("approval-eligibility predicate", () => {
  it("is true only for blocking && approvalEligible=false", () => {
    expect(isNonApprovalEligibleBlockingFinding(PLAN_COVERAGE_GAP)).toBe(true);
    expect(isNonApprovalEligibleBlockingFinding(REVISION_FAILED)).toBe(false);
    expect(isNonApprovalEligibleBlockingFinding(POLICY_APPROVAL_REQUIRED)).toBe(
      false,
    );
    expect(
      isNonApprovalEligibleBlockingFinding(
        finding("ADVISORY", {
          blocking: false,
          repairable: true,
          approvalEligible: false,
        }),
      ),
    ).toBe(false);
    expect(
      hasNonApprovalEligibleBlockingFinding([
        REVISION_FAILED,
        POLICY_APPROVAL_REQUIRED,
      ]),
    ).toBe(false);
    expect(
      hasNonApprovalEligibleBlockingFinding([REVISION_FAILED, PLAN_COVERAGE_GAP]),
    ).toBe(true);
  });
});

describe("ValidationDecisionEngine — approval eligibility", () => {
  it("revises a repairable non-approval-eligible blocker while attempts remain", () => {
    const outcome = engine.decide({
      findings: [PLAN_COVERAGE_GAP, POLICY_APPROVAL_REQUIRED],
      repeatedFingerprints: [],
      remainingRevisionAttempts: 2,
    });
    expect(outcome.decision).toBe("REVISE");
    expect(outcome.reasonCodes).toEqual(["REPAIRABLE_VIOLATION"]);
  });

  it("blocks when attempts are exhausted with a non-approval-eligible blocker", () => {
    const outcome = engine.decide({
      findings: [PLAN_COVERAGE_GAP, POLICY_APPROVAL_REQUIRED],
      repeatedFingerprints: [],
      remainingRevisionAttempts: 0,
    });
    expect(outcome.decision).toBe("BLOCK");
    expect(outcome.reasonCodes).toEqual([
      "REVISION_ATTEMPTS_EXHAUSTED",
      "NON_APPROVAL_ELIGIBLE_BLOCKING_FINDING",
    ]);
    expect(outcome.decidingFindingIds).toEqual([PLAN_COVERAGE_GAP.findingId]);
  });

  it("blocks a repeated non-approval-eligible blocker", () => {
    const outcome = engine.decide({
      findings: [PLAN_COVERAGE_GAP],
      repeatedFingerprints: [PLAN_COVERAGE_GAP.semanticFingerprint],
      remainingRevisionAttempts: 2,
    });
    expect(outcome.decision).toBe("BLOCK");
    expect(outcome.reasonCodes).toEqual([
      "REPEATED_SEMANTIC_VIOLATION",
      "NON_APPROVAL_ELIGIBLE_BLOCKING_FINDING",
    ]);
  });

  it("still escalates exhausted blockers that are all approval-eligible", () => {
    const outcome = engine.decide({
      findings: [REPAIRABLE_APPROVABLE, POLICY_APPROVAL_REQUIRED],
      repeatedFingerprints: [],
      remainingRevisionAttempts: 0,
    });
    expect(outcome.decision).toBe("HUMAN_APPROVAL_REQUIRED");
    expect(outcome.reasonCodes).toEqual(["REVISION_ATTEMPTS_EXHAUSTED"]);
  });

  it("an approval-eligible unrepairable blocker cannot carry a non-approvable one to approval", () => {
    const outcome = engine.decide({
      findings: [REVISION_FAILED, PLAN_COVERAGE_GAP],
      repeatedFingerprints: [],
      remainingRevisionAttempts: 2,
    });
    expect(outcome.decision).toBe("BLOCK");
    expect(outcome.reasonCodes).toEqual([
      "APPROVAL_REQUIRED_NON_REPAIRABLE",
      "NON_APPROVAL_ELIGIBLE_BLOCKING_FINDING",
    ]);
  });

  it("preserves legitimate approval-eligible escalations", () => {
    expect(
      engine.decide({
        findings: [REVISION_FAILED, POLICY_APPROVAL_REQUIRED],
        repeatedFingerprints: [],
        remainingRevisionAttempts: 2,
      }).decision,
    ).toBe("HUMAN_APPROVAL_REQUIRED");
    expect(
      engine.decide({
        findings: [POLICY_APPROVAL_REQUIRED],
        repeatedFingerprints: [],
        remainingRevisionAttempts: 2,
      }),
    ).toMatchObject({
      decision: "HUMAN_APPROVAL_REQUIRED",
      reasonCodes: ["APPROVAL_ELIGIBLE_FINDING"],
    });
  });
});

describe("boundedHumanEscalation — revision failure", () => {
  it("REVISION_FAILED approvalEligible=true cannot override underlying non-approval-eligible blockers", () => {
    const outcome = boundedHumanEscalation({
      findings: [
        POLICY_APPROVAL_REQUIRED,
        PLAN_COVERAGE_GAP,
        ACCEPTANCE_CRITERIA_UNSATISFIED,
        REVISION_FAILED,
      ],
      reasonCode: "REVISION_FAILED",
      decidingFindingIds: [REVISION_FAILED.findingId],
    });
    expect(outcome.decision).toBe("BLOCK");
    expect(outcome.reasonCodes).toEqual([
      "REVISION_FAILED",
      "NON_APPROVAL_ELIGIBLE_BLOCKING_FINDING",
    ]);
    expect([...outcome.decidingFindingIds].sort()).toEqual(
      [PLAN_COVERAGE_GAP.findingId, ACCEPTANCE_CRITERIA_UNSATISFIED.findingId].sort(),
    );
  });

  it("revision failure with only approval-eligible blockers may escalate to a human", () => {
    const outcome = boundedHumanEscalation({
      findings: [REPAIRABLE_APPROVABLE, REVISION_FAILED, POLICY_APPROVAL_REQUIRED],
      reasonCode: "REVISION_FAILED",
      decidingFindingIds: [REVISION_FAILED.findingId],
    });
    expect(outcome).toEqual({
      decision: "HUMAN_APPROVAL_REQUIRED",
      reasonCodes: ["REVISION_FAILED"],
      requiresHumanAction: true,
      decidingFindingIds: [REVISION_FAILED.findingId],
    });
  });
});
