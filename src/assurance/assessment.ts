import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { AssuranceControl } from "./control.js";
import type { ControlEvaluation } from "./evaluation.js";
import { createFinding, type AssuranceFinding } from "./finding.js";

export const ASSESSMENT_OUTCOMES = [
  "QUALIFIED",
  "NOT_QUALIFIED",
  "INCONCLUSIVE",
] as const;

export type AssessmentOutcome = (typeof ASSESSMENT_OUTCOMES)[number];

export const AssuranceAssessmentSchema = z
  .object({
    assessmentId: z.string().min(1),
    assuranceRunId: z.string().min(1),
    targetFingerprint: z.string().min(1),
    profileId: z.string().min(1),
    profileVersion: z.number().int().positive(),
    profileHash: z.string().min(1),
    evidenceSetFingerprint: z.string().min(1),
    evaluationSetFingerprint: z.string().min(1),
    outcome: z.enum(ASSESSMENT_OUTCOMES),
    assessmentHash: z.string().min(1),
    assessedAt: z.string().datetime(),
  })
  .strict();

export type AssuranceAssessment = z.infer<typeof AssuranceAssessmentSchema>;

export function computeAssessmentHash(
  input: Omit<AssuranceAssessment, "assessmentHash">,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        assessmentId: input.assessmentId,
        assuranceRunId: input.assuranceRunId,
        targetFingerprint: input.targetFingerprint,
        profileId: input.profileId,
        profileVersion: input.profileVersion,
        profileHash: input.profileHash,
        evidenceSetFingerprint: input.evidenceSetFingerprint,
        evaluationSetFingerprint: input.evaluationSetFingerprint,
        outcome: input.outcome,
        assessedAt: input.assessedAt,
      }),
      "utf8",
    )
    .digest("hex");
}

export function mintAssessmentId(): string {
  return `aassess_${randomUUID()}`;
}

export function finalizeAssessment(input: {
  assuranceRunId: string;
  targetFingerprint: string;
  profileId: string;
  profileVersion: number;
  profileHash: string;
  requiredControls: readonly AssuranceControl[];
  evaluations: readonly ControlEvaluation[];
  evidenceSetFingerprint: string;
  evaluationSetFingerprint: string;
  assessedAt: string;
}): { assessment: AssuranceAssessment; findings: AssuranceFinding[] } {
  const byControl = new Map(
    input.evaluations.map((e) => [e.controlId, e] as const),
  );
  const findings: AssuranceFinding[] = [];
  let hasFail = false;
  let hasInconclusive = false;

  for (const control of input.requiredControls) {
    if (control.criticality === "OPTIONAL") continue;
    const ev = byControl.get(control.controlId);
    if (!ev || ev.result === "NOT_EVALUATED") {
      hasInconclusive = true;
      findings.push(
        createFinding({
          assuranceRunId: input.assuranceRunId,
          controlId: control.controlId,
          severity: control.criticality === "CRITICAL" ? "CRITICAL" : "HIGH",
          code: "CONTROL_NOT_EVALUATED",
          summary: `Required control ${control.controlId} was not evaluated`,
          evidenceIds: [],
          createdAt: input.assessedAt,
        }),
      );
      continue;
    }
    if (ev.result === "FAIL") {
      hasFail = true;
      findings.push(
        createFinding({
          assuranceRunId: input.assuranceRunId,
          controlId: control.controlId,
          severity: "CRITICAL",
          code: "CONTROL_FAILED",
          summary: `Control ${control.controlId} failed: ${ev.reasonCode}`,
          evidenceIds: [...ev.evidenceIds],
          createdAt: input.assessedAt,
        }),
      );
    } else if (ev.result === "INCONCLUSIVE") {
      hasInconclusive = true;
      findings.push(
        createFinding({
          assuranceRunId: input.assuranceRunId,
          controlId: control.controlId,
          severity: "HIGH",
          code: "CONTROL_INCONCLUSIVE",
          summary: `Control ${control.controlId} inconclusive: ${ev.reasonCode}`,
          evidenceIds: [...ev.evidenceIds],
          createdAt: input.assessedAt,
        }),
      );
    }
  }

  const outcome: AssessmentOutcome = hasFail
    ? "NOT_QUALIFIED"
    : hasInconclusive
      ? "INCONCLUSIVE"
      : "QUALIFIED";

  const withoutHash = {
    assessmentId: mintAssessmentId(),
    assuranceRunId: input.assuranceRunId,
    targetFingerprint: input.targetFingerprint,
    profileId: input.profileId,
    profileVersion: input.profileVersion,
    profileHash: input.profileHash,
    evidenceSetFingerprint: input.evidenceSetFingerprint,
    evaluationSetFingerprint: input.evaluationSetFingerprint,
    outcome,
    assessedAt: input.assessedAt,
  };

  return {
    assessment: AssuranceAssessmentSchema.parse({
      ...withoutHash,
      assessmentHash: computeAssessmentHash(withoutHash),
    }),
    findings,
  };
}
