import { createLocalAuthorizationStack } from "../authorization/local-stack.js";
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
import type { LocalAuthorizationStack } from "../authorization/local-stack.js";
import {
  ExecutionReadinessService,
  ExecutionService,
  InMemoryExecutionCoordinator,
  InMemoryStepExecutionRepository,
  InMemoryExecutionArtifactRepository,
  InMemoryExecutionAttemptRepository,
  SequenceExecutionIdentityGenerator,
  TestProfileRegistry,
} from "../../execution/index.js";
import { FakeSafeActuator } from "./actuators.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export interface LocalExecutionStack extends LocalAuthorizationStack {
  execution: ExecutionService;
  executionReadiness: ExecutionReadinessService;
  executionCoordinator: InMemoryExecutionCoordinator;
  stepExecutions: InMemoryStepExecutionRepository;
  executionAttempts: InMemoryExecutionAttemptRepository;
  executionArtifacts: InMemoryExecutionArtifactRepository;
  actuator: FakeSafeActuator;
  testProfiles: TestProfileRegistry;
  dataRoot: string;
  executionIdentities: SequenceExecutionIdentityGenerator;
}

/**
 * Local Phase 7 stack. Extends Phase 6 authorization stack.
 * Uses FakeSafeActuator by default — no real npm spawn, no GitHub writes.
 */
export function createLocalExecutionStack(options?: {
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
}): LocalExecutionStack {
  const dataRoot =
    options?.dataRoot ??
    mkdtempSync(path.join(tmpdir(), "orchestrator-exec-"));

  const base = createLocalAuthorizationStack({
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
  });

  const stepExecutions = new InMemoryStepExecutionRepository();
  const executionAttempts = new InMemoryExecutionAttemptRepository();
  const executionArtifacts = new InMemoryExecutionArtifactRepository();
  const executionCoordinator = new InMemoryExecutionCoordinator();
  const testProfiles = new TestProfileRegistry();
  const actuator = options?.actuator ?? new FakeSafeActuator(testProfiles);
  const identities = new SequenceExecutionIdentityGenerator();

  const executionReadiness = new ExecutionReadinessService({
    runs: base.runs,
    plans: base.plans,
    objectives: base.objectives,
    controlPlane: base.controlPlane,
    locks: base.locks,
    authorizationRecords: base.authorizationRecords,
    approvalRequests: base.approvalRequests,
    clockNowIso: () => base.clock.nowIso(),
  });

  const execution = new ExecutionService({
    runs: base.runs,
    plans: base.plans,
    objectives: base.objectives,
    controlPlane: base.controlPlane,
    locks: base.locks,
    authorizationRecords: base.authorizationRecords,
    approvalRequests: base.approvalRequests,
    readiness: executionReadiness,
    coordinator: executionCoordinator,
    steps: stepExecutions,
    attempts: executionAttempts,
    artifacts: executionArtifacts,
    actuator,
    clock: base.clock,
    dataRoot,
    identities,
    testProfiles,
  });

  return {
    ...base,
    execution,
    executionReadiness,
    executionCoordinator,
    stepExecutions,
    executionAttempts,
    executionArtifacts,
    actuator,
    testProfiles,
    dataRoot,
    executionIdentities: identities,
  };
}
