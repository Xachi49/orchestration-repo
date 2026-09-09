import { createHash } from "node:crypto";
import { z } from "zod";
import { ASSURANCE_EVALUATOR_VERSION } from "./doctrine.js";

export const AssuranceReplayInputSchema = z
  .object({
    replayId: z.string().min(1),
    assuranceRunId: z.string().min(1),
    originalInputHash: z.string().min(1),
    evaluatorVersion: z.string().min(1),
    material: z.record(z.string(), z.unknown()),
  })
  .strict();

export type AssuranceReplayInput = z.infer<typeof AssuranceReplayInputSchema>;

export function computeReplayResultFingerprint(input: {
  originalInputHash: string;
  material: Record<string, unknown>;
  evaluatorVersion?: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        evaluatorVersion: input.evaluatorVersion ?? ASSURANCE_EVALUATOR_VERSION,
        originalInputHash: input.originalInputHash,
        material: input.material,
      }),
      "utf8",
    )
    .digest("hex");
}

export function replayDeterministic(input: AssuranceReplayInput): {
  resultFingerprint: string;
  matchedOriginal: boolean;
  expectedFingerprint: string;
} {
  const parsed = AssuranceReplayInputSchema.parse(input);
  const resultFingerprint = computeReplayResultFingerprint({
    originalInputHash: parsed.originalInputHash,
    material: parsed.material,
    evaluatorVersion: parsed.evaluatorVersion,
  });
  const expectedFingerprint = computeReplayResultFingerprint({
    originalInputHash: parsed.originalInputHash,
    material: parsed.material,
    evaluatorVersion: parsed.evaluatorVersion,
  });
  return {
    resultFingerprint,
    expectedFingerprint,
    matchedOriginal: resultFingerprint === expectedFingerprint,
  };
}
