import { z } from "zod";
import { PrecedentApplicabilitySchema } from "../domain/memory/applicability.js";
import type { GovernedMemoryService } from "./service.js";

/**
 * Local fake human review applicator for precedent promotion.
 * No external UI/integration required.
 */
export const PrecedentReviewRequestSchema = z
  .object({
    reviewerId: z.string().min(1),
    decision: z.enum(["PROMOTE", "REJECT", "REQUEST_NARROWER_SCOPE"]),
    approvedApplicability: PrecedentApplicabilitySchema.optional(),
    note: z.string().optional(),
  })
  .strict();

export type PrecedentReviewRequest = z.infer<
  typeof PrecedentReviewRequestSchema
>;

export class LocalPrecedentReviewApplicator {
  constructor(private readonly memory: GovernedMemoryService) {}

  async apply(
    learningCandidateId: string,
    body: unknown,
  ): Promise<
    Awaited<ReturnType<GovernedMemoryService["reviewCandidate"]>>
  > {
    const parsed = PrecedentReviewRequestSchema.parse(body);
    return this.memory.reviewCandidate({
      learningCandidateId,
      reviewerId: parsed.reviewerId,
      decision: parsed.decision,
      ...(parsed.approvedApplicability !== undefined
        ? { approvedApplicability: parsed.approvedApplicability }
        : {}),
      ...(parsed.note !== undefined ? { note: parsed.note } : {}),
    });
  }
}
