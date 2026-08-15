import {
  ExecutionPlanSchema,
  type ExecutionPlan,
} from "../domain/plan/execution-plan.js";
import {
  Sha256PlanHasher,
  type PlanHasher,
} from "../domain/plan/plan-hasher.js";
import type { ValidationFinding } from "../domain/validation/index.js";
import type { StoredPlanRecord } from "../planning/plan-repository.js";
import { ValidationFindingFactory } from "./finding-factory.js";

export interface PlanSchemaValidatorInput {
  record: StoredPlanRecord;
  runId: string;
}

export interface PlanSchemaValidationResult {
  findings: readonly ValidationFinding[];
  /** Present only when the stored plan parsed against the canonical schema. */
  plan: ExecutionPlan | null;
  recomputedPlanHash: string | null;
}

/**
 * Independent structural re-verification of a stored plan.
 *
 * The hash is recomputed from the canonical plan payload rather than trusted
 * from the planner. A hash, version, or run-binding mismatch is a hard,
 * non-repairable violation: no revision may "fix" a plan whose identity does
 * not match what was persisted.
 */
export class PlanSchemaValidator {
  constructor(
    private readonly hasher: PlanHasher = new Sha256PlanHasher(),
    private readonly findings: ValidationFindingFactory = new ValidationFindingFactory(),
  ) {}

  validate(input: PlanSchemaValidatorInput): PlanSchemaValidationResult {
    const parsed = ExecutionPlanSchema.safeParse(input.record.plan);
    if (!parsed.success) {
      return {
        plan: null,
        recomputedPlanHash: null,
        findings: [
          this.findings.create({
            validatorType: "SCHEMA",
            category: "plan-schema",
            severity: "CRITICAL",
            ruleId: "PLAN_SCHEMA_INVALID",
            message: "Stored plan does not satisfy the ExecutionPlan contract",
            repairable: false,
            approvalEligible: false,
            blocking: true,
            subject: { planId: input.record.planId },
            metadata: {
              issues: parsed.error.issues.map((issue) => ({
                path: issue.path.join("."),
                message: issue.message,
              })),
            },
          }),
        ],
      };
    }

    const plan = parsed.data;
    const { planHash: _ignored, ...forHash } = plan;
    const recomputedPlanHash = this.hasher.hash(forHash);
    const results: ValidationFinding[] = [];

    if (recomputedPlanHash !== plan.planHash) {
      results.push(
        this.findings.create({
          validatorType: "SCHEMA",
          category: "plan-integrity",
          severity: "CRITICAL",
          ruleId: "PLAN_HASH_MISMATCH",
          message:
            "Recomputed plan hash does not match the hash carried by the plan",
          repairable: false,
          approvalEligible: false,
          blocking: true,
          subject: { planId: plan.planId },
          metadata: {
            declaredPlanHash: plan.planHash,
            recomputedPlanHash,
          },
        }),
      );
    }

    if (input.record.planHash !== plan.planHash) {
      results.push(
        this.findings.create({
          validatorType: "SCHEMA",
          category: "plan-integrity",
          severity: "CRITICAL",
          ruleId: "PLAN_RECORD_HASH_MISMATCH",
          message:
            "Stored plan record hash does not match the embedded plan hash",
          repairable: false,
          approvalEligible: false,
          blocking: true,
          subject: { planId: plan.planId },
          metadata: {
            recordPlanHash: input.record.planHash,
            planHash: plan.planHash,
          },
        }),
      );
    }

    if (input.record.planVersion !== plan.planVersion) {
      results.push(
        this.findings.create({
          validatorType: "SCHEMA",
          category: "plan-integrity",
          severity: "CRITICAL",
          ruleId: "PLAN_VERSION_MISMATCH",
          message:
            "Stored plan record version does not match the embedded plan version",
          repairable: false,
          approvalEligible: false,
          blocking: true,
          subject: { planId: plan.planId },
          metadata: {
            recordPlanVersion: input.record.planVersion,
            planVersion: plan.planVersion,
          },
        }),
      );
    }

    if (input.record.runId !== input.runId) {
      results.push(
        this.findings.create({
          validatorType: "SCHEMA",
          category: "plan-integrity",
          severity: "CRITICAL",
          ruleId: "PLAN_RUN_BINDING_MISMATCH",
          message: "Stored plan is not bound to the run under validation",
          repairable: false,
          approvalEligible: false,
          blocking: true,
          subject: { planId: plan.planId },
          metadata: { recordRunId: input.record.runId, runId: input.runId },
        }),
      );
    }

    const stepIds = new Set<string>();
    const duplicates: string[] = [];
    for (const step of plan.steps) {
      if (stepIds.has(step.stepId)) {
        duplicates.push(step.stepId);
      }
      stepIds.add(step.stepId);
    }
    if (duplicates.length > 0) {
      results.push(
        this.findings.create({
          validatorType: "SCHEMA",
          category: "plan-structure",
          severity: "ERROR",
          ruleId: "PLAN_DUPLICATE_STEP_ID",
          message: "Plan contains duplicate step identifiers",
          repairable: true,
          approvalEligible: false,
          blocking: true,
          affectedStepIds: duplicates,
          subject: { stepIds: duplicates },
        }),
      );
    }

    const orphanWorkstreamSteps = plan.workstreams
      .flatMap((workstream) => workstream.stepIds)
      .filter((stepId) => !stepIds.has(stepId));
    if (orphanWorkstreamSteps.length > 0) {
      results.push(
        this.findings.create({
          validatorType: "SCHEMA",
          category: "plan-structure",
          severity: "ERROR",
          ruleId: "PLAN_WORKSTREAM_STEP_UNKNOWN",
          message: "Workstream references a step that is not in the plan",
          repairable: true,
          approvalEligible: false,
          blocking: true,
          affectedStepIds: orphanWorkstreamSteps,
          subject: { stepIds: orphanWorkstreamSteps },
        }),
      );
    }

    const uncoveredSteps = [...stepIds].filter(
      (stepId) =>
        !plan.workstreams.some((workstream) =>
          workstream.stepIds.includes(stepId),
        ),
    );
    if (uncoveredSteps.length > 0) {
      results.push(
        this.findings.create({
          validatorType: "SCHEMA",
          category: "plan-structure",
          severity: "WARNING",
          ruleId: "PLAN_STEP_NOT_IN_WORKSTREAM",
          message: "Plan step is not assigned to any workstream",
          repairable: true,
          approvalEligible: true,
          blocking: false,
          affectedStepIds: uncoveredSteps,
          subject: { stepIds: uncoveredSteps },
        }),
      );
    }

    return { plan, recomputedPlanHash, findings: results };
  }
}
