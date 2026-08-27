/**
 * Phase 19 doctrine — a Decision Policy recommends; it does not govern the
 * governor and it does not execute.
 */
export const DECISION_POLICY_DOCTRINE = {
  governanceNotDecision: "GOVERNANCE_POLICY != DECISION_POLICY",
  causalClaimNotRule: "CAUSAL_CLAIM != DECISION_RULE",
  candidateNotActive: "DECISION_POLICY_CANDIDATE != ACTIVE_DECISION_POLICY",
  modelRuleNotAuthorized: "MODEL-SUGGESTED_RULE != AUTHORIZED_RULE",
  offlineNotLive: "OFFLINE_EVALUATION != LIVE_OUTCOME",
  shadowNotLive: "SHADOW_MODE != LIVE_AUTHORITY",
  policyApprovalNotActionApproval: "POLICY_APPROVAL != ACTION_APPROVAL",
  recommendationNotExecution: "RECOMMENDATION != EXECUTION",
  expectedNotGuaranteed: "EXPECTED_VALUE != GUARANTEED_VALUE",
  estimatedNotObservedRegret: "ESTIMATED_REGRET != OBSERVED_REGRET",
  adaptationNotSelfModification: "ADAPTATION != SELF-MODIFICATION",
  recommendsDoesNotExecute:
    "A Decision Policy recommends. It does not govern the governor. It does not execute.",
} as const;

export const DECISION_POLICY_CLOSED_LOOP = [
  "PROMOTED CAUSAL KNOWLEDGE",
  "DECISION CONTEXT",
  "DECISION POLICY CANDIDATE",
  "OFFLINE EVALUATION",
  "HUMAN SHADOW APPROVAL",
  "SHADOW MODE",
  "HUMAN ACTIVATION",
  "LIVE RECOMMENDATION",
  "DOWNSTREAM GOVERNED PHASE",
  "EXECUTION AUTHORIZATION",
  "VERIFIED OUTCOME",
  "PERFORMANCE",
  "REVISION CANDIDATE",
] as const;
