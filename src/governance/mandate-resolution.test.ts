import { describe, expect, it } from "vitest";
import { withMandateHash } from "./mandate.js";
import { resolveMandateApplicability } from "./mandate-resolution.js";
import { GOV_ENV_STAGING, GOV_PROJECT_ID, GOV_TEST_NOW } from "./test-fixtures.js";

function sampleMandate(
  overrides: Partial<ReturnType<typeof withMandateHash>> & {
    riskScope?: string[];
    resourceScope?: Record<string, number>;
  } = {},
) {
  return withMandateHash({
    mandateId: "gmd_test",
    mandateVersion: 1,
    institutionId: "inst_test",
    subjectClasses: ["PORTFOLIO_AUTHORIZATION"],
    requiredAuthorities: ["PORTFOLIO_ALLOCATOR"],
    projectScope: [GOV_PROJECT_ID],
    environmentScope: [GOV_ENV_STAGING],
    separationOfDutyRules: [],
    delegationPolicy: {
      allowDelegation: true,
      maximumDelegationDepth: 1,
      redelegationForbidden: false,
    },
    riskScope: overrides.riskScope ?? [],
    resourceScope: overrides.resourceScope ?? {},
    effectiveFrom: GOV_TEST_NOW,
    status: "ACTIVE",
    createdBy: "gov_admin",
    createdAt: GOV_TEST_NOW,
    recordRevision: 1,
    ...overrides,
  });
}

describe("resolveMandateApplicability", () => {
  it("returns RESOLVED_NONE when no mandate matches", () => {
    const result = resolveMandateApplicability([], {
      requiredRole: "PORTFOLIO_ALLOCATOR",
      projectId: GOV_PROJECT_ID,
      environment: GOV_ENV_STAGING,
      subjectClass: "PORTFOLIO_AUTHORIZATION",
      atIso: GOV_TEST_NOW,
    });
    expect(result.kind).toBe("RESOLVED_NONE");
  });

  it("returns RESOLVED_APPLICABLE for matching mandate", () => {
    const mandate = sampleMandate();
    const result = resolveMandateApplicability([mandate], {
      requiredRole: "PORTFOLIO_ALLOCATOR",
      projectId: GOV_PROJECT_ID,
      environment: GOV_ENV_STAGING,
      subjectClass: "PORTFOLIO_AUTHORIZATION",
      atIso: GOV_TEST_NOW,
    });
    expect(result.kind).toBe("RESOLVED_APPLICABLE");
    if (result.kind === "RESOLVED_APPLICABLE") {
      expect(result.mandates).toHaveLength(1);
    }
  });

  it("returns MANDATE_CONTEXT_INSUFFICIENT when risk context required but omitted", () => {
    const mandate = sampleMandate({ riskScope: ["HIGH"] });
    const result = resolveMandateApplicability([mandate], {
      requiredRole: "PORTFOLIO_ALLOCATOR",
      projectId: GOV_PROJECT_ID,
      environment: GOV_ENV_STAGING,
      subjectClass: "PORTFOLIO_AUTHORIZATION",
      atIso: GOV_TEST_NOW,
    });
    expect(result.kind).toBe("MANDATE_CONTEXT_INSUFFICIENT");
  });

  it("returns MANDATE_CONTEXT_INSUFFICIENT when materiality context required but omitted", () => {
    const mandate = sampleMandate({ resourceScope: { allocation_usd: 1_000_000 } });
    const result = resolveMandateApplicability([mandate], {
      requiredRole: "PORTFOLIO_ALLOCATOR",
      projectId: GOV_PROJECT_ID,
      environment: GOV_ENV_STAGING,
      subjectClass: "PORTFOLIO_AUTHORIZATION",
      atIso: GOV_TEST_NOW,
    });
    expect(result.kind).toBe("MANDATE_CONTEXT_INSUFFICIENT");
  });
});
