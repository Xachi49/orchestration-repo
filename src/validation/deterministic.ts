import type { ProjectControlContext } from "../control-plane/context.js";
import type { BudgetResourceEstimate } from "../control-plane/budgets/budget.js";
import type { CapabilityRegistry } from "../control-plane/capabilities/registry.js";
import type { ExecutionPlan } from "../domain/plan/execution-plan.js";
import type {
  ValidationFinding,
  ValidationValidatorType,
} from "../domain/validation/index.js";
import type { LockedRepositoryState } from "../ingestion/locked-state.js";
import type { VerifiedRepositoryContext } from "../ingestion/context.js";
import type { StoredPlanRecord } from "../planning/plan-repository.js";
import type { DependencyGraphResult } from "../planning/dependency-graph.js";
import type { Objective } from "../domain/objective/objective.js";
import { ValidationFindingFactory, isUnrepairableBlocking } from "./finding-factory.js";
import { PlanSchemaValidator } from "./schema-validator.js";
import { PlanFreshnessValidator } from "./freshness-validator.js";
import { PlanPolicyValidator } from "./policy-validator.js";
import { IndependentCapabilityValidator } from "./capability-validator.js";
import { PlanDependencyValidator } from "./dependency-validator.js";
import { PlanResourceValidator } from "./resource-validator.js";
import { PlanSecurityValidator } from "./security-validator.js";
import { PlanVerificationBindingValidator } from "./verification-binding-validator.js";

/** Fixed evaluation order of the deterministic validation ladder. */
export const VALIDATION_LADDER = [
  "SCHEMA",
  "STATE",
  "FRESHNESS",
  "POLICY",
  "CAPABILITY",
  "DEPENDENCY",
  "RESOURCE",
  "SECURITY",
  "VERIFICATION_BINDING",
] as const satisfies readonly ValidationValidatorType[];

export interface DeterministicValidationInput {
  runId: string;
  record: StoredPlanRecord;
  control: ProjectControlContext;
  environment: string;
  liveLock: LockedRepositoryState | null;
  repositoryContext: VerifiedRepositoryContext | null;
  objective: Objective;
}

export interface DeterministicValidationResult {
  findings: readonly ValidationFinding[];
  plan: ExecutionPlan | null;
  validatorsRun: readonly ValidationValidatorType[];
  haltedAt: ValidationValidatorType | null;
  /** False when an unrepairable blocking violation exists. */
  contextualEligible: boolean;
  graph: DependencyGraphResult | null;
  resourceEstimate: BudgetResourceEstimate | null;
}

export interface DeterministicValidationServiceDeps {
  capabilities: CapabilityRegistry;
  findings?: ValidationFindingFactory;
  schema?: PlanSchemaValidator;
  freshness?: PlanFreshnessValidator;
  policy?: PlanPolicyValidator;
  capability?: IndependentCapabilityValidator;
  dependency?: PlanDependencyValidator;
  resource?: PlanResourceValidator;
  security?: PlanSecurityValidator;
  verificationBinding?: PlanVerificationBindingValidator;
}

/**
 * Runs the deterministic validators in a fixed order.
 *
 * The structural gates (`SCHEMA`, `STATE`, `FRESHNESS`) run first: if the plan
 * is not a well-formed, correctly-identified artifact grounded in current
 * repository and policy truth, the remaining validators would be adjudicating
 * a fiction, so the ladder halts.
 *
 * Contextual (model) assessment is skipped entirely whenever an unrepairable
 * blocking violation exists — there is nothing a probabilistic opinion could
 * add to a decision that is already forced.
 */
export class DeterministicValidationService {
  private readonly schema: PlanSchemaValidator;
  private readonly freshness: PlanFreshnessValidator;
  private readonly policy: PlanPolicyValidator;
  private readonly capability: IndependentCapabilityValidator;
  private readonly dependency: PlanDependencyValidator;
  private readonly resource: PlanResourceValidator;
  private readonly security: PlanSecurityValidator;
  private readonly verificationBinding: PlanVerificationBindingValidator;
  private readonly findings: ValidationFindingFactory;

