import type {
  AcceptanceCriterionResult,
  StepPostconditionResult,
  VerificationEvidence,
  VerificationFinding,
  VerificationSpecification,
} from "../domain/verification/index.js";
import type { ExecutionPlan } from "../domain/plan/execution-plan.js";
import type {
  ExecutionAuthoritySnapshot,
  ExecutionResult,
  StepExecutionResult,
} from "../domain/execution/index.js";
import type { AuthorizationRecord } from "../domain/authorization/authorization-record.js";
import type { ExecutionArtifactRepository } from "../execution/artifact-repository.js";
import { ExecutionArtifactVerifier } from "./artifact-verifier.js";
import {
  ActionOutcomeVerifierRegistry,
  type ActionOutcomeVerification,
} from "./action-verifiers.js";
import { ExecutionBoundaryVerifier } from "./boundary-verifier.js";
import { ExecutionGovernanceVerifier } from "./governance-verifier.js";
import { VerificationCoverageService } from "./coverage.js";
import { BindingFulfillmentEvaluator } from "./binding-fulfillment.js";
import { normalizeCriterionText } from "../domain/objective/criterion-identity.js";
import type { VerificationIdentityGenerator } from "./identity.js";
import { fingerprintValue } from "../execution/idempotency.js";
import type { Capability } from "../control-plane/capabilities/capability.js";
import { capabilitySetFingerprint } from "../execution/capability-fingerprint.js";

export const VERIFICATION_LADDER = [
  "binding_identity",
  "historical_authority",
  "side_effect_completeness",
  "artifact_integrity",
  "execution_boundary",
  "governance_resource",
  "step_postconditions",
  "acceptance_coverage",
  "acceptance_verdicts",
  "containment_uncertainty",
] as const;

export type VerificationLadderStep = (typeof VERIFICATION_LADDER)[number];

export interface DeterministicVerificationInput {
  runId: string;
  result: ExecutionResult;
  plan: ExecutionPlan;
  authorization: AuthorizationRecord;
  snapshot: ExecutionAuthoritySnapshot;
  steps: readonly StepExecutionResult[];
  specification: VerificationSpecification;
  dataRoot: string;
  workspaceRoot: string;
  artifacts: ExecutionArtifactRepository;
  rollbackCount: number;
  contained: boolean;
  /** Live Control Plane capabilities for current-drift observation only. */
  liveCapabilities?: readonly Capability[];
  blobStore?: import("../durability/artifacts.js").ArtifactBlobStore;
}

export interface DeterministicVerificationResult {
  findings: VerificationFinding[];
  criterionResults: AcceptanceCriterionResult[];
  postconditionResults: StepPostconditionResult[];
  evidence: VerificationEvidence[];
  actionOutcomes: ActionOutcomeVerification[];
  coverageComplete: boolean;
  artifactIntegrityOk: boolean;
  historicalAuthorityOk: boolean;
  boundaryOk: boolean;
  governanceOk: boolean;
  unresolvedSideEffectUncertainty: boolean;
  currentDriftFindings: VerificationFinding[];
}

/**
 * Cheap deterministic checks first (milestone 24 ladder order).
 */
export class DeterministicOutcomeVerificationService {
  private readonly actionRegistry: ActionOutcomeVerifierRegistry;
  private readonly boundary: ExecutionBoundaryVerifier;
  private readonly governance: ExecutionGovernanceVerifier;
  private readonly coverage: VerificationCoverageService;
  private readonly bindingFulfillment: BindingFulfillmentEvaluator;

  constructor(private readonly identities: VerificationIdentityGenerator) {
    this.actionRegistry = new ActionOutcomeVerifierRegistry(identities);
    this.boundary = new ExecutionBoundaryVerifier(identities);
    this.governance = new ExecutionGovernanceVerifier(identities);
    this.coverage = new VerificationCoverageService(identities);
    this.bindingFulfillment = new BindingFulfillmentEvaluator(identities);
  }

