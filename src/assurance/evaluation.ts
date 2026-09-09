import { createHash } from "node:crypto";
import { z } from "zod";
import { ASSURANCE_EVALUATOR_VERSION } from "./doctrine.js";
import type { AssuranceControl } from "./control.js";
import {
  isAdmissibleEvidenceQuality,
  type AssuranceEvidenceRecord,
} from "./evidence.js";

export const CONTROL_EVALUATION_RESULTS = [
  "PASS",
  "FAIL",
  "INCONCLUSIVE",
  "NOT_EVALUATED",
] as const;

export type ControlEvaluationResult =
  (typeof CONTROL_EVALUATION_RESULTS)[number];

export const ControlEvaluationSchema = z
  .object({
    evaluationId: z.string().min(1),
    controlId: z.string().min(1),
    controlVersion: z.string().min(1),
    targetFingerprint: z.string().min(1),
    evidenceIds: z.array(z.string().min(1)),
    evidenceHashes: z.array(z.string().min(1)),
    evaluatorVersion: z.string().min(1),
    result: z.enum(CONTROL_EVALUATION_RESULTS),
    reasonCode: z.string().min(1),
    evaluatedAt: z.string().datetime(),
  })
  .strict();

export type ControlEvaluation = z.infer<typeof ControlEvaluationSchema>;

export function evaluateControl(input: {
  control: AssuranceControl;
  targetFingerprint: string;
  evidence: readonly AssuranceEvidenceRecord[];
  evaluatedAt: string;
  evaluationId: string;
}): ControlEvaluation {
  const relevant = input.evidence.filter((e) =>
    e.controlIds.includes(input.control.controlId),
  );

  let result: ControlEvaluationResult = "NOT_EVALUATED";
  let reasonCode = "NO_EVIDENCE";

  if (relevant.length === 0) {
    result = "INCONCLUSIVE";
    reasonCode = "MISSING_REQUIRED_EVIDENCE";
  } else {
    const admissible = relevant.filter((e) =>
      isAdmissibleEvidenceQuality(e.evidenceQuality),
    );
    const fails = admissible.filter((e) => e.resultCode === "FAIL");
    const passes = admissible.filter((e) => e.resultCode === "PASS");
    const inconclusive = admissible.filter(
      (e) => e.resultCode === "INCONCLUSIVE",
    );
    const hasContradiction =
      fails.length > 0 &&
      passes.length > 0 &&
      (input.control.evaluationPolicy === "CONTRADICTION_IS_FAIL" ||
        input.control.evaluationPolicy === "CONTRADICTION_IS_INCONCLUSIVE" ||
        input.control.evaluationPolicy === "ALL_DIRECT_OR_REPRODUCED_PASS" ||
        input.control.evaluationPolicy === "ANY_FAIL_BLOCKS");

    if (fails.length > 0 && passes.length > 0) {
      if (input.control.evaluationPolicy === "CONTRADICTION_IS_INCONCLUSIVE") {
        result = "INCONCLUSIVE";
        reasonCode = "CONTRADICTORY_EVIDENCE";
      } else {
        result = "FAIL";
        reasonCode = "CONTRADICTORY_EVIDENCE";
      }
    } else if (fails.length > 0) {
      result = "FAIL";
      reasonCode = "EVIDENCE_FAIL";
    } else if (admissible.length === 0) {
      result = "INCONCLUSIVE";
      reasonCode = "EVIDENCE_QUALITY_INSUFFICIENT";
    } else if (inconclusive.length > 0 && passes.length === 0) {
      result = "INCONCLUSIVE";
      reasonCode = "EVIDENCE_INCONCLUSIVE";
    } else if (passes.length > 0) {
      const kindsPresent = new Set(admissible.map((e) => e.evidenceKind));
      const missingKind = input.control.requiredEvidenceKinds.some(
        (k) => !kindsPresent.has(k),
      );
      if (missingKind) {
        result = "INCONCLUSIVE";
        reasonCode = "MISSING_REQUIRED_EVIDENCE_KIND";
      } else {
        result = "PASS";
        reasonCode = "ALL_ADMISSIBLE_PASS";
      }
    } else {
      result = "INCONCLUSIVE";
      reasonCode = "NO_ADMISSIBLE_PASS";
    }
    void hasContradiction;
  }

  return ControlEvaluationSchema.parse({
    evaluationId: input.evaluationId,
    controlId: input.control.controlId,
    controlVersion: input.control.controlVersion,
    targetFingerprint: input.targetFingerprint,
    evidenceIds: relevant.map((e) => e.evidenceId).sort(),
    evidenceHashes: relevant.map((e) => e.contentHash).sort(),
    evaluatorVersion: ASSURANCE_EVALUATOR_VERSION,
    result,
    reasonCode,
    evaluatedAt: input.evaluatedAt,
  });
}

export function computeEvaluationSetFingerprint(
  evaluations: readonly ControlEvaluation[],
): string {
  const sorted = [...evaluations]
    .map((e) => ({
      controlId: e.controlId,
      result: e.result,
      reasonCode: e.reasonCode,
      evidenceHashes: [...e.evidenceHashes].sort(),
    }))
    .sort((a, b) => a.controlId.localeCompare(b.controlId));
  return createHash("sha256")
    .update(JSON.stringify({ evaluations: sorted }), "utf8")
    .digest("hex");
}
