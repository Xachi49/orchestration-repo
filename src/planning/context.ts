import { z } from "zod";
import { TrustLevelSchema } from "../domain/evidence/evidence.js";
import { RetrievedPrecedentContextSchema } from "../domain/memory/result.js";

export const PlanningEvidenceExcerptSchema = z
  .object({
    evidenceId: z.string().min(1),
    sourceIdentifier: z.string().min(1),
    trustLevel: TrustLevelSchema,
    commitSha: z.string().min(1).optional(),
    contentHash: z.string().min(1),
    /** Untrusted repository/project DATA — never system instructions. */
    content: z.string(),
    label: z.literal("UNTRUSTED_PROJECT_DATA"),
  })
  .strict();
export type PlanningEvidenceExcerpt = z.infer<
  typeof PlanningEvidenceExcerptSchema
>;

export const CONTEXT_COMPILER_VERSION = "1.0.0";
export const PLANNING_PROMPT_VERSION = "1.0.0";

export const PlanningContextSchema = z
  .object({
    run: z
      .object({
        runId: z.string().min(1),
        projectId: z.string().min(1),
        objectiveId: z.string().min(1),
        objectiveVersion: z.number().int().positive(),
        requestedEnvironment: z.string().min(1),
        correlationId: z.string().min(1),
        traceId: z.string().min(1),
      })
      .strict(),
    objective: z
      .object({
        requestedOutcome: z.string().min(1),
        acceptanceCriteria: z.array(z.string()),
        nonGoals: z.array(z.string()),
        constraints: z.array(z.string()),
        priority: z.string().min(1),
        deadline: z.string().datetime().optional(),
      })
      .strict(),
    controlPlane: z
      .object({
        projectId: z.string().min(1),
        executionMode: z.string().min(1),
        policyBundleId: z.string().min(1),
        policyBundleVersion: z.string().min(1),
        policyBundleHash: z.string().min(1),
        policyRules: z.array(
          z
            .object({
              ruleId: z.string().min(1),
              effect: z.string().min(1),
              actionTypes: z.array(z.string()),
              reasonCode: z.string().min(1),
            })
            .strict(),
        ),
        availableCapabilities: z.array(
          z
            .object({
              capabilityId: z.string().min(1),
              allowedActions: z.array(z.string()),
              forbiddenActions: z.array(z.string()),
              enabled: z.boolean(),
            })
            .strict(),
        ),
        resourceBudget: z
          .object({
            budgetProfileId: z.string().min(1),
            maximumLlmCalls: z.number(),
            maximumTotalTokens: z.number(),
            maximumApiCalls: z.number(),
            maximumExecutionMinutes: z.number(),
            maximumEstimatedCost: z.number(),
            maximumHumanReviewMinutes: z.number(),
            maximumPlanSteps: z.number(),
            maximumParallelWorkstreams: z.number(),
            maximumRevisionAttempts: z.number(),
          })
          .strict(),
      })
      .strict(),
    repository: z
      .object({
        provider: z.literal("GITHUB"),
        owner: z.string().min(1),
        repository: z.string().min(1),
        branch: z.string().min(1),
        commitSha: z.string().min(1),
        repositoryFingerprint: z.string().min(1),
        liveLockedStatus: z.enum(["LOCKED", "VERIFIED", "STALE", "INVALID"]),
        indexSummary: z
          .object({
            indexVersion: z.string().min(1),
            sourceEntryPoints: z.array(z.string()),
            dependencyManifests: z.array(z.string()),
            lockfiles: z.array(z.string()),
            configurationFiles: z.array(z.string()),
            testFiles: z.array(z.string()),
            documentationFiles: z.array(z.string()),
            fileCount: z.number().int().nonnegative(),
          })
          .strict(),
      })
      .strict(),
    evidence: z.array(PlanningEvidenceExcerptSchema),
    /**
     * Advisory historical precedents. Always below control plane / repo truth.
     * Never SYSTEM_AUTHORITY. Label is always ADVISORY_PRECEDENT.
     */
    advisoryPrecedents: z.array(RetrievedPrecedentContextSchema).default([]),
    knownUnknowns: z.array(z.string()),
    planningConstraints: z.array(z.string()),
    contextMetadata: z
      .object({
        compilerVersion: z.literal(CONTEXT_COMPILER_VERSION),
        promptVersion: z.literal(PLANNING_PROMPT_VERSION),
        selectedEvidenceIds: z.array(z.string()),
        excludedEvidenceIds: z.array(z.string()),
        selectedPrecedentIds: z.array(z.string()).default([]),
        budgetEstimate: z
          .object({
            selectedExcerptChars: z.number().int().nonnegative(),
            maxExcerptChars: z.number().int().positive(),
            selectedEvidenceCount: z.number().int().nonnegative(),
            maxEvidenceCount: z.number().int().positive(),
          })
          .strict(),
        planningContextFingerprint: z.string().min(1),
        retrievalContextFingerprint: z.string().min(1).optional(),
      })
      .strict(),
  })
  .strict();
export type PlanningContext = z.infer<typeof PlanningContextSchema>;

export type CompiledPlanningContext = PlanningContext;