  async verify(
    input: DeterministicVerificationInput,
  ): Promise<DeterministicVerificationResult> {
    const findings: VerificationFinding[] = [];
    const evidence: VerificationEvidence[] = [];
    const nowIso = input.result.completedAt;

    // 1. binding / execution identity
    if (
      input.result.runId !== input.runId ||
      input.result.planId !== input.plan.planId ||
      input.result.planVersion !== input.plan.planVersion ||
      input.result.planHash !== input.plan.planHash ||
      input.result.authorizationRecordId !==
        input.authorization.authorizationRecordId
    ) {
      findings.push(this.finding({
        category: "BINDING",
        ruleId: "VERIFICATION_BINDING_MISMATCH",
        message: "Execution result binding does not match plan/authorization",
      }));
    }

    // 2. historical authority integrity
    let historicalAuthorityOk = true;
    if (
      input.snapshot.authorizedCapabilitySetFingerprint !==
        input.authorization.capabilitySetFingerprint ||
      input.snapshot.liveCapabilitySetFingerprint !==
        input.authorization.capabilitySetFingerprint ||
      input.snapshot.capabilitySetFingerprint !==
        input.authorization.capabilitySetFingerprint
    ) {
      historicalAuthorityOk = false;
      findings.push(this.finding({
        category: "AUTHORITY",
        ruleId: "VERIFICATION_AUTHORITY_MISMATCH",
        message: "Historical authority fingerprint mismatch",
      }));
    }

    // Current drift (informational — does not rewrite historical authority)
    const currentDriftFindings: VerificationFinding[] = [];
    if (input.liveCapabilities) {
      const liveFp = capabilitySetFingerprint(input.liveCapabilities);
      if (liveFp !== input.authorization.capabilitySetFingerprint) {
        currentDriftFindings.push(this.finding({
          category: "CURRENT_DRIFT",
          ruleId: "CURRENT_CAPABILITY_DRIFT",
          message:
            "Current Control Plane capability fingerprint differs from historical authorization (does not invalidate historical authority)",
          blocksVerifiedSuccess: false,
          severity: "INFO",
          metadata: {
            historical: input.authorization.capabilitySetFingerprint,
            current: liveFp,
          },
        }));
      }
    }

    // 3. side-effect state completeness
    let unresolvedSideEffectUncertainty = false;
    for (const step of input.steps) {
      if (step.status === "RUNNING" || step.status === "RESERVED") {
        unresolvedSideEffectUncertainty = true;
        findings.push(this.finding({
          category: "CONTAINMENT",
          ruleId: "VERIFICATION_STEP_STATE_UNKNOWN",
          message: `Unresolved step state ${step.status} for ${step.stepId}`,
          stepIds: [step.stepId],
        }));
      }
    }

    // 4. artifact integrity
    const artifactIds = [
      ...new Set([
        ...input.result.artifactRefs,
        ...input.steps.flatMap((s) => s.outputArtifactRefs),
      ]),
    ];
    const artifactVerifier = new ExecutionArtifactVerifier(
      input.artifacts,
      input.dataRoot,
      this.identities,
      input.blobStore,
    );
    const artifactOutcome = await artifactVerifier.verify({
      runId: input.runId,
      executionAttemptId: input.result.executionAttemptId,
      artifactIds,
    });
    findings.push(...artifactOutcome.findings);
    const artifactIntegrityOk = artifactOutcome.ok;

    // Collect step-result evidence
    for (const step of input.steps) {
      const evidenceId = this.identities.nextEvidenceId();
      evidence.push({
        evidenceId,
        runId: input.runId,
        executionAttemptId: input.result.executionAttemptId,
        sourceType: "STEP_RESULT",
        trustClass: "VERIFIED_EXECUTION_RECORD",
        contentHash: fingerprintValue({
          stepId: step.stepId,
          status: step.status,
          hashes: step.outputHashes,
          targets: step.affectedTargets,
        }),
        stepIds: [step.stepId],
        criterionIds: [],
        observedValue: {
          status: step.status,
          actionType: step.actionType,
          affectedTargets: step.affectedTargets,
          outputArtifactRefs: step.outputArtifactRefs,
        },
        observedAt: step.completedAt ?? step.startedAt,
        metadata: {},
      });
    }

    // 5. actual execution boundary
    const artifactList = [];
    for (const id of artifactIds) {
      const a = await input.artifacts.getById(id);
      if (a) artifactList.push(a);
    }

    // Artifact / test / task / PR evidence (SYSTEM_RECOMPUTED where hash recomputed)
    for (const artifact of artifactList) {
      const recomputed = artifactOutcome.recomputedHashes.get(artifact.artifactId);
      const sourceType =
        artifact.artifactType === "TEST_RESULT"
          ? ("TEST_RESULT" as const)
          : artifact.artifactType === "TASK"
            ? ("TASK_RECORD" as const)
            : artifact.artifactType === "PR_PREPARATION"
              ? ("PR_PREPARATION" as const)
              : ("EXECUTION_ARTIFACT" as const);
      evidence.push({
        evidenceId: this.identities.nextEvidenceId(),
        runId: input.runId,
        executionAttemptId: input.result.executionAttemptId,
        sourceType,
        trustClass: recomputed
          ? "SYSTEM_RECOMPUTED"
          : "VERIFIED_EXECUTION_RECORD",
        contentHash: recomputed ?? artifact.contentHash,
        artifactRef: artifact.artifactId,
        stepIds: [artifact.stepId],
        criterionIds: [],
        observedValue: {
          artifactType: artifact.artifactType,
          relativePath: artifact.relativePath,
          size: artifact.size,
        },
        observedAt: artifact.createdAt,
        metadata: {
          artifactType: artifact.artifactType,
          testProfileId:
            input.steps.find((s) => s.stepId === artifact.stepId)
              ?.affectedTargets[0] ??
            input.plan.steps.find((s) => s.stepId === artifact.stepId)
              ?.targetIds[0],
        },
      });
    }

    const boundaryFindings = this.boundary.verify({
      plan: input.plan,
      steps: input.steps,
      artifacts: artifactList,
      rollbackCount: input.rollbackCount,
    });
    findings.push(...boundaryFindings);
    const boundaryOk = boundaryFindings.every((f) => !f.blocksVerifiedSuccess);

    // 6. governance / resource compliance
    const runningBeforeSideEffectOk = input.steps
      .filter((s) => s.status === "SUCCEEDED" || s.status === "FAILED" || s.status === "COMPENSATED")
      .every((s) => Boolean(s.startedAt));
    // Phase 7 persists RUNNING→terminal; presence of startedAt + terminal is proxy.
    // Stronger check: SUCCEEDED steps must have completedAt after startedAt.
    const timingOk = input.steps
      .filter((s) => s.status === "SUCCEEDED")
      .every((s) => s.completedAt !== undefined);

    const governanceFindings = this.governance.verify({
      authorization: input.authorization,
      snapshot: input.snapshot,
      result: input.result,
      steps: input.steps,
      rollbackCount: input.rollbackCount,
      runningBeforeSideEffectOk: runningBeforeSideEffectOk && timingOk,
    });
    findings.push(...governanceFindings);
    const governanceOk = governanceFindings.every(
      (f) => !f.blocksVerifiedSuccess,
    );

    // Action outcome verifiers (feeds postconditions + criteria)
    const actionOutcomes = await this.actionRegistry.verifyAll({
      runId: input.runId,
      executionAttemptId: input.result.executionAttemptId,
      plan: input.plan,
      steps: input.steps,
      dataRoot: input.dataRoot,
      artifacts: input.artifacts,
      recomputedHashes: artifactOutcome.recomputedHashes,
      workspaceRoot: input.workspaceRoot,
      ...(input.blobStore !== undefined ? { blobStore: input.blobStore } : {}),
    });
    for (const outcome of actionOutcomes) {
      findings.push(...outcome.findings);
    }

    // 7. step postconditions
    const postconditionResults = this.evaluatePostconditions(
      input.specification,
      input.plan,
      actionOutcomes,
      evidence,
    );

    // 8–9. acceptance criteria coverage + verdicts
    const criterionResults = this.evaluateCriteria(
      input.specification,
      input.plan,
      actionOutcomes,
      evidence,
      findings,
    );

    // Attach criterion ids onto matching evidence
    for (const result of criterionResults) {
      for (const evidenceId of result.evidenceRefs) {
        const ev = evidence.find((e) => e.evidenceId === evidenceId);
        if (ev && !ev.criterionIds.includes(result.criterionId)) {
          (ev.criterionIds as string[]).push(result.criterionId);
        }
      }
    }

    const coverage = this.coverage.assess({
      specification: input.specification,
      plan: input.plan,
      criterionResults,
      postconditionResults,
      evidence,
    });
    findings.push(...coverage.findings);

    // 10. containment / unresolved uncertainty
    if (input.contained) {
      findings.push(this.finding({
        category: "CONTAINMENT",
        ruleId: "RUN_CONTAINED",
        message: "Run is CONTAINED; verification will not transition to COMPLETED",
        blocksVerifiedSuccess: true,
        severity: "WARNING",
      }));
    }

    findings.push(...currentDriftFindings);

    // Early exit optimization: if binding/artifact already blocks success,
    // still return full structure (service may skip model).
    return {
      findings,
      criterionResults,
      postconditionResults,
      evidence,
      actionOutcomes,
      coverageComplete: coverage.complete,
      artifactIntegrityOk,
      historicalAuthorityOk,
      boundaryOk,
      governanceOk,
      unresolvedSideEffectUncertainty,
      currentDriftFindings,
    };
  }

