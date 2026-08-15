import {
  createLocalExecutionStack,
  type LocalExecutionStack,
} from "../execution/local-stack.js";
import type { RequesterGrant } from "../../admission/authorization.js";
import type { ResourceBudgetProfile } from "../../control-plane/budgets/budget.js";
import type { Capability } from "../../control-plane/capabilities/capability.js";
import type { PlanningModel } from "../../planning/model.js";
import type { PlanIdentityGenerator } from "../../planning/plan-compiler.js";
import type {
  PlanRevisionModel,
  ValidationMaxOutputTokensByOperation,
  ValidationModel,
  ValidationTokenReservationEstimator,
} from "../../validation/index.js";
import type { ApprovalDeliveryService } from "../../authorization/index.js";
import type { DecisionNonceGenerator } from "../../authorization/index.js";
import type { FakeSafeActuator } from "../execution/actuators.js";
import {
  FakeVerificationModel,
  InMemoryCompletionRecordRepository,
  InMemoryOutcomeVerificationRepository,
  InMemoryVerificationCoordinator,
  InMemoryVerificationEvidenceRepository,
  InMemoryVerificationInferenceLedger,
  OutcomeVerificationService,
  SequenceVerificationIdentityGenerator,
  VerificationReadinessService,
} from "../../verification/index.js";

export interface LocalVerificationStack extends LocalExecutionStack {
  verification: OutcomeVerificationService;
  verificationReadiness: VerificationReadinessService;
  verificationCoordinator: InMemoryVerificationCoordinator;
  verificationEvidence: InMemoryVerificationEvidenceRepository;
  outcomeVerifications: InMemoryOutcomeVerificationRepository;
  completionRecords: InMemoryCompletionRecordRepository;
  verificationModel: FakeVerificationModel;
  verificationInference: InMemoryVerificationInferenceLedger;
  verificationIdentities: SequenceVerificationIdentityGenerator;
}

/**
 * Local Phase 8 stack. Extends Phase 7 execution stack.
 * Uses FakeVerificationModel by default — no live APIs.
 */
export function createLocalVerificationStack(options?: {
  grants?: readonly RequesterGrant[];
  clockIso?: string;
  budgets?: readonly ResourceBudgetProfile[];
  planningModel?: PlanningModel;
  capabilities?: readonly Capability[];
  validationModel?: ValidationModel;
  revisionModel?: PlanRevisionModel;
  planIdentities?: PlanIdentityGenerator;
  validationTokenEstimator?: ValidationTokenReservationEstimator;
  validationMaxOutputTokensByOperation?: ValidationMaxOutputTokensByOperation;
  maxRevisionAttempts?: number;
  approvalDelivery?: ApprovalDeliveryService;
  approvalWindowMs?: number;
  knownApproverIds?: readonly string[];
  nonceGenerator?: DecisionNonceGenerator;
  dataRoot?: string;
  actuator?: FakeSafeActuator;
  verificationModel?: FakeVerificationModel;
}): LocalVerificationStack {
  const base = createLocalExecutionStack({
    ...(options?.grants !== undefined ? { grants: options.grants } : {}),
    ...(options?.clockIso !== undefined ? { clockIso: options.clockIso } : {}),
    ...(options?.budgets !== undefined ? { budgets: options.budgets } : {}),
    ...(options?.planningModel !== undefined
      ? { planningModel: options.planningModel }
      : {}),
    ...(options?.capabilities !== undefined
      ? { capabilities: options.capabilities }
      : {}),
    ...(options?.validationModel !== undefined
      ? { validationModel: options.validationModel }
      : {}),
    ...(options?.revisionModel !== undefined
      ? { revisionModel: options.revisionModel }
      : {}),
    ...(options?.planIdentities !== undefined
      ? { planIdentities: options.planIdentities }
      : {}),
    ...(options?.validationTokenEstimator !== undefined
      ? { validationTokenEstimator: options.validationTokenEstimator }
      : {}),
    ...(options?.validationMaxOutputTokensByOperation !== undefined
      ? {
          validationMaxOutputTokensByOperation:
            options.validationMaxOutputTokensByOperation,
        }
      : {}),
    ...(options?.maxRevisionAttempts !== undefined
      ? { maxRevisionAttempts: options.maxRevisionAttempts }
      : {}),
    ...(options?.approvalDelivery !== undefined
      ? { approvalDelivery: options.approvalDelivery }
      : {}),
    ...(options?.approvalWindowMs !== undefined
      ? { approvalWindowMs: options.approvalWindowMs }
      : {}),
    ...(options?.knownApproverIds !== undefined
      ? { knownApproverIds: options.knownApproverIds }
      : {}),
    ...(options?.nonceGenerator !== undefined
      ? { nonceGenerator: options.nonceGenerator }
      : {}),
    ...(options?.dataRoot !== undefined ? { dataRoot: options.dataRoot } : {}),
    ...(options?.actuator !== undefined ? { actuator: options.actuator } : {}),
  });

  const verificationCoordinator = new InMemoryVerificationCoordinator();
  const verificationEvidence = new InMemoryVerificationEvidenceRepository();
  const outcomeVerifications = new InMemoryOutcomeVerificationRepository();
  const completionRecords = new InMemoryCompletionRecordRepository();
  const verificationModel =
    options?.verificationModel ?? new FakeVerificationModel();
  const verificationInference = new InMemoryVerificationInferenceLedger();
  const verificationIdentities = new SequenceVerificationIdentityGenerator();

  const verificationReadiness = new VerificationReadinessService({
    runs: base.runs,
    plans: base.plans,
    objectives: base.objectives,
    authorizationRecords: base.authorizationRecords,
    execution: base.execution,
    executionCoordinator: base.executionCoordinator,
    steps: base.stepExecutions,
    attempts: base.executionAttempts,
    artifacts: base.executionArtifacts,
  });

  const verification = new OutcomeVerificationService({
    runs: base.runs,
    plans: base.plans,
    objectives: base.objectives,
    authorizationRecords: base.authorizationRecords,
    execution: base.execution,
    executionCoordinator: base.executionCoordinator,
    steps: base.stepExecutions,
    attempts: base.executionAttempts,
    artifacts: base.executionArtifacts,
    readiness: verificationReadiness,
    coordinator: verificationCoordinator,
    evidence: verificationEvidence,
    outcomes: outcomeVerifications,
    completions: completionRecords,
    model: verificationModel,
    inferenceLedger: verificationInference,
    clock: base.clock,
    dataRoot: base.dataRoot,
    controlPlane: base.controlPlane,
    identities: verificationIdentities,
  });

  return {
    ...base,
    verification,
    verificationReadiness,
    verificationCoordinator,
    verificationEvidence,
    outcomeVerifications,
    completionRecords,
    verificationModel,
    verificationInference,
    verificationIdentities,
  };
}
