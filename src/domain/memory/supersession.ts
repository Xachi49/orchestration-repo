import { z } from "zod";

/**
 * Explicit supersession link. Old precedent ACTIVE → SUPERSEDED;
 * new version references old. History is never deleted.
 */
export const PrecedentSupersessionSchema = z
  .object({
    supersessionId: z.string().min(1),
    supersededPrecedentId: z.string().min(1),
    supersededVersion: z.number().int().positive(),
    supersedingPrecedentId: z.string().min(1),
    supersedingVersion: z.number().int().positive(),
    reason: z.string().min(1),
    createdAt: z.string().datetime(),
  })
  .strict();

export type PrecedentSupersession = z.infer<typeof PrecedentSupersessionSchema>;

export function parsePrecedentSupersession(
  input: unknown,
): PrecedentSupersession {
  return PrecedentSupersessionSchema.parse(input);
}
