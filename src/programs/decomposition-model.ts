import { createHash } from "node:crypto";
import { z } from "zod";
import { BudgetResourceEstimateSchema } from "../control-plane/budgets/budget.js";
import { ObjectivePrioritySchema } from "../domain/objective/objective.js";
import type { Program } from "./program.js";

/**
 * Untrusted model proposal. No tools, no network, no authority.
 * DECOMPOSITION != AUTHORITY.
 */
export const DecompositionChildProposalSchema = z
  .object({
    title: z.string().min(1),
    requestedOutcome: z.string().min(1),
    acceptanceCriteria: z.array(z.string().min(1)).min(1),
    nonGoals: z.array(z.string()).default([]),
    constraints: z.array(z.string()).default([]),
    priority: ObjectivePrioritySchema.default("MEDIUM"),
    requirement: z.enum(["REQUIRED", "OPTIONAL"]).default("REQUIRED"),
    requestedProjectId: z.string().min(1).optional(),
    requestedEnvironment: z.string().min(1).optional(),
    requestedCapabilityIds: z.array(z.string().min(1)).default([]),
    requestedRepositoryIdentities: z.array(z.string().min(1)).default([]),
    requestedBudget: BudgetResourceEstimateSchema,
    dependsOnTitles: z.array(z.string().min(1)).default([]),
    parentTitle: z.string().min(1).optional(),
    criterionBindings: z
      .array(
        z
          .object({
            rootCriterionIndex: z.number().int().nonnegative(),
            contributionKind: z.enum([
              "SATISFIES",
              "PARTIAL_EVIDENCE",
              "PREREQUISITE_ONLY",
            ]),
            evidenceRequirement: z
              .enum(["COMPLETION_RECORD", "COMPLETION_AND_VERIFICATION"])
              .default("COMPLETION_RECORD"),
            childCriterionIndex: z.number().int().nonnegative().default(0),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export type DecompositionChildProposal = z.infer<
  typeof DecompositionChildProposalSchema
>;

export const DecompositionProposalSchema = z
  .object({
    children: z.array(DecompositionChildProposalSchema).min(1),
    modelProviderId: z.string().min(1),
    notes: z.string().optional(),
  })
  .strict();

export type DecompositionProposal = z.infer<typeof DecompositionProposalSchema>;

export function parseDecompositionProposal(
  input: unknown,
): DecompositionProposal {
  return DecompositionProposalSchema.parse(input);
}

export function decompositionProposalHash(
  proposal: DecompositionProposal,
): string {
  return createHash("sha256")
    .update(JSON.stringify(proposal), "utf8")
    .digest("hex");
}

export function programInputContextFingerprint(program: Program): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        criteria: program.rootIntent.acceptanceCriteria,
        constraints: program.rootIntent.constraints,
        envelopeHash: program.authorityFreeze.delegationEnvelopeHash,
        nonGoals: program.rootIntent.nonGoals,
        outcome: program.rootIntent.requestedOutcome,
        programId: program.programId,
        programVersion: program.programVersion,
      }),
      "utf8",
    )
    .digest("hex");
}

export interface ProgramDecompositionModel {
  decompose(input: {
    program: Program;
    revisionAttempt: number;
    priorFindings?: readonly { code: string; message: string }[];
  }): Promise<DecompositionProposal>;
}

/**
 * Deterministic fake model for tests and offline operation.
 * Produces a bounded linear pipeline covering all root criteria.
 */
export class FakeProgramDecompositionModel
  implements ProgramDecompositionModel
{
  constructor(
    private readonly overrides?: (
      program: Program,
      revisionAttempt: number,
    ) => DecompositionProposal,
  ) {}

  async decompose(input: {
    program: Program;
    revisionAttempt: number;
  }): Promise<DecompositionProposal> {
    if (this.overrides) {
      return this.overrides(input.program, input.revisionAttempt);
    }
    const program = input.program;
    const env = program.requestedEnvironment;
    const projectId = program.projectId;
    const caps = program.delegationEnvelope.allowedCapabilityIds.slice(0, 2);
    const repos =
      program.delegationEnvelope.allowedRepositoryIdentities.slice(0, 1);
    const childBudget = {
      llmCalls: 1,
      totalTokens: 1_000,
      apiCalls: 1,
      executionMinutes: 1,
      estimatedCost: 1,
      humanReviewMinutes: 1,
      planSteps: 1,
      parallelWorkstreams: 1,
      revisionAttempts: 1,
    };
    const criteria = program.rootIntent.acceptanceCriteria;
    const children: DecompositionChildProposal[] = criteria.map(
      (criterion, index) => ({
        title: `Step ${index + 1}: ${criterion.slice(0, 48)}`,
        requestedOutcome: criterion,
        acceptanceCriteria: [criterion],
        nonGoals: [...program.rootIntent.nonGoals],
        constraints: [...program.rootIntent.constraints],
        priority: program.rootIntent.priority,
        requirement: "REQUIRED" as const,
        requestedProjectId: projectId,
        requestedEnvironment: env,
        requestedCapabilityIds: [...caps],
        requestedRepositoryIdentities: [...repos],
        requestedBudget: childBudget,
        dependsOnTitles:
          index === 0 ? [] : [`Step ${index}: ${criteria[index - 1]!.slice(0, 48)}`],
        criterionBindings: [
          {
            rootCriterionIndex: index,
            childCriterionIndex: 0,
            contributionKind: "SATISFIES" as const,
            evidenceRequirement: "COMPLETION_RECORD" as const,
          },
        ],
      }),
    );
    return {
      children,
      modelProviderId: "fake-program-decomposition/1",
    };
  }
}
