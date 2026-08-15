/**
 * Approver authority boundary.
 * May authorize an exact plan version. Cannot silently modify that plan.
 * Ordinary AI/model conversation is not a trusted authorization channel.
 */
export interface ApproverPort {
  readonly authority: "AUTHORIZE_EXACT_PLAN_VERSION";
}

export const APPROVER_AUTHORITY = {
  mayAuthorizeExactPlanVersion: true,
  mayModifyPlan: false,
  mayApproveViaModelConversation: false,
  mayInferApprovalFromValidationPass: false,
} as const;

export {
  AuthorizationRoutingService,
  HumanAuthorizationService,
  AuthorizationReadinessService,
  ApprovalExpiryService,
} from "../authorization/index.js";