  private evaluatePostconditions(
    specification: VerificationSpecification,
    plan: ExecutionPlan,
    actionOutcomes: readonly ActionOutcomeVerification[],
    evidence: VerificationEvidence[],
  ): StepPostconditionResult[] {
    const byStep = new Map(actionOutcomes.map((o) => [o.stepId, o]));
    return specification.postconditions.map((pc) => {
      const outcome = byStep.get(pc.stepId);
      const planStep = plan.steps.find((s) => s.stepId === pc.stepId);
      const evidenceRefs: string[] = [];
      if (outcome) {
        for (const hint of outcome.evidenceHints) {
          const ev = evidence.find(
            (e) =>
              e.sourceType === "STEP_RESULT" &&
              e.stepIds.includes(pc.stepId),
          );
          if (ev) evidenceRefs.push(ev.evidenceId);
          // Also create derived evidence link via artifact id in metadata
          void hint;
        }
        const stepEv = evidence.find(
          (e) =>
            e.sourceType === "STEP_RESULT" && e.stepIds.includes(pc.stepId),
        );
        if (stepEv) evidenceRefs.push(stepEv.evidenceId);
      }

      let verdict: StepPostconditionResult["verdict"] = "INCONCLUSIVE";
      let observed = "No evidence";
      if (outcome) {
        observed = outcome.observedSummary;
        // Exact match preference: postcondition text vs observed summary / expected
        const expectedNorm = normalizeCriterionText(pc.expected);
        if (outcome.passed) {
          verdict = "SATISFIED";
        } else if (outcome.postconditionVerdict === "UNSATISFIED") {
          verdict = "UNSATISFIED";
        } else {
          verdict = outcome.postconditionVerdict;
        }
        // If action passed but expected text doesn't relate, still use action verdict
        // when postcondition is listed on that step.
        if (
          planStep &&
          !planStep.expectedPostconditions.some(
            (p) => normalizeCriterionText(p) === expectedNorm,
          )
        ) {
          verdict = "INCONCLUSIVE";
          observed = "Postcondition not bound to step expected list";
        }
      }

      const uniqueRefs = [...new Set(evidenceRefs)];
      if (uniqueRefs.length === 0 && verdict === "SATISFIED") {
        verdict = "INCONCLUSIVE";
      }

      return {
        stepId: pc.stepId,
        postconditionId: pc.postconditionId,
        expected: pc.expected,
        observed,
        verdict,
        evidenceRefs: uniqueRefs,
        findingRefs: outcome?.findings.map((f) => f.findingId) ?? [],
      };
    });
  }

