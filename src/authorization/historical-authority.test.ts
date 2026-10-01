import { describe, expect, it } from "vitest";
import type {
  ApprovalRequest,
  AuthorizationRecord,
} from "../domain/authorization/index.js";
import type { StoredPlanRecord } from "../planning/plan-repository.js";
import { assessHistoricalExecutionAuthority } from "./historical-authority.js";

const RUN = "run_hist";

function plan(
  version: number,
  status: StoredPlanRecord["status"],
  overrides: Partial<StoredPlanRecord> = {},
): StoredPlanRecord {
  const planHash = `hash_v${version}`;
  return {
    planId: `plan_v${version}`,
    runId: RUN,
    planVersion: version,
    status,
    plan: { planHash } as StoredPlanRecord["plan"],
    planHash,
    planningContextFingerprint: "ctx",
    planningPromptVersion: "p1",
    modelProvider: "fake",
    modelId: "fake",
    createdAt: "2026-09-14T15:00:00.000Z",
    ...overrides,
  } as StoredPlanRecord;
}

function request(
  version: number,
  status: ApprovalRequest["status"],
  overrides: Partial<ApprovalRequest> = {},
): ApprovalRequest {
  return {
    approvalRequestId: `apr_v${version}`,
    runId: RUN,
    objectiveId: "obj_rr_case",
    objectiveVersion: 1,
    planId: `plan_v${version}`,
    planVersion: version,
    planHash: `hash_v${version}`,
    validationDecisionId: `vd_v${version}`,
    status,
    ...overrides,
  } as ApprovalRequest;
}

function record(
  version: number,
  decision: AuthorizationRecord["decision"],
  overrides: Partial<AuthorizationRecord> = {},
): AuthorizationRecord {
  return {
    authorizationRecordId: `authz_v${version}_${decision}`,
    approvalRequestId: `apr_v${version}`,
    runId: RUN,
    objectiveId: "obj_rr_case",
    objectiveVersion: 1,
    planId: `plan_v${version}`,
    planVersion: version,
    planHash: `hash_v${version}`,
    validationDecisionId: `vd_v${version}`,
    decision,
    ...overrides,
  } as AuthorizationRecord;
}

/** v1 APPROVE → v1 SUPERSEDED by repair → v2 REJECT (the pilot history). */
function pilotHistory() {
  return {
    runId: RUN,
    authorizationRecords: [record(1, "APPROVE"), record(2, "REJECT")],
    approvalRequests: [request(1, "APPROVED"), request(2, "REJECTED")],
    plans: [plan(1, "SUPERSEDED"), plan(2, "VALIDATED_APPROVAL_REQUIRED")],
  };
}

