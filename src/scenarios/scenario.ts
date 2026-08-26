import { createHash } from "node:crypto";
import { z } from "zod";
import { PortfolioIntentSchema } from "../portfolio/intent.js";
import { ScenarioAssumptionSchema } from "./assumptions.js";
import { ScenarioError } from "./errors.js";

export const INITIAL_SCENARIO_SET_VERSION = 1;

export const ScenarioDefinitionSchema = z
  .object({
    scenarioId: z.string().min(1),
    scenarioSetId: z.string().min(1),
    name: z.string().min(1).max(200),
    description: z.string().min(1).max(4000),
    /** Optional role label — not an exclusive enum of futures. */
    roleHint: z
      .enum([
        "BASELINE",
        "BASE_CASE",
        "UPSIDE",
        "DOWNSIDE",
        "CONSERVATIVE",
        "AGGRESSIVE",
        "OTHER",
      ])
      .default("OTHER"),
    assumptionOverrides: z.array(ScenarioAssumptionSchema).default([]),
    strategicActionsProposed: z.array(z.string()).default([]),
    portfolioIntentDelta: PortfolioIntentSchema.partial().optional(),
    expectedTimeHorizon: z.string().min(1).max(200),
    riskFactors: z.array(z.string()).default([]),
    dependencies: z.array(z.string()).default([]),
  })
  .strict();

export type ScenarioDefinition = z.infer<typeof ScenarioDefinitionSchema>;

/**
 * Baseline = current strategy + verified state + explicit continuation
 * assumptions. It is NOT automatically "most likely."
 */
export const BASELINE_SEMANTICS =
  "Baseline is continuation under explicit assumptions; not most-likely probability.";

export const ScenarioSetSchema = z
  .object({
    scenarioSetId: z.string().min(1),
    scenarioSetVersion: z.number().int().positive(),
    decisionProblemId: z.string().min(1),
    decisionProblemVersion: z.number().int().positive(),
    scenarios: z.array(ScenarioDefinitionSchema).min(1),
    baselineScenarioId: z.string().min(1),
    assumptionSetHash: z.string().min(1),
    truthSnapshotFingerprint: z.string().min(1),
    scenarioSetHash: z.string().min(1),
    createdAt: z.string().datetime(),
  })
  .strict();

export type ScenarioSet = z.infer<typeof ScenarioSetSchema>;

export function validateScenarioSet(set: Omit<ScenarioSet, "scenarioSetHash">): void {
  const ids = new Set<string>();
  for (const s of set.scenarios) {
    if (ids.has(s.scenarioId)) {
      throw new ScenarioError(
        "SCENARIO_INVALID",
        `Duplicate scenario id ${s.scenarioId}`,
      );
    }
    ids.add(s.scenarioId);
    if (s.scenarioSetId !== set.scenarioSetId) {
      throw new ScenarioError(
        "SCENARIO_SET_INVALID",
        `Scenario ${s.scenarioId} scenarioSetId mismatch`,
      );
    }
  }
  if (!ids.has(set.baselineScenarioId)) {
    throw new ScenarioError(
      "SCENARIO_SET_INVALID",
      `Baseline scenario ${set.baselineScenarioId} missing from set`,
    );
  }
}

export function scenarioSetCanonicalPayload(
  set: Omit<ScenarioSet, "scenarioSetHash">,
): Record<string, unknown> {
  return {
    assumptionSetHash: set.assumptionSetHash,
    baselineScenarioId: set.baselineScenarioId,
    createdAt: set.createdAt,
    decisionProblemId: set.decisionProblemId,
    decisionProblemVersion: set.decisionProblemVersion,
    scenarioSetId: set.scenarioSetId,
    scenarioSetVersion: set.scenarioSetVersion,
    scenarios: [...set.scenarios].sort((a, b) =>
      a.scenarioId.localeCompare(b.scenarioId),
    ),
    truthSnapshotFingerprint: set.truthSnapshotFingerprint,
  };
}

export function computeScenarioSetHash(
  set: Omit<ScenarioSet, "scenarioSetHash">,
): string {
  return createHash("sha256")
    .update(JSON.stringify(scenarioSetCanonicalPayload(set)), "utf8")
    .digest("hex");
}

export function withScenarioSetHash(
  set: Omit<ScenarioSet, "scenarioSetHash">,
): ScenarioSet {
  validateScenarioSet(set);
  const hash = computeScenarioSetHash(set);
  return ScenarioSetSchema.parse({ ...set, scenarioSetHash: hash });
}

export function mintScenarioSetId(input: {
  decisionProblemId: string;
  scenarioSetVersion: number;
}): string {
  return `scs_${input.decisionProblemId}_${input.scenarioSetVersion}`.slice(
    0,
    120,
  );
}

export function mintScenarioId(input: {
  scenarioSetId: string;
  name: string;
}): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex")
    .slice(0, 16);
  return `scn_${digest}`;
}
