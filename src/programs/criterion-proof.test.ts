import { describe, expect, it } from "vitest";
import { proveRootCriterion } from "./criterion-proof.js";
import type { Program } from "./program.js";
import type { ProgramPlan } from "./program-plan.js";
import type { ProgramLineageRecord } from "./lineage.js";
import type {
  CompletionRecord,
  OutcomeVerificationRecord,
} from "../domain/verification/index.js";
import type { RunRecord } from "../admission/run-repository.js";

function baseProgram(): Program {
  return {
    programId: "prog_1",
    programVersion: 1,
    projectId: "p1",
    requesterId: "r1",
    requestedEnvironment: "local",
    rootIntent: {
      requestedOutcome: "outcome",
      acceptanceCriteria: ["Criterion A", "Criterion B"],
      nonGoals: [],
      constraints: ["no production deployment"],
      priority: "HIGH",
    },
    status: "VERIFYING",
    delegationEnvelope: {} as Program["delegationEnvelope"],
    authorityFreeze: {} as Program["authorityFreeze"],
    decompositionRevisionCount: 1,
    maximumDecompositionRevisions: 2,
    paused: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    recordRevision: 1,
    correlationId: "c",
    traceId: "t",
    idempotencyKey: "k",
    contentFingerprint: "f",
  };
}

function emptyBudget() {
  return {
    llmCalls: 0,
    totalTokens: 0,
    apiCalls: 0,
    executionMinutes: 0,
    estimatedCost: 0,
    humanReviewMinutes: 0,
    planSteps: 0,
    parallelWorkstreams: 0,
    revisionAttempts: 0,
  };
}

