# Phase 19 — Governed Decision Policy Synthesis, Offline Evaluation & Adaptive Control

## Doctrine

```text
GOVERNANCE_POLICY != DECISION_POLICY
CAUSAL_CLAIM != DECISION_RULE
DECISION_POLICY_CANDIDATE != ACTIVE_DECISION_POLICY
MODEL-SUGGESTED_RULE != AUTHORIZED_RULE
OFFLINE_EVALUATION != LIVE_OUTCOME
SHADOW_MODE != LIVE_AUTHORITY
POLICY_APPROVAL != ACTION_APPROVAL
RECOMMENDATION != EXECUTION
EXPECTED_VALUE != GUARANTEED_VALUE
ESTIMATED_REGRET != OBSERVED_REGRET
ADAPTATION != SELF-MODIFICATION
```

**A Decision Policy recommends. It does not govern the governor. It does not execute.**

## Closed loop

```text
PROMOTED CAUSAL KNOWLEDGE
→ DECISION CONTEXT
→ DECISION POLICY CANDIDATE
→ OFFLINE EVALUATION
→ HUMAN SHADOW APPROVAL
→ SHADOW MODE
→ HUMAN ACTIVATION
→ LIVE RECOMMENDATION
→ DOWNSTREAM GOVERNED PHASE
→ EXECUTION AUTHORIZATION
→ VERIFIED OUTCOME
→ PERFORMANCE
→ REVISION CANDIDATE
```

## Authority

| Role | May | May not |
| --- | --- | --- |
| `DECISION_POLICY_APPROVER` | Approve SHADOW eligibility | Activate, execute, mutate Phase 1 policy |
| `DECISION_POLICY_ACTIVATOR` | Activate recommendation authority | Execute, approve capital/programs |
| Phase 6 `APPROVER` | Authorize operational execution | Approve decision policies |
| Model | Propose rules as DATA | Authorize, activate, execute |

## Lifecycle

`DRAFT → SYNTHESIZED → VALIDATED → AWAITING_APPROVAL → APPROVED_FOR_SHADOW → SHADOW_RUNNING → AWAITING_ACTIVATION → ACTIVE`

No direct `VALIDATED → ACTIVE`. Safety may `ACTIVE → PAUSED`. Degradation produces revision candidates only — no live hot mutation.

## Shadow safety

In SHADOW mode the policy observes state and records recommendations with:

- 0 Objectives
- 0 Programs
- 0 Portfolio proposals
- 0 Experiments
- 0 ExecutionAttempts

## Package

`src/decision-policies/` — context, predicates, rules, policy, validation, offline evaluation, comparison, authority, shadow, recommendations, compiler, orchestration service, producer-only progression loop.

Migration: `migrations/014_phase19_decision_policy_optimization.sql`.
