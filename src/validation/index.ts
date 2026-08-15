/**
 * Validator authority boundary.
 * Evaluates plans and produces decisions. Cannot approve or execute.
 * PASS is not APPROVED: the run stays in VALIDATING.
 */
export type { ValidatorPort } from "./port.js";
export { VALIDATOR_AUTHORITY } from "./port.js";

export {
  VALIDATION_ERROR_CODES,
  ValidationError,
  isValidationError,
  ValidationPreDispatchError,
  isValidationPreDispatchError,
  type ValidationErrorCode,
} from "./errors.js";

export {
  ViolationFingerprintService,
  VIOLATION_FINGERPRINT_VERSION,
  type ViolationFingerprintInput,
} from "./fingerprint.js";

export {
  ValidationFindingFactory,
  isUnrepairableBlocking,
  blockingFindings,
  repairableBlockingFindings,
  semanticFingerprintsOf,
  type ValidationFindingDraft,
} from "./finding-factory.js";

export {
  ValidationReadinessService,
  ValidationReadinessCodeSchema,
  type ValidationReadinessCode,
  type ValidationReadinessResult,
  type ValidationReadinessServiceDeps,
} from "./readiness.js";

export {
  ValidationFenceStatusSchema,
  ValidationFenceKeySchema,
  ValidationFenceSchema,
  InMemoryValidationCoordinator,
  validationFenceKey,
  type ValidationFenceStatus,
  type ValidationFenceKey,
  type ValidationFence,
  type BeginValidationResult,
  type ValidationCoordinator,
} from "./coordinator.js";

export { PlanSchemaValidator, type PlanSchemaValidationResult } from "./schema-validator.js";
export { PlanFreshnessValidator } from "./freshness-validator.js";
export {
  PlanPolicyValidator,
  type PolicyAttributes,
  type PolicyConditionOutcome,
  type PolicyStepEffect,
  type PolicyStepEvaluation,
  type PlanPolicyValidationResult,
} from "./policy-validator.js";
export { IndependentCapabilityValidator } from "./capability-validator.js";
export {
  PlanDependencyValidator,
  type PlanDependencyValidationResult,
} from "./dependency-validator.js";
export {
  PlanResourceValidator,
  HARD_BUDGET_DIMENSIONS,
  type HardBudgetDimension,
  type PlanResourceValidationResult,
} from "./resource-validator.js";
export {
  PlanSecurityValidator,
  FORBIDDEN_ACTION_TYPES,
  DEPLOYMENT_ACTION_TYPES,
  PATCH_ONLY_MUTATION_ACTIONS,
} from "./security-validator.js";

export {
  DeterministicValidationService,
  VALIDATION_LADDER,
  type DeterministicValidationInput,
  type DeterministicValidationResult,
  type DeterministicValidationServiceDeps,
} from "./deterministic.js";

export { PlanVerificationBindingValidator } from "./verification-binding-validator.js";

export {
  ContextualValidationAssessmentSchema,
  ContextualValidationObservationSchema,
  parseContextualValidationAssessment,
  aggregateValidationUsage,
  resolveValidationChargedTokenTotal,
  InMemoryValidationUsageLedger,
  VALIDATION_OPERATION_CATEGORY,
  type ContextualValidationAssessment,
  type ContextualValidationObservation,
  type ValidationModel,
  type ValidationModelInput,
  type ValidationModelOutput,
  type ValidationModelOperation,
  type ValidationModelTokenUsage,
  type ValidationModelUsage,
  type ValidationModelUsageStatus,
  type ValidationUsageAggregate,
  type ValidationUsageCategoryTotals,
  type ValidationUsageLedger,
  type ValidationUsageSettle,
  type ValidationTokenReservationRequest,
  type InferenceOperationCategory,
} from "./model.js";

export { FakeValidationModel, PASSING_ASSESSMENT } from "./fake-validation-model.js";

export {
  DEFAULT_VALIDATION_MAX_OUTPUT_TOKENS,
  ByteLengthValidationTokenEstimator,
  FixedValidationTokenEstimator,
  computeTokenReservation,
  type ValidationMaxOutputTokensByOperation,
  type ValidationTokenReservationEstimator,
  type AssembledValidationPromptLike,
} from "./token-reservation.js";

export { ValidationInferenceBudget } from "./inference-budget.js";

export {
  ValidationPromptAssembler,
  VALIDATION_PROMPT_VERSION,
  type AssembledValidationPrompt,
} from "./prompt-assembler.js";
export {
  RevisionPromptAssembler,
  REVISION_PROMPT_VERSION,
  type AssembledRevisionPrompt,
} from "./revision-prompt-assembler.js";

export {
  ValidationDecisionEngine,
  VALIDATION_REASON_CODES,
  type ValidationDecisionInput,
  type ValidationDecisionOutcome,
  type ValidationReasonCode,
} from "./decision-engine.js";

export {
  InMemoryValidationDecisionRepository,
  type ValidationDecisionRepository,
} from "./decision-repository.js";

export {
  RevisionEnvelopeSchema,
  RevisionLockedConstraintsSchema,
  RevisionEnvelopeBuilder,
  IMMUTABLE_REVISION_STATEMENTS,
  parseRevisionEnvelope,
  type RevisionEnvelope,
  type RevisionLockedConstraints,
  type RevisionEnvelopeBuildInput,
} from "./revision-envelope.js";

export {
  PlanningModelRevisionAdapter,
  FakePlanRevisionModel,
  gapAnalysisFromEnvelope,
  type PlanRevisionModel,
  type PlanRevisionModelInput,
} from "./revision-model.js";

export {
  PlanningExceptionSchema,
  PlanningExceptionTypeSchema,
  createPlanningException,
  parsePlanningException,
  type PlanningException,
  type PlanningExceptionType,
} from "./exception.js";

export type { ValidationResult } from "./result.js";

export {
  ValidationService,
  SequenceValidationIdentityGenerator,
  MAX_SEMANTIC_REVISION_ATTEMPTS,
  MAX_REVISED_PLAN_VERSION,
  VALIDATOR_ID,
  type ValidationServiceDeps,
  type ValidationIdentityGenerator,
} from "./service.js";
