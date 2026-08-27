import {
  createLocalValidationStack,
  type LocalValidationStack,
} from "../validation/local-stack.js";
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
import {
  AuthorizationReadinessService,
  AuthorizationRoutingService,
  ApprovalExpiryService,
  FakeApprovalDeliveryService,
  HumanAuthorizationService,
  InMemoryApprovalRequestRepository,
  InMemoryAuthorizationCoordinator,
  InMemoryAuthorizationRecordRepository,
  InMemoryApproverAuthorizationService,
  InMemoryDecisionCardStore,
  InMemoryModificationRequestRepository,
  SequenceAuthorizationIdentityGenerator,
  SequenceDecisionNonceGenerator,
  type ApprovalDeliveryService,
  type AuthorizationIdentityGenerator,
  type DecisionNonceGenerator,
} from "../../authorization/index.js";
import { EXAMPLE_PROJECT } from "../../control-plane/fixtures.js";

export interface LocalAuthorizationStack extends LocalValidationStack {
  authorizationReadiness: AuthorizationReadinessService;
  authorizationRouting: AuthorizationRoutingService;
  humanAuthorization: HumanAuthorizationService;
  approvalExpiry: ApprovalExpiryService;
  approvalRequests: InMemoryApprovalRequestRepository;
  authorizationRecords: InMemoryAuthorizationRecordRepository;
  modificationRequests: InMemoryModificationRequestRepository;
  decisionCards: InMemoryDecisionCardStore;
  authorizationCoordinator: InMemoryAuthorizationCoordinator;
  approvalDelivery: FakeApprovalDeliveryService | ApprovalDeliveryService;
  approverAuthorization: InMemoryApproverAuthorizationService;
  decisionNonceGenerator: DecisionNonceGenerator;
  authorizationIdentities: AuthorizationIdentityGenerator;
}

/**
 * Local Phase 6 stack. Extends Phase 5 validation stack.
 * Uses FakeApprovalDeliveryService by default. No LLM approval. No execution.
 */
export function createLocalAuthorizationStack(options?: {
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
}): LocalAuthorizationStack {
  const base = createLocalValidationStack(options);
  const approvalRequests = new InMemoryApprovalRequestRepository();
  const authorizationRecords = new InMemoryAuthorizationRecordRepository();
  const modificationRequests = new InMemoryModificationRequestRepository();
  const decisionCards = new InMemoryDecisionCardStore();
  const authorizationCoordinator = new InMemoryAuthorizationCoordinator(
    approvalRequests,
  );
  const approvalDelivery =
    options?.approvalDelivery ?? new FakeApprovalDeliveryService();
  const identities = new SequenceAuthorizationIdentityGenerator();
  const decisionNonceGenerator =
    options?.nonceGenerator ?? new SequenceDecisionNonceGenerator();

  const knownApproverIds = new Set(
    options?.knownApproverIds ?? [
      ...EXAMPLE_PROJECT.authorizedApproverIds,
      "approver_bootstrap",
    ],
  );
  const approverAuthorization = new InMemoryApproverAuthorizationService(
    base.controlPlane,
    knownApproverIds,
  );

  const authorizationReadiness = new AuthorizationReadinessService({
    runs: base.runs,
    plans: base.plans,
    objectives: base.objectives,
    controlPlane: base.controlPlane,
    decisions: base.validationDecisions,
    locks: base.locks,
  });

  const routingOptions: ConstructorParameters<
    typeof AuthorizationRoutingService
  >[0] = {
    readiness: authorizationReadiness,
    runs: base.runs,
    objectives: base.objectives,
    controlPlane: base.controlPlane,
    plans: base.plans,
    decisions: base.validationDecisions,
    locks: base.locks,
    requests: approvalRequests,
    cards: decisionCards,
    coordinator: authorizationCoordinator,
    delivery: approvalDelivery,
    clock: base.clock,
    identities,
    nonceGenerator: decisionNonceGenerator,
  };
  if (options?.approvalWindowMs !== undefined) {
    routingOptions.approvalWindowMs = options.approvalWindowMs;
  }

  const authorizationRouting = new AuthorizationRoutingService(routingOptions);

  const humanAuthorization = new HumanAuthorizationService({
    runs: base.runs,
    objectives: base.objectives,
    controlPlane: base.controlPlane,
    plans: base.plans,
    decisions: base.validationDecisions,
    locks: base.locks,
    requests: approvalRequests,
    records: authorizationRecords,
    modifications: modificationRequests,
    cards: decisionCards,
    coordinator: authorizationCoordinator,
    approvers: approverAuthorization,
    clock: base.clock,
    identities,
    delivery: approvalDelivery,
    nonceGenerator: decisionNonceGenerator,
    ...(options?.approvalWindowMs !== undefined
      ? { approvalWindowMs: options.approvalWindowMs }
      : {}),
  });

  const approvalExpiry = new ApprovalExpiryService({
    requests: approvalRequests,
    runs: base.runs,
    coordinator: authorizationCoordinator,
    clock: base.clock,
  });

  return {
    ...base,
    authorizationReadiness,
    authorizationRouting,
    humanAuthorization,
    approvalExpiry,
    approvalRequests,
    authorizationRecords,
    modificationRequests,
    decisionCards,
    authorizationCoordinator,
    approvalDelivery,
    approverAuthorization,
    decisionNonceGenerator,
    authorizationIdentities: identities,
  };
}
