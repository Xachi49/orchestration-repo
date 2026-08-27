import { createHash } from "node:crypto";
import { z } from "zod";
import { CausalError } from "./errors.js";
import type { CausalEstimate } from "./estimator.js";
import { assertSameUnitForPooling } from "./estimator.js";

export const SYNTHESIS_STATUSES = [
  "CONSISTENT",
  "MIXED",
  "CONTRADICTORY",
  "INSUFFICIENT",
] as const;

export const SynthesisStatusSchema = z.enum(SYNTHESIS_STATUSES);
export type SynthesisStatus = z.infer<typeof SynthesisStatusSchema>;

export const ContradictionFindingSchema = z
  .object({
    kind: z.enum([
      "DIRECTION_CONFLICT",
      "MAGNITUDE_CONFLICT",
      "IDENTIFICATION_CONFLICT",
      "SCOPE_MISMATCH",
      "MEASUREMENT_MISMATCH",
    ]),
    leftEstimateId: z.string().min(1),
    rightEstimateId: z.string().min(1),
    detail: z.string().min(1),
  })
  .strict();

export type ContradictionFinding = z.infer<typeof ContradictionFindingSchema>;

export const CausalEvidenceSynthesisSchema = z
  .object({
    evidenceSynthesisId: z.string().min(1),
    causalQuestionId: z.string().min(1),
    supportingEstimateIds: z.array(z.string().min(1)).default([]),
    contradictingEstimateIds: z.array(z.string().min(1)).default([]),
    contradictions: z.array(ContradictionFindingSchema).default([]),
    scopeCompatibility: z.array(z.string()).default([]),
    qualityAssessment: z.string().min(1),
    heterogeneityAssessment: z.string().min(1),
    synthesisStatus: SynthesisStatusSchema,
    pooledEstimate: z.number().finite().optional(),
    pooledUnit: z.string().min(1).optional(),
    synthesisHash: z.string().min(1),
    limitations: z.array(z.string()).default([]),
    createdAt: z.string().datetime(),
  })
  .strict();

export type CausalEvidenceSynthesis = z.infer<
  typeof CausalEvidenceSynthesisSchema
>;

export function detectContradictions(
  estimates: readonly CausalEstimate[],
  materialityThreshold: number,
): ContradictionFinding[] {
  const findings: ContradictionFinding[] = [];
  for (let i = 0; i < estimates.length; i += 1) {
    for (let j = i + 1; j < estimates.length; j += 1) {
      const left = estimates[i]!;
      const right = estimates[j]!;
      if (left.unit !== right.unit) {
        findings.push({
          kind: "MEASUREMENT_MISMATCH",
          leftEstimateId: left.causalEstimateId,
          rightEstimateId: right.causalEstimateId,
          detail: `unit ${left.unit} vs ${right.unit}`,
        });
        continue;
      }
      const lSign = Math.sign(left.pointEstimate);
      const rSign = Math.sign(right.pointEstimate);
      if (
        lSign !== 0 &&
        rSign !== 0 &&
        lSign !== rSign &&
        Math.abs(left.pointEstimate) >= materialityThreshold &&
        Math.abs(right.pointEstimate) >= materialityThreshold
      ) {
        findings.push({
          kind: "DIRECTION_CONFLICT",
          leftEstimateId: left.causalEstimateId,
          rightEstimateId: right.causalEstimateId,
          detail: `${left.pointEstimate} vs ${right.pointEstimate}`,
        });
      } else if (
        Math.abs(left.pointEstimate - right.pointEstimate) >
        Math.max(materialityThreshold * 2, 1e-9)
      ) {
        findings.push({
          kind: "MAGNITUDE_CONFLICT",
          leftEstimateId: left.causalEstimateId,
          rightEstimateId: right.causalEstimateId,
          detail: `magnitude gap ${Math.abs(left.pointEstimate - right.pointEstimate)}`,
        });
      }
    }
  }
  return findings;
}

/**
 * Bounded pooling only when units and estimator semantics match.
 * Otherwise INCOMPARABLE_EFFECTS — no apples + oranges averaging.
 */