describe("assessHistoricalExecutionAuthority", () => {
  it("NONE without any decision", () => {
    expect(
      assessHistoricalExecutionAuthority({
        runId: RUN,
        authorizationRecords: [],
        approvalRequests: [request(1, "EXPIRED")],
        plans: [plan(1, "VALIDATED_APPROVAL_REQUIRED")],
      }),
    ).toEqual({ kind: "NONE" });
  });

  it("NONE with only REJECT history", () => {
    expect(
      assessHistoricalExecutionAuthority({
        runId: RUN,
        authorizationRecords: [record(1, "REJECT")],
        approvalRequests: [request(1, "REJECTED")],
        plans: [plan(1, "VALIDATED_APPROVAL_REQUIRED")],
      }),
    ).toEqual({ kind: "NONE" });
  });

  it("classifies superseded-plan APPROVE followed by REJECT as historical only", () => {
    expect(assessHistoricalExecutionAuthority(pilotHistory())).toEqual({
      kind: "HISTORICAL_SUPERSEDED_APPROVE_ONLY",
      authorizationRecordIds: ["authz_v1_APPROVE"],
      approvalRequestIds: ["apr_v1"],
    });
  });

  it("classifies superseded-plan APPROVE followed by REQUEST_MODIFICATION as historical only", () => {
    const history = pilotHistory();
    expect(
      assessHistoricalExecutionAuthority({
        ...history,
        authorizationRecords: [
          record(1, "APPROVE"),
          record(2, "REQUEST_MODIFICATION"),
        ],
        approvalRequests: [
          request(1, "APPROVED"),
          request(2, "MODIFICATION_REQUESTED"),
        ],
      }).kind,
    ).toBe("HISTORICAL_SUPERSEDED_APPROVE_ONLY");
  });

  it("CURRENT_APPROVE when the latest record is APPROVE", () => {
    expect(
      assessHistoricalExecutionAuthority({
        runId: RUN,
        authorizationRecords: [record(1, "APPROVE")],
        approvalRequests: [request(1, "APPROVED")],
        plans: [plan(1, "VALIDATED_APPROVAL_REQUIRED")],
      }),
    ).toMatchObject({
      kind: "CURRENT_APPROVE",
      reasonCode: "LATEST_AUTHORIZATION_APPROVE",
    });
  });

  it("CURRENT_APPROVE when the latest APPROVE is bound to a superseded plan (expired-after-repair)", () => {
    // Expiry writes no AuthorizationRecord, so v1 APPROVE stays latest.
    expect(
      assessHistoricalExecutionAuthority({
        runId: RUN,
        authorizationRecords: [record(1, "APPROVE")],
        approvalRequests: [request(1, "APPROVED"), request(2, "EXPIRED")],
        plans: [plan(1, "SUPERSEDED"), plan(2, "VALIDATED_APPROVAL_REQUIRED")],
      }),
    ).toMatchObject({
      kind: "CURRENT_APPROVE",
      reasonCode: "LATEST_AUTHORIZATION_APPROVE",
      authorizationRecordId: "authz_v1_APPROVE",
    });
  });

  it("CURRENT_APPROVE when an earlier APPROVE is bound to a non-superseded plan", () => {
    const history = pilotHistory();
    expect(
      assessHistoricalExecutionAuthority({
        ...history,
        plans: [plan(1, "VALIDATED_APPROVAL_REQUIRED"), plan(2, "VALIDATED_APPROVAL_REQUIRED")],
      }),
    ).toMatchObject({
      kind: "CURRENT_APPROVE",
      reasonCode: "APPROVE_BOUND_TO_NON_SUPERSEDED_PLAN",
      authorizationRecordId: "authz_v1_APPROVE",
    });
  });

  it.each([
    [
      "APPROVED_PLAN_MISSING",
      (h: ReturnType<typeof pilotHistory>) => ({ ...h, plans: [h.plans[1]!] }),
    ],
    [
      "APPROVED_PLAN_DUPLICATE",
      (h: ReturnType<typeof pilotHistory>) => ({
        ...h,
        plans: [...h.plans, plan(1, "SUPERSEDED")],
      }),
    ],
    [
      "APPROVED_PLAN_BINDING_INCONSISTENT",
      (h: ReturnType<typeof pilotHistory>) => ({
        ...h,
        plans: [plan(1, "SUPERSEDED", { planHash: "hash_other" }), h.plans[1]!],
      }),
    ],
    [
      "APPROVED_PLAN_BINDING_INCONSISTENT",
      (h: ReturnType<typeof pilotHistory>) => ({
        ...h,
        plans: [
          plan(1, "SUPERSEDED", {
            plan: { planHash: "hash_embedded_other" } as StoredPlanRecord["plan"],
          }),
          h.plans[1]!,
        ],
      }),
    ],
    [
      "APPROVAL_BINDING_INCONSISTENT",
      (h: ReturnType<typeof pilotHistory>) => ({
        ...h,
        approvalRequests: [
          request(1, "APPROVED", { planHash: "hash_v2" }),
          h.approvalRequests[1]!,
        ],
      }),
    ],
    [
      "APPROVE_WITHOUT_APPROVED_REQUEST",
      (h: ReturnType<typeof pilotHistory>) => ({
        ...h,
        approvalRequests: [h.approvalRequests[1]!],
      }),
    ],
    [
      "APPROVE_WITHOUT_APPROVED_REQUEST",
      (h: ReturnType<typeof pilotHistory>) => ({
        ...h,
        approvalRequests: [request(1, "EXPIRED"), h.approvalRequests[1]!],
      }),
    ],
    [
      "APPROVED_REQUEST_WITHOUT_APPROVE_RECORD",
      (h: ReturnType<typeof pilotHistory>) => ({
        ...h,
        approvalRequests: [
          ...h.approvalRequests,
          request(3, "APPROVED", { planId: "plan_v2", planVersion: 2, planHash: "hash_v2" }),
        ],
      }),
    ],
    [
      "FOREIGN_RUN_HISTORY",
      (h: ReturnType<typeof pilotHistory>) => ({
        ...h,
        authorizationRecords: [
          record(1, "APPROVE", { runId: "run_other" }),
          h.authorizationRecords[1]!,
        ],
      }),
    ],
  ])("AMBIGUOUS %s", (reasonCode, mutate) => {
    expect(assessHistoricalExecutionAuthority(mutate(pilotHistory()))).toMatchObject({
      kind: "AMBIGUOUS",
      reasonCode,
    });
  });

  it("does not mutate its inputs", () => {
    const history = pilotHistory();
    const snapshot = JSON.stringify(history);
    assessHistoricalExecutionAuthority(history);
    expect(JSON.stringify(history)).toBe(snapshot);
  });
});