function planWithBinding(opts: {
  childCriterionText: string;
  rootCriterionIndex: number;
  childCriterionIndex: number;
}): ProgramPlan {
  return {
    programId: "prog_1",
    programPlanVersion: 1,
    programPlanHash: "h",
    nodes: [
      {
        nodeId: "n1",
        title: "n1",
        requestedOutcome: "x",
        acceptanceCriteria: [opts.childCriterionText],
        nonGoals: [],
        constraints: [],
        priority: "MEDIUM",
        requirement: "REQUIRED",
        requestedProjectId: "p1",
        requestedEnvironment: "local",
        requestedCapabilityIds: [],
        requestedRepositoryIdentities: [],
        requestedBudget: emptyBudget(),
        criterionBindings: [
          {
            rootCriterionIndex: opts.rootCriterionIndex,
            childCriterionIndex: opts.childCriterionIndex,
            contributionKind: "SATISFIES",
            evidenceRequirement: "COMPLETION_RECORD",
          },
        ],
        depth: 0,
        disposition: "NEW",
      },
    ],
    edges: [],
    requiredNodeIds: ["n1"],
    optionalNodeIds: [],
    decompositionProposalHash: "d",
    compilerVersion: "c",
    inputContextFingerprint: "i",
    revisionAttempt: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function lineage(): ProgramLineageRecord[] {
  return [
    {
      lineageId: "l1",
      programId: "prog_1",
      programVersion: 1,
      programPlanVersion: 1,
      programPlanHash: "h",
      nodeId: "n1",
      childObjectiveId: "o1",
      childObjectiveVersion: 1,
      childRunId: "run_1",
      materializationStatus: "ADMITTED",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      recordRevision: 1,
    },
  ];
}

function completedRun(): RunRecord {
  return {
    runId: "run_1",
    projectId: "p1",
    objectiveId: "o1",
    objectiveVersion: 1,
    idempotencyKey: "ik",
    requesterId: "r1",
    requestedEnvironment: "local",
    state: "COMPLETED",
    recordRevision: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    correlationId: "c",
    traceId: "t",
  };
}

function completion(): CompletionRecord {
  return {
    completionRecordId: "cr1",
    runId: "run_1",
    objectiveId: "o1",
    objectiveVersion: 1,
    planId: "pl",
    planVersion: 1,
    planHash: "ph",
    executionAttemptId: "ea",
    authorizationRecordId: "ar",
    outcomeVerificationId: "ov",
    postExecutionSnapshotHash: "pe",
    verificationSpecificationHash: "vs",
    completedAt: "2026-01-01T00:00:00.000Z",
  };
}

function outcome(criterionText: string, verdict: "SATISFIED" | "UNSATISFIED" = "SATISFIED"): OutcomeVerificationRecord {
  return {
    outcomeVerificationId: "ov",
    verificationAttemptId: "va",
    runId: "run_1",
    executionAttemptId: "ea",
    planId: "pl",
    planVersion: 1,
    planHash: "ph",
    authorizationRecordId: "ar",
    postExecutionSnapshotHash: "pe",
    verificationSpecificationHash: "vs",
    outcome: "VERIFIED_SUCCESS",
    criterionResults: [
      {
        criterionId: "c0",
        criterionText,
        verdict,
        evidenceRefs: ["e1"],
        stepRefs: [],
        findingRefs: [],
        conciseRationale: "ok",
        verificationMethod: "deterministic",
      },
    ],
    postconditionResults: [],
    findings: [],
    evidenceRefs: ["e1"],
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("proveRootCriterion", () => {
  it("rejects false contribution binding (wrong child criterion text)", () => {
    const proof = proveRootCriterion({
      program: baseProgram(),
      plan: planWithBinding({
        childCriterionText: "Unrelated child criterion",
        rootCriterionIndex: 0,
        childCriterionIndex: 0,
      }),
      rootCriterionIndex: 0,
      lineage: lineage(),
      runsById: new Map([["run_1", completedRun()]]),
      completionsByRunId: new Map([["run_1", completion()]]),
      outcomesById: new Map([
        ["ov", outcome("Unrelated child criterion")],
      ]),
    });
    expect(proof.satisfied).toBe(false);
    if (!proof.satisfied) {
      expect(proof.reasonCode).toBe("FALSE_CONTRIBUTION_BINDING");
    }
  });

  it("rejects when outcome evidence proves different criterion than root Y", () => {
    const proof = proveRootCriterion({
      program: baseProgram(),
      plan: planWithBinding({
        childCriterionText: "Criterion A",
        rootCriterionIndex: 1, // claims to prove Criterion B
        childCriterionIndex: 0, // but child evidence is Criterion A
      }),
      rootCriterionIndex: 1,
      lineage: lineage(),
      runsById: new Map([["run_1", completedRun()]]),
      completionsByRunId: new Map([["run_1", completion()]]),
      outcomesById: new Map([["ov", outcome("Criterion A")]]),
    });
    expect(proof.satisfied).toBe(false);
    if (!proof.satisfied) {
      expect(proof.reasonCode).toBe("FALSE_CONTRIBUTION_BINDING");
    }
  });

  it("rejects missing CompletionRecord", () => {
    const proof = proveRootCriterion({
      program: baseProgram(),
      plan: planWithBinding({
        childCriterionText: "Criterion A",
        rootCriterionIndex: 0,
        childCriterionIndex: 0,
      }),
      rootCriterionIndex: 0,
      lineage: lineage(),
      runsById: new Map([["run_1", completedRun()]]),
      completionsByRunId: new Map([["run_1", null]]),
      outcomesById: new Map(),
    });
    expect(proof.satisfied).toBe(false);
    if (!proof.satisfied) {
      expect(proof.outcome).toBe("INCONCLUSIVE");
      expect(proof.reasonCode).toBe("MISSING_CONTRIBUTION_EVIDENCE");
    }
  });

  it("rejects missing OutcomeVerificationRecord", () => {
    const proof = proveRootCriterion({
      program: baseProgram(),
      plan: planWithBinding({
        childCriterionText: "Criterion A",
        rootCriterionIndex: 0,
        childCriterionIndex: 0,
      }),
      rootCriterionIndex: 0,
      lineage: lineage(),
      runsById: new Map([["run_1", completedRun()]]),
      completionsByRunId: new Map([["run_1", completion()]]),
      outcomesById: new Map([["ov", null]]),
    });
    expect(proof.satisfied).toBe(false);
    if (!proof.satisfied) {
      expect(proof.outcome).toBe("INCONCLUSIVE");
    }
  });

  it("accepts when child criterion evidence SATISFIED matches root", () => {
    const proof = proveRootCriterion({
      program: baseProgram(),
      plan: planWithBinding({
        childCriterionText: "Criterion A",
        rootCriterionIndex: 0,
        childCriterionIndex: 0,
      }),
      rootCriterionIndex: 0,
      lineage: lineage(),
      runsById: new Map([["run_1", completedRun()]]),
      completionsByRunId: new Map([["run_1", completion()]]),
      outcomesById: new Map([["ov", outcome("Criterion A")]]),
    });
    expect(proof.satisfied).toBe(true);
  });
});
