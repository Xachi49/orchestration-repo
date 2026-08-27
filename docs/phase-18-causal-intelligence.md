# Phase 18 — Causal Intelligence

Causal intelligence sits beside Scenarios and Experiments. It turns verified
evidence into bounded causal claims under human review. Causal knowledge
**informs** decisions. It does **not** authorize them.

## Closed learning loop

```text
VERIFIED EVIDENCE
  → CAUSAL QUESTION
  → GRAPH
  → IDENTIFICATION
  → ESTIMATION
  → SYNTHESIS
  → VALIDATION
  → HUMAN CAUSAL REVIEW
  → PROMOTED BOUNDED CAUSAL CLAIM
  → CALIBRATION CANDIDATE
  → PHASE 16 RE-ANALYSIS
```

Identification failure feeds Active Learning without creating experiment
authority:

```text
IDENTIFICATION FAILURE
  → EVIDENCE GAP
  → PHASE 17 ACTIVE LEARNING
```

**Causal knowledge informs decisions. It does not authorize them.**

## Authority separation

```text
CONTROL PLANE
  ↓
CAUSAL QUESTION ADMISSION
  ↓
GRAPH PROPOSAL (DATA only — FakeCausalGraphProposalModel / graph model)
  ↓
IDENTIFICATION (deterministic; association ≠ identification)
  ↓
ESTIMATION (supported estimators only — no fake sophistication)
  ↓
SYNTHESIS + VALIDATION
  ↓
CAUSAL REVIEW (CAUSAL_REVIEWER)
  ↓
PROMOTED BOUNDED CLAIM (precedent / knowledge — not policy)
  ↓
CALIBRATION CANDIDATE (observational — Phase 16 re-analysis required)
```

**CAUSAL_REVIEWER ≠ APPROVER ≠ EXPERIMENT_SPONSOR ≠ STRATEGY_SELECTOR ≠
PORTFOLIO_ALLOCATOR ≠ PROGRAM_MATERIALIZER.**

## Governing rules

- **Correlation ≠ causation** — observational association never yields
  `IDENTIFIED` by itself.
- **MODEL_PROPOSED ≠ verified edge** — model DAGs are DATA; they are not true
  causal structure.
- **Identification ≠ estimation** — estimation requires an identified strategy.
- **PLAUSIBLE ≠ TRUE** — assumption statuses are never silently upgraded.
- **Statistical ≠ business significance** — materiality comes from the
  CausalQuestion threshold.
- **Promoted claim ≠ policy** — promotion writes governed causal knowledge only.
- **Calibration candidate ≠ model change** — candidates set
  `requiresPhase16Reanalysis: true` and never mutate AssumptionSets in place.
- **Evidence gap ≠ experiment authorization** — gaps may feed Phase 17 Active
  Learning (`mayFeedPhase17ActiveLearning`) with
  `doesNotAuthorizeExperiment: true`.
- **Human review ≠ factual evidence** — review decisions authorize claim
  promotion scope only.
- **Progression**: `CausalProgressionLoop` / `CausalWorkMaterializer` only
  discover work and materialize SchedulerWorkItems. They do not estimate,
  promote, or decide.

## Lifecycle

```text
DRAFT → ADMITTED → GRAPH_PROPOSED → IDENTIFICATION_ANALYSIS
  → ESTIMATING → SYNTHESIZING → VALIDATING
  → AWAITING_CAUSAL_REVIEW → REVIEWED → PROMOTED
```

Terminal / side paths: `REJECTED`, `INCONCLUSIVE`, `CANCELLED`, `SUPERSEDED`,
`STALE`. There is no direct `ESTIMATING → PROMOTED`.

## Phase 9 memory boundary

Phase 9 integration uses **dedicated causal storage** with advisory retrieval
under the governed-memory boundary. PromotedCausalClaim is a specialized
governed artifact — **not a second Memory authority**. Phase 9
`LEARN_FROM_RUN` remains run-centric.

## Primary packages

- `src/causal/` — domain, graph model, orchestration service
- `migrations/013_phase18_causal_intelligence.sql` — durable tables +
  `CAUSAL_REVIEWER` authority principal
- `src/scheduling/causal-discovery-map.ts` — scheduler work identity per state
- Tests: `src/causal/causal.test.ts`,
  `src/infrastructure/postgres/postgres.phase18.test.ts`
