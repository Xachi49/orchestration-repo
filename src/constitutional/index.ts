export { ConstitutionalError, isConstitutionalError } from "./errors.js";
export type { ConstitutionalErrorCode } from "./errors.js";
export { CONSTITUTIONAL_DOCTRINE, CONSTITUTIONAL_PIPELINE } from "./doctrine.js";
export {
  CONSTITUTIONAL_SAFETY_FLOOR_PRINCIPLES,
  assertConstitutionalSafetyFloor,
} from "./safety-floor.js";
export {
  ConstitutionalChangeOperationSchema,
  ConstitutionalRiskClassSchema,
  type ConstitutionalChangeOperation,
  type ConstitutionalRiskClass,
} from "./operations.js";
export {
  ConstitutionalChangeProposalSchema,
  PROPOSAL_STATUSES,
  computeProposalHash,
  withProposalHash,
  mintProposalId,
  isProposalMaterialImmutable,
  type ConstitutionalChangeProposal,
  type ProposalStatus,
} from "./proposal.js";
export {
  computeGovernanceStateFingerprint,
  type GovernanceFingerprintInput,
} from "./fingerprint.js";
export {
  ConstitutionalImpactAnalysisSchema,
  ImpactClassificationSchema,
  analyzeConstitutionalImpact,
  type ConstitutionalImpactAnalysis,
  type ImpactClassification,
} from "./impact-analysis.js";
export {
  ConstitutionalReviewDecisionSchema,
  CONSTITUTIONAL_REVIEW_SUBJECT_TYPE,
  CONSTITUTIONAL_ACTIVATION_SUBJECT_TYPE,
  compileReviewSubjectBinding,
  compileActivationSubjectBinding,
  type ConstitutionalReviewDecision,
} from "./review.js";
export {
  ConstitutionalActivationRecordSchema,
  ConstitutionalActivationContextSchema,
  createActivationContext,
  ACTIVATION_STATUSES,
  type ConstitutionalActivationRecord,
  type ConstitutionalActivationContext,
  type ActivationStatus,
} from "./activation.js";
export type {
  ConstitutionalProposalRepository,
  ConstitutionalImpactAnalysisRepository,
  ConstitutionalReviewDecisionRepository,
  ConstitutionalActivationRecordRepository,
  ConstitutionalAuditRepository,
  ConstitutionalAuditEvent,
} from "./repositories.js";
export {
  InMemoryConstitutionalProposalRepository,
  InMemoryConstitutionalImpactAnalysisRepository,
  InMemoryConstitutionalReviewDecisionRepository,
  InMemoryConstitutionalActivationRecordRepository,
  InMemoryConstitutionalAuditRepository,
} from "./memory-repositories.js";
export {
  ConstitutionalActivationCapability,
} from "./activation-capability.js";
export {
  assertAllOperationsExecutable,
  assertExhaustiveOperationKind,
  compileConstitutionalMutationPlan,
  type ConstitutionalMutationPlan,
} from "./mutation-plan.js";
export { assertProjectedGovernanceContinuity } from "./continuity.js";
export {
  PROTECTED_GOVERNANCE_MUTATIONS,
  ROUTINE_NON_CONSTITUTIONAL_MUTATIONS,
  authorizedProtectedMutationsForOperations,
} from "./protected-mutations.js";
export type {
  ProtectedGovernanceMutation,
  RoutineNonConstitutionalMutation,
} from "./protected-mutations.js";
export { applyConstitutionalMutationPlan } from "./apply-mutations.js";
export {
  ConstitutionalChangeOrchestrationService,
  assertProposalImmutable,
  detectProposalMaterialChange,
  type ConstitutionalChangeOrchestrationDeps,
} from "./service.js";
