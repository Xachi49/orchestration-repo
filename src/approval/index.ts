/**
 * Approver authority boundary.
 * May authorize an exact plan version. Cannot silently modify that plan.
 * Phase 0: contract only.
 */
export interface ApproverPort {
  readonly authority: "AUTHORIZE_EXACT_PLAN_VERSION";
}

export const APPROVER_AUTHORITY = {
  mayAuthorizeExactPlanVersion: true,
  mayModifyPlan: false,
} as const;
