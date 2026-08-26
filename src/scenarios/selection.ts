import { createHash } from "node:crypto";
import { z } from "zod";

export const STRATEGY_SELECTION_DECISIONS = [
  "SELECT_SCENARIO",
  "REJECT_ALL",
  "REQUEST_REVISION",
] as const;

export const StrategySelectionDecisionSchema = z.enum(
  STRATEGY_SELECTION_DECISIONS,
);
export type StrategySelectionDecision = z.infer<
  typeof StrategySelectionDecisionSchema
>;

export const StrategySelectionRequestSchema = z
  .object({
    selectionId: z.string().min(1),
    decisionProblemId: z.string().min(1),
    decisionProblemVersion: z.number().int().positive(),
    decisionPackageHash: z.string().min(1),
    scenarioSetHash: z.string().min(1),
    truthSnapshotFingerprint: z.string().min(1),
    policyBundleFingerprint: z.string().min(1),
    capabilitySetFingerprint: z.string().min(1),
    projectConfigurationFingerprint: z.string().min(1),
    subjectHash: z.string().min(1),
    decisionNonceHash: z.string().min(1),
    status: z.enum(["PENDING", "DECIDED", "EXPIRED"]),
    selectorId: z.string().min(1).optional(),
    selectedScenarioId: z.string().min(1).optional(),
    decision: StrategySelectionDecisionSchema.optional(),
    decidedAt: z.string().datetime().optional(),
    expiresAt: z.string().datetime(),
    createdAt: z.string().datetime(),
    recordRevision: z.number().int().min(1),
  })
  .strict();

export type StrategySelectionRequest = z.infer<
  typeof StrategySelectionRequestSchema
>;

export const StrategySelectionRecordSchema = z
  .object({
    selectionRecordId: z.string().min(1),
    selectionId: z.string().min(1),
    decisionProblemId: z.string().min(1),
    decisionProblemVersion: z.number().int().positive(),
    decisionPackageHash: z.string().min(1),
    scenarioSetHash: z.string().min(1),
    selectorId: z.string().min(1),
    decision: StrategySelectionDecisionSchema,
    selectedScenarioId: z.string().min(1).optional(),
    subjectHash: z.string().min(1),
    decisionNonceHash: z.string().min(1),
    decidedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    createdAt: z.string().datetime(),
  })
  .strict();

export type StrategySelectionRecord = z.infer<
  typeof StrategySelectionRecordSchema
>;

/**
 * STRATEGY_SELECTOR ≠ APPROVER ≠ PORTFOLIO_ALLOCATOR ≠ PROGRAM_MATERIALIZER.
 * Selection binds scenario choice only — never capital allocation.
 */
export const STRATEGY_SELECTION_AUTHORITY_BOUNDARIES = {
  strategySelector:
    "STRATEGY_SELECTOR chooses scenario — does not authorize portfolio allocation",
  approver: "Phase 6 APPROVER authorizes execution — not strategy selection",
  portfolioAllocator:
    "PORTFOLIO_ALLOCATOR authorizes capital allocation — not scenario selection",
  programMaterializer:
    "PROGRAM_MATERIALIZER approves decomposition — not scenario selection",
} as const;

export function computeSelectionSubjectHash(input: {
  decisionProblemId: string;
  decisionProblemVersion: number;
  decisionPackageHash: string;
  scenarioSetHash: string;
  truthSnapshotFingerprint: string;
  policyBundleFingerprint: string;
  capabilitySetFingerprint: string;
  projectConfigurationFingerprint: string;
  expiresAt: string;
}): string {
  return createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex");
}

export function mintSelectionId(input: {
  decisionProblemId: string;
  decisionPackageHash: string;
}): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex")
    .slice(0, 16);
  return `ssel_${input.decisionProblemId}_${digest}`.slice(0, 120);
}

export function mintSelectionRecordId(input: {
  selectionId: string;
  decidedAt: string;
}): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex")
    .slice(0, 16);
  return `ssrec_${digest}`;
}

export function assertStrategySelectionDoesNotAllocate(): void {
  // Documentation hook: selection never reserves or allocates capital.
}

export function assertStrategySelectorDistinctFromApprover(): void {
  // Documentation hook.
}

export function assertStrategySelectorDistinctFromPortfolioAllocator(): void {
  // Documentation hook.
}

export function assertStrategySelectorDistinctFromProgramMaterializer(): void {
  // Documentation hook.
}