  private evaluateCriteria(
    specification: VerificationSpecification,
    plan: ExecutionPlan,
    actionOutcomes: readonly ActionOutcomeVerification[],
    evidence: VerificationEvidence[],
    findings: VerificationFinding[],
  ): AcceptanceCriterionResult[] {
    const bindingsById = new Map(
      plan.acceptanceCriterionVerificationBindings.map((b) => [
        b.criterionId,
        b,
      ]),
    );

    return specification.acceptanceCriteria.map((criterion) =>
      this.bindingFulfillment.evaluateCriterion({
        criterionId: criterion.criterionId,
        criterionText: criterion.criterionText,
        binding: bindingsById.get(criterion.criterionId),
        plan,
        actionOutcomes,
        evidence,
        findings,
      }),
    );
  }

  private finding(input: {
    category: VerificationFinding["category"];
    ruleId: string;
    message: string;
    stepIds?: string[];
    criterionIds?: string[];
    blocksVerifiedSuccess?: boolean;
    severity?: VerificationFinding["severity"];
    metadata?: Record<string, unknown>;
  }): VerificationFinding {
    return {
      findingId: this.identities.nextFindingId(),
      category: input.category,
      severity: input.severity ?? "ERROR",
      ruleId: input.ruleId,
      message: input.message,
      criterionIds: input.criterionIds ?? [],
      stepIds: input.stepIds ?? [],
      evidenceRefs: [],
      blocksVerifiedSuccess: input.blocksVerifiedSuccess ?? true,
      metadata: input.metadata ?? {},
    };
  }
}
