import { z } from "zod";
import { PlanVersionSchema } from "../domain/plan/execution-plan.js";
import type { ExecutionPlan } from "../domain/plan/execution-plan.js";
import {
  ValidationFindingSchema,
  type ValidationFinding,
} from "../domain/validation/index.js";
import type { ProjectControlContext } from "../control-plane/context.js";
import { ValidationError } from "./errors.js";
import { isUnrepairableBlocking } from "./finding-factory.js";

/**
 * Constraints a revision may not renegotiate.
 * The reviser may change plan structure; it may not change what it is bound to.
 */
export const RevisionLockedConstraintsSchema = z
  .object({
    objectiveId: z.string().min(1),
    objectiveVersion: z.number().int().positive(),
    environment: z.string().min(1),
    executionMode: z.string().min(1),
    repositoryCommitSha: z.string().min(1),
    repositoryFingerprint: z.string().min(1),
    policyBundleId: z.string().min(1),
    policyBundleHash: z.string().min(1),
    budgetProfileId: z.string().min(1),
    allowedActionTypes: z.array(z.string().min(1)),
    forbiddenActionTypes: z.array(z.string().min(1)),
    immutableStatements: z.array(z.string().min(1)),
  })
  .strict();
export type RevisionLockedConstraints = z.infer<
  typeof RevisionLockedConstraintsSchema
>;

export const RevisionEnvelopeSchema = z
  .object({
    envelopeId: z.string().min(1),
    runId: z.string().min(1),
    planId: z.string().min(1),
    planVersion: PlanVersionSchema,
    planHash: z.string().min(1),
    targetPlanVersion: PlanVersionSchema,
    revisionAttempt: z.number().int().positive(),
    lockedConstraints: RevisionLockedConstraintsSchema,
    /** Blocking findings a bounded revision is permitted to repair. */
    repairableFindings: z.array(ValidationFindingSchema).min(1),
    /** Non-blocking context; the reviser must not regress these. */
    advisoryFindings: z.array(ValidationFindingSchema),
    /** Fingerprints already seen; producing them again ends the loop. */
    priorSemanticFingerprints: z.array(z.string().min(1)),
    createdAt: z.string().datetime(),
  })
  .strict();
export type RevisionEnvelope = z.infer<typeof RevisionEnvelopeSchema>;

export function parseRevisionEnvelope(input: unknown): RevisionEnvelope {
  return RevisionEnvelopeSchema.parse(input);
}

export const IMMUTABLE_REVISION_STATEMENTS = [
  "The objective and its acceptance criteria are fixed.",
  "The locked commit SHA and repository fingerprint are fixed.",
  "The active policy bundle is fixed and may not be weakened.",
  "Resource ceilings are fixed and may not be raised.",
  "Forbidden actions may not be reintroduced under another name.",
  "Only the listed repairable findings may be addressed.",
] as const;

export interface RevisionEnvelopeBuildInput {
  envelopeId: string;
  runId: string;
  plan: ExecutionPlan;
  targetPlanVersion: number;
  revisionAttempt: number;
  control: ProjectControlContext;
  environment: string;
  findings: readonly ValidationFinding[];
  priorSemanticFingerprints: readonly string[];
  createdAt: string;
}

/**
 * Builds the bounded instruction set handed to a revision model.
 *
 * Fails closed: if any blocking finding is unrepairable there is no legitimate
 * revision to request, and if nothing is repairable there is nothing to revise.
 */
export class RevisionEnvelopeBuilder {
  build(input: RevisionEnvelopeBuildInput): RevisionEnvelope {
    const unrepairable = input.findings.filter(isUnrepairableBlocking);
    if (unrepairable.length > 0) {
      throw new ValidationError(
        "REVISION_NOT_PERMITTED",
        "Cannot build a revision envelope while unrepairable blocking findings exist",
        {
          runId: input.runId,
          planId: input.plan.planId,
          ruleIds: unrepairable.map((finding) => finding.ruleId),
        },
      );
    }

    const repairableFindings = input.findings.filter(
      (finding) => finding.blocking && finding.repairable,
    );
    if (repairableFindings.length === 0) {
      throw new ValidationError(
        "REVISION_NOT_PERMITTED",
        "Cannot build a revision envelope without repairable blocking findings",
        { runId: input.runId, planId: input.plan.planId },
      );
    }

    const allowedActionTypes = [
      ...new Set(
        input.control.availableCapabilities
          .filter((capability) => capability.enabled)
          .flatMap((capability) => capability.allowedActions),
      ),
    ].sort((a, b) => a.localeCompare(b));
    const forbiddenActionTypes = [
      ...new Set(
        input.control.availableCapabilities.flatMap(
          (capability) => capability.forbiddenActions,
        ),
      ),
    ].sort((a, b) => a.localeCompare(b));

    return parseRevisionEnvelope({
      envelopeId: input.envelopeId,
      runId: input.runId,
      planId: input.plan.planId,
      planVersion: input.plan.planVersion,
      planHash: input.plan.planHash,
      targetPlanVersion: input.targetPlanVersion,
      revisionAttempt: input.revisionAttempt,
      lockedConstraints: {
        objectiveId: input.plan.objectiveId,
        objectiveVersion: input.plan.objectiveVersion,
        environment: input.environment,
        executionMode: input.control.project.executionMode,
        repositoryCommitSha: input.plan.repositoryCommitSha,
        repositoryFingerprint: input.plan.repositoryFingerprint,
        policyBundleId: input.plan.policyBundleId,
        policyBundleHash: input.plan.policyBundleHash,
        budgetProfileId: input.control.resourceBudget.budgetProfileId,
        allowedActionTypes,
        forbiddenActionTypes,
        immutableStatements: [...IMMUTABLE_REVISION_STATEMENTS],
      },
      repairableFindings,
      advisoryFindings: input.findings.filter((finding) => !finding.blocking),
      priorSemanticFingerprints: [...input.priorSemanticFingerprints],
      createdAt: input.createdAt,
    });
  }
}