  constructor(deps: DeterministicValidationServiceDeps) {
    this.findings = deps.findings ?? new ValidationFindingFactory();
    this.schema = deps.schema ?? new PlanSchemaValidator(undefined, this.findings);
    this.freshness = deps.freshness ?? new PlanFreshnessValidator(this.findings);
    this.policy = deps.policy ?? new PlanPolicyValidator(this.findings);
    this.capability =
      deps.capability ??
      new IndependentCapabilityValidator(deps.capabilities, this.findings);
    this.dependency =
      deps.dependency ?? new PlanDependencyValidator(undefined, this.findings);
    this.resource = deps.resource ?? new PlanResourceValidator(this.findings);
    this.security = deps.security ?? new PlanSecurityValidator(this.findings);
    this.verificationBinding =
      deps.verificationBinding ??
      new PlanVerificationBindingValidator(this.findings);
  }

  async evaluate(
    input: DeterministicValidationInput,
  ): Promise<DeterministicValidationResult> {
    const collected: ValidationFinding[] = [];
    const validatorsRun: ValidationValidatorType[] = [];

    validatorsRun.push("SCHEMA");
    const schemaResult = this.schema.validate({
      record: input.record,
      runId: input.runId,
    });
    collected.push(...schemaResult.findings);

    validatorsRun.push("STATE");
    collected.push(...this.validateState(input.record));

    const plan = schemaResult.plan;
    if (!plan || collected.some(isUnrepairableBlocking)) {
      return this.halt(collected, plan, validatorsRun, plan ? "STATE" : "SCHEMA");
    }

    validatorsRun.push("FRESHNESS");
    collected.push(
      ...this.freshness.validate({
        plan,
        liveLock: input.liveLock,
        repositoryContext: input.repositoryContext,
        control: input.control,
      }),
    );
    if (collected.some(isUnrepairableBlocking)) {
      return this.halt(collected, plan, validatorsRun, "FRESHNESS");
    }

    validatorsRun.push("POLICY");
    const policyResult = this.policy.validate({
      plan,
      control: input.control,
      environment: input.environment,
    });
    collected.push(...policyResult.findings);

    validatorsRun.push("CAPABILITY");
    collected.push(
      ...(await this.capability.validate({
        plan,
        environment: input.environment,
      })),
    );

    validatorsRun.push("DEPENDENCY");
    const dependencyResult = this.dependency.validate(plan);
    collected.push(...dependencyResult.findings);

    validatorsRun.push("RESOURCE");
    const resourceResult = this.resource.validate({
      plan,
      budget: input.control.resourceBudget,
    });
    collected.push(...resourceResult.findings);

    validatorsRun.push("SECURITY");
    collected.push(
      ...this.security.validate({
        plan,
        control: input.control,
        environment: input.environment,
      }),
    );

    validatorsRun.push("VERIFICATION_BINDING");
    collected.push(
      ...this.verificationBinding.validate({
        plan,
        objective: input.objective,
      }),
    );

    return {
      findings: collected,
      plan,
      validatorsRun,
      haltedAt: null,
      contextualEligible: !collected.some(isUnrepairableBlocking),
      graph: dependencyResult.graph,
      resourceEstimate: resourceResult.estimate,
    };
  }

  private validateState(record: StoredPlanRecord): ValidationFinding[] {
    if (
      record.status === "READY_FOR_VALIDATION" ||
      record.status === "UNDER_VALIDATION"
    ) {
      return [];
    }
    return [
      this.findings.create({
        validatorType: "STATE",
        category: "plan-lifecycle",
        severity: "CRITICAL",
        ruleId: "PLAN_STATUS_NOT_VALIDATABLE",
        message: `Plan status ${record.status} is not eligible for validation`,
        repairable: false,
        approvalEligible: false,
        blocking: true,
        subject: { status: record.status },
      }),
    ];
  }

  private halt(
    findings: readonly ValidationFinding[],
    plan: ExecutionPlan | null,
    validatorsRun: readonly ValidationValidatorType[],
    haltedAt: ValidationValidatorType,
  ): DeterministicValidationResult {
    return {
      findings,
      plan,
      validatorsRun,
      haltedAt,
      contextualEligible: false,
      graph: null,
      resourceEstimate: null,
    };
  }
}
