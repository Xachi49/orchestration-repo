import {
  createLocalPlanningStack,
  type LocalPlanningStack,
} from "../planning/local-stack.js";
import type { RequesterGrant } from "../../admission/authorization.js";
import type { ResourceBudgetProfile } from "../../control-plane/budgets/budget.js";
import type { Capability } from "../../control-plane/capabilities/capability.js";
import type { PlanningModel } from "../../planning/model.js";
import type { PlanIdentityGenerator } from "../../planning/plan-compiler.js";
import {
  FakeValidationModel,
  InMemoryValidationCoordinator,
  InMemoryValidationDecisionRepository,
  InMemoryValidationUsageLedger,
  PlanningModelRevisionAdapter,
  ValidationReadinessService,
  ValidationService,
  SequenceValidationIdentityGenerator,
  type PlanRevisionModel,
  type ValidationMaxOutputTokensByOperation,
  type ValidationModel,
  type ValidationTokenReservationEstimator,
} from "../../validation/index.js";

export interface LocalValidationStack extends LocalPlanningStack {
  validation: ValidationService;
  validationReadiness: ValidationReadinessService;
  validationCoordinator: InMemoryValidationCoordinator;
  validationDecisions: InMemoryValidationDecisionRepository;
  validationUsage: InMemoryValidationUsageLedger;
  validationModel: ValidationModel;
  revisionModel: PlanRevisionModel;
}

/** Revised plans get their own id sequence so a revision never collides with v1. */
class RevisionPlanIdentityGenerator implements PlanIdentityGenerator {
  private counter = 0;

  nextPlanId(): string {
    this.counter += 1;
    return `plan_rev_${this.counter}`;
  }
}

/**
 * Local stack for Phase 5. Uses `FakeValidationModel` by default and reuses the
 * fake planning model for bounded revision.
 * Never constructs `OpenAIValidationModel` unless one is explicitly injected.
 *
 * Capability authority is the Control Plane registry from admission — validation
 * does not maintain an independent capability truth.
 */
export function createLocalValidationStack(options?: {
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
}): LocalValidationStack {
  const planningOptions: {
    grants?: readonly RequesterGrant[];
    clockIso?: string;
    budgets?: readonly ResourceBudgetProfile[];
    capabilities?: readonly Capability[];
    model?: PlanningModel;
  } = {};
  if (options?.grants) {
    planningOptions.grants = options.grants;
  }
  if (options?.clockIso) {
    planningOptions.clockIso = options.clockIso;
  }
  if (options?.budgets) {
    planningOptions.budgets = options.budgets;
  }
  if (options?.capabilities) {
    planningOptions.capabilities = options.capabilities;
  }
  if (options?.planningModel) {
    planningOptions.model = options.planningModel;
  }

  const base = createLocalPlanningStack(planningOptions);
  const validationCoordinator = new InMemoryValidationCoordinator();
  const validationDecisions = new InMemoryValidationDecisionRepository();
  const validationUsage = new InMemoryValidationUsageLedger();
  const validationModel = options?.validationModel ?? new FakeValidationModel();
  const revisionModel =
    options?.revisionModel ??
    new PlanningModelRevisionAdapter(base.planningModel);
  const validationReadiness = new ValidationReadinessService({
    runs: base.runs,
    plans: base.plans,
    objectives: base.objectives,
    controlPlane: base.controlPlane,
  });

  const validation = new ValidationService({
    readiness: validationReadiness,
    coordinator: validationCoordinator,
    runs: base.runs,
    objectives: base.objectives,
    controlPlane: base.controlPlane,
    contexts: base.contexts,
    locks: base.locks,
    evidence: base.evidence,
    workspace: base.workspace,
    plans: base.plans,
    capabilities: base.capabilities,
    decisions: validationDecisions,
    model: validationModel,
    usage: validationUsage,
    revisionModel,
    planIdentities: options?.planIdentities ?? new RevisionPlanIdentityGenerator(),
    identities: new SequenceValidationIdentityGenerator(),
    clock: base.clock,
    ...(options?.validationTokenEstimator
      ? { tokenEstimator: options.validationTokenEstimator }
      : {}),
    ...(options?.validationMaxOutputTokensByOperation
      ? {
          maxOutputTokensByOperation:
            options.validationMaxOutputTokensByOperation,
        }
      : {}),
    ...(options?.maxRevisionAttempts !== undefined
      ? { maxRevisionAttempts: options.maxRevisionAttempts }
      : {}),
  });

  return {
    ...base,
    validation,
    validationReadiness,
    validationCoordinator,
    validationDecisions,
    validationUsage,
    validationModel,
    revisionModel,
  };
}
