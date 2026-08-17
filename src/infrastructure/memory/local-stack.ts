import {
  createLocalVerificationStack,
  type LocalVerificationStack,
} from "../verification/local-stack.js";
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
import type { FakeVerificationModel } from "../../verification/fake-model.js";
import type { PrecedentPromotionPolicy } from "../../domain/memory/promotion.js";
import {
  FakeLearningModel,
  GovernedMemoryService,
  InMemoryHistoricalRunRepository,
  InMemoryLearningCandidateRepository,
  InMemoryPromotedPrecedentRepository,
  InMemoryPrecedentPromotionDecisionRepository,
  InMemoryLearningLedgerRepository,
  InMemoryPrecedentContradictionRepository,
  InMemoryLearningCoordinator,
  InMemoryLearningInferenceLedger,
  SequenceMemoryIdentityGenerator,
  LocalPrecedentReviewApplicator,
  type LearningModel,
} from "../../memory/index.js";

export interface LocalMemoryStack extends LocalVerificationStack {
  memory: GovernedMemoryService;
  learningModel: LearningModel;
  historicalRuns: InMemoryHistoricalRunRepository;
  learningCandidates: InMemoryLearningCandidateRepository;
  promotedPrecedents: InMemoryPromotedPrecedentRepository;
  promotionDecisions: InMemoryPrecedentPromotionDecisionRepository;
  learningLedger: InMemoryLearningLedgerRepository;
  precedentContradictions: InMemoryPrecedentContradictionRepository;
  learningCoordinator: InMemoryLearningCoordinator;
  learningInference: InMemoryLearningInferenceLedger;
  memoryIdentities: SequenceMemoryIdentityGenerator;
  precedentReview: LocalPrecedentReviewApplicator;
}

/**
 * Local Phase 9 stack. Extends Phase 8 verification stack.
 * Uses FakeLearningModel by default — no live APIs.
 */
export function createLocalMemoryStack(options?: {
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
  learningModel?: LearningModel;
  promotionPolicy?: PrecedentPromotionPolicy;
  enableLearningModel?: boolean;
}): LocalMemoryStack {
  const base = createLocalVerificationStack({
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
    ...(options?.verificationModel !== undefined
      ? { verificationModel: options.verificationModel }
      : {}),
  });

  const historicalRuns = new InMemoryHistoricalRunRepository();
  const learningCandidates = new InMemoryLearningCandidateRepository();
  const promotedPrecedents = new InMemoryPromotedPrecedentRepository();
  const promotionDecisions = new InMemoryPrecedentPromotionDecisionRepository();
  const learningLedger = new InMemoryLearningLedgerRepository();
  const precedentContradictions = new InMemoryPrecedentContradictionRepository();
  const learningCoordinator = new InMemoryLearningCoordinator();
  const learningInference = new InMemoryLearningInferenceLedger();
  const memoryIdentities = new SequenceMemoryIdentityGenerator();
  const learningModel = options?.learningModel ?? new FakeLearningModel();

  const memory = new GovernedMemoryService({
    runs: base.runs,
    objectives: base.objectives,
    plans: base.plans,
    authorizationRecords: base.authorizationRecords,
    execution: base.execution,
    outcomes: base.outcomeVerifications,
    completions: base.completionRecords,
    evidence: base.verificationEvidence,
    contexts: base.contexts,
    controlPlane: base.controlPlane,
    clock: base.clock,
    coordinator: learningCoordinator,
    historicalRuns,
    candidates: learningCandidates,
    precedents: promotedPrecedents,
    decisions: promotionDecisions,
    ledger: learningLedger,
    contradictions: precedentContradictions,
    model: learningModel,
    inferenceLedger: learningInference,
    identities: memoryIdentities,
    ...(options?.promotionPolicy !== undefined
      ? { policy: options.promotionPolicy }
      : {}),
    ...(options?.enableLearningModel !== undefined
      ? { enableLearningModel: options.enableLearningModel }
      : {}),
  });

  const precedentReview = new LocalPrecedentReviewApplicator(memory);

  // Wire advisory precedent retrieval into planning (optional; empty if unbound).
  base.planning.bindPrecedentRetriever(memory.getRetriever());

  return {
    ...base,
    memory,
    learningModel,
    historicalRuns,
    learningCandidates,
    promotedPrecedents,
    promotionDecisions,
    learningLedger,
    precedentContradictions,
    learningCoordinator,
    learningInference,
    memoryIdentities,
    precedentReview,
  };
}
