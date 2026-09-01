import { z } from "zod";
import { GovernanceError } from "./errors.js";

export const SeparationOfDutyRuleSchema = z
  .object({
    ruleId: z.string().min(1),
    kind: z.literal("FORBID_SAME_PRINCIPAL"),
    roleA: z.string().min(1),
    roleB: z.string().min(1),
    notes: z.string().max(2000).default(""),
  })
  .strict();

export type SeparationOfDutyRule = z.infer<typeof SeparationOfDutyRuleSchema>;

/**
 * Enforce FORBID_SAME_PRINCIPAL between named roles/stages.
 * Mandates specify required separations — not every possible pair globally.
 */
export function assertSeparationOfDuties(input: {
  rules: readonly SeparationOfDutyRule[];
  /** Map role → principalId that occupied that seat (approvals). */
  roleOccupancy: ReadonlyMap<string, string>;
}): void {
  for (const rule of input.rules) {
    if (rule.kind !== "FORBID_SAME_PRINCIPAL") continue;
    const a = input.roleOccupancy.get(rule.roleA);
    const b = input.roleOccupancy.get(rule.roleB);
    if (a && b && a === b) {
      throw new GovernanceError(
        "SEPARATION_OF_DUTIES_VIOLATION",
        `Principal ${a} cannot occupy both ${rule.roleA} and ${rule.roleB}`,
        { ruleId: rule.ruleId, principalId: a },
      );
    }
  }
}

/**
 * Approval laundering: holding an unrelated role never satisfies a required role.
 */
export function assertExactRole(
  heldRole: string,
  requiredRole: string,
  principalId: string,
): void {
  if (heldRole !== requiredRole) {
    throw new GovernanceError(
      "APPROVAL_LAUNDERING",
      `Principal ${principalId} holds ${heldRole} but required exact role ${requiredRole}`,
      { heldRole, requiredRole, principalId },
    );
  }
}
