/**
 * Verifier authority boundary.
 * Independently measures outcomes against acceptance criteria.
 * Cannot approve, execute, replan, or remediate.
 * Phase 8: evidence-backed outcome verification and completion.
 */
export interface VerificationPort {
  readonly stage: "VERIFICATION";
  readonly mayCreateCompletion: true;
  readonly mayExecute: false;
  readonly mayApprove: false;
  readonly mayRemediate: false;
}

export const VERIFIER_AUTHORITY = {
  mayMeasureOutcomes: true,
  mayCreateCompletionRecord: true,
  mayExecute: false,
  mayApprove: false,
  mayRemediate: false,
  mayCreateVerifiedSuccessFromModelAlone: false,
} as const;

export {
  VERIFICATION_ERROR_CODES,
  VerificationError,
  isVerificationError,
  VerificationPreDispatchError,
  isVerificationPreDispatchError,
  type VerificationErrorCode,
} from "./errors.js";

export {
  SequenceVerificationIdentityGenerator,
  type VerificationIdentityGenerator,
} from "./identity.js";

export {
  VerificationReadinessService,
  VerificationReadinessCodeSchema,
  type VerificationReadinessCode,
  type VerificationReadinessResult,
  type VerificationReadinessServiceDeps,
} from "./readiness.js";

export {
  InMemoryVerificationCoordinator,
  verificationFenceKey,
  VerificationFenceStatusSchema,
  VerificationFenceKeySchema,
  VerificationFenceSchema,
  type VerificationCoordinator,
  type VerificationFence,
  type VerificationFenceKey,
  type VerificationFenceStatus,
  type BeginVerificationResult,
} from "./coordinator.js";

export {
  InMemoryVerificationEvidenceRepository,
  type VerificationEvidenceRepository,
} from "./evidence-repository.js";

export {
  InMemoryOutcomeVerificationRepository,
  type OutcomeVerificationRepository,
} from "./outcome-repository.js";

export {
  InMemoryCompletionRecordRepository,
  type CompletionRecordRepository,
} from "./completion-repository.js";

export {
  PostExecutionTruthService,
  PostExecutionSnapshotHasher,
  type PostExecutionTruthServiceDeps,
} from "./snapshot.js";

export {
  ExecutionArtifactVerifier,
  readVerificationArtifactBytes,
  readVerificationArtifactUtf8,
  utf8FromVerificationBytes,
} from "./artifact-verifier.js";

export {
  ActionOutcomeVerifierRegistry,
  type ActionOutcomeVerifier,
  type ActionOutcomeVerification,
  type ActionOutcomeContext,
} from "./action-verifiers.js";

export { ExecutionBoundaryVerifier } from "./boundary-verifier.js";
export { ExecutionGovernanceVerifier } from "./governance-verifier.js";

export {
  VerificationSpecificationCompiler,
  normalizeCriterionText,
  hashVerificationSpecification,
} from "./specification.js";

export { VerificationCoverageService } from "./coverage.js";

export {
  BindingFulfillmentEvaluator,
  heuristicRelevanceSuggestion,
} from "./binding-fulfillment.js";

export {
  ContextualOutcomeInputSchema,
  ContextualOutcomeAssessmentSchema,
  parseContextualOutcomeInput,
  parseContextualOutcomeAssessment,
  type ContextualOutcomeInput,
  type ContextualOutcomeAssessment,
  type VerificationModel,
  type VerificationModelOutput,
  type VerificationModelTokenUsage,
} from "./model.js";

export {
  FakeVerificationModel,
  PASSING_OUTCOME_ASSESSMENT,
} from "./fake-model.js";

export {
  InMemoryVerificationInferenceLedger,
  VerificationInferenceBudget,
  VERIFICATION_OPERATION_CATEGORY,
  type VerificationInferenceLedger,
  type VerificationInferenceRecord,
  type VerificationOperationCategory,
} from "./inference-ledger.js";

export {
  OutcomeDecisionEngine,
  type OutcomeDecisionInput,
  type OutcomeDecision,
} from "./decision-engine.js";

export {
  OutcomeVerificationService,
  type OutcomeVerificationServiceDeps,
} from "./service.js";