export function synthesizeEstimates(input: {
  causalQuestionId: string;
  estimates: readonly CausalEstimate[];
  materialityThreshold: number;
  createdAt: string;
}): CausalEvidenceSynthesis {
  if (input.estimates.length === 0) {
    const empty = {
      evidenceSynthesisId: `ces_${input.causalQuestionId}_empty`,
      causalQuestionId: input.causalQuestionId,
      supportingEstimateIds: [],
      contradictingEstimateIds: [],
      contradictions: [],
      scopeCompatibility: [],
      qualityAssessment: "INSUFFICIENT",
      heterogeneityAssessment: "N/A",
      synthesisStatus: "INSUFFICIENT" as const,
      synthesisHash: "",
      limitations: ["No estimates to synthesize"],
      createdAt: input.createdAt,
    };
    empty.synthesisHash = createHash("sha256")
      .update(JSON.stringify(empty), "utf8")
      .digest("hex");
    return CausalEvidenceSynthesisSchema.parse(empty);
  }

  try {
    for (let i = 1; i < input.estimates.length; i += 1) {
      assertSameUnitForPooling(
        input.estimates[0]!.unit,
        input.estimates[i]!.unit,
      );
      if (
        input.estimates[i]!.estimatorVersion !==
        input.estimates[0]!.estimatorVersion
      ) {
        throw new CausalError(
          "INCOMPARABLE_EFFECTS",
          "Estimator semantics differ; refuse to pool",
        );
      }
    }
  } catch (error) {
    if (error instanceof CausalError && error.code === "INCOMPARABLE_EFFECTS") {
      throw error;
    }
    if (error instanceof CausalError && error.code === "UNIT_MIXING_REJECTED") {
      throw new CausalError(
        "INCOMPARABLE_EFFECTS",
        "Units differ; refuse to pool",
        error.details,
      );
    }
    throw error;
  }

  const contradictions = detectContradictions(
    input.estimates,
    input.materialityThreshold,
  );
  const directionConflicts = contradictions.filter(
    (c) => c.kind === "DIRECTION_CONFLICT",
  );
  let synthesisStatus: SynthesisStatus = "CONSISTENT";
  if (directionConflicts.length > 0) {
    synthesisStatus = "CONTRADICTORY";
  } else if (contradictions.length > 0) {
    synthesisStatus = "MIXED";
  }

  const supporting =
    synthesisStatus === "CONSISTENT"
      ? input.estimates.map((e) => e.causalEstimateId)
      : input.estimates
          .filter((e) =>
            !directionConflicts.some(
              (c) =>
                c.leftEstimateId === e.causalEstimateId ||
                c.rightEstimateId === e.causalEstimateId,
            ),
          )
          .map((e) => e.causalEstimateId);
  const contradicting = [
    ...new Set(
      directionConflicts.flatMap((c) => [
        c.leftEstimateId,
        c.rightEstimateId,
      ]),
    ),
  ];

  let pooledEstimate: number | undefined;
  let pooledUnit: string | undefined;
  if (synthesisStatus === "CONSISTENT" && input.estimates.length >= 1) {
    const weights = input.estimates.map(
      (e) => e.treatmentSampleCount + e.controlSampleCount,
    );
    const weightSum = weights.reduce((a, b) => a + b, 0);
    pooledEstimate =
      weightSum > 0
        ? input.estimates.reduce(
            (acc, e, idx) => acc + e.pointEstimate * (weights[idx]! / weightSum),
            0,
          )
        : undefined;
    pooledUnit = input.estimates[0]!.unit;
  }

  const body = {
    evidenceSynthesisId: `ces_${input.causalQuestionId}_${createHash("sha256")
      .update(input.estimates.map((e) => e.estimateHash).sort().join("|"), "utf8")
      .digest("hex")
      .slice(0, 12)}`,
    causalQuestionId: input.causalQuestionId,
    supportingEstimateIds: supporting,
    contradictingEstimateIds: contradicting,
    contradictions,
    scopeCompatibility: ["same_question_binding"],
    qualityAssessment: synthesisStatus,
    heterogeneityAssessment:
      contradictions.length === 0 ? "LOW" : "HIGH",
    synthesisStatus,
    ...(pooledEstimate !== undefined ? { pooledEstimate, pooledUnit } : {}),
    limitations:
      synthesisStatus === "CONTRADICTORY"
        ? [
            "Direction conflict preserved — no silent pooled strong claim",
            "Human review cannot erase contradiction metadata",
          ]
        : [],
    createdAt: input.createdAt,
  };
  const synthesisHash = createHash("sha256")
    .update(JSON.stringify(body), "utf8")
    .digest("hex");
  return CausalEvidenceSynthesisSchema.parse({ ...body, synthesisHash });
}
