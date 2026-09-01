import { z } from "zod";

export const QUORUM_KINDS = [
  "ANY_ONE",
  "K_OF_N",
  "ALL_OF",
  "ROLE_SET",
] as const;

export type QuorumKind = (typeof QUORUM_KINDS)[number];

export const GovernanceQuorumRequirementSchema = z
  .object({
    kind: z.enum(QUORUM_KINDS),
    /** For K_OF_N: required distinct principals. */
    k: z.number().int().positive().optional(),
    /** Candidate principal pool size hint / required seats for ALL_OF. */
    n: z.number().int().positive().optional(),
    /** For ROLE_SET: each seat is a distinct required authority role. */
    roles: z.array(z.string().min(1)).default([]),
    /**
     * Rejection policy.
     * ROLE_SET default: one REJECT from a required seat → BLOCKED.
     * K_OF_N: optional rejectThreshold (number of rejects that block).
     */
    rejectBlocksImmediately: z.boolean().default(true),
    rejectThreshold: z.number().int().positive().optional(),
  })
  .strict();

export type GovernanceQuorumRequirement = z.infer<
  typeof GovernanceQuorumRequirementSchema
>;

export type QuorumEvaluationOutcome = "PENDING" | "SATISFIED" | "BLOCKED";

export interface QuorumSeatContribution {
  principalId: string;
  authorityRole: string;
  decision: "APPROVE" | "REJECT";
  attestationId: string;
}

/**
 * Deterministic quorum evaluator. Model has zero role.
 * Same principal cannot count twice toward the same quorum.
 */
export function evaluateGovernanceQuorum(input: {
  requirement: GovernanceQuorumRequirement;
  contributions: readonly QuorumSeatContribution[];
}): {
  outcome: QuorumEvaluationOutcome;
  distinctApprovingPrincipals: string[];
  reasons: string[];
} {
  const reasons: string[] = [];
  const req = input.requirement;

  const rejects = input.contributions.filter((c) => c.decision === "REJECT");
  if (req.rejectBlocksImmediately && rejects.length > 0) {
    if (req.kind === "ROLE_SET" || req.kind === "ALL_OF" || req.kind === "ANY_ONE") {
      return {
        outcome: "BLOCKED",
        distinctApprovingPrincipals: [],
        reasons: [
          `Valid REJECT from ${rejects[0]!.principalId} blocks quorum (rejectBlocksImmediately)`,
        ],
      };
    }
    if (
      req.kind === "K_OF_N" &&
      req.rejectThreshold !== undefined &&
      rejects.length >= req.rejectThreshold
    ) {
      return {
        outcome: "BLOCKED",
        distinctApprovingPrincipals: [],
        reasons: [`Reject threshold ${req.rejectThreshold} reached`],
      };
    }
  }

  const approvals = input.contributions.filter((c) => c.decision === "APPROVE");
  // Same principal cannot count twice
  const byPrincipal = new Map<string, QuorumSeatContribution>();
  for (const a of approvals) {
    const existing = byPrincipal.get(a.principalId);
    if (!existing) {
      byPrincipal.set(a.principalId, a);
    } else if (existing.authorityRole !== a.authorityRole) {
      // Same principal attempting multiple seats — only one seat counts unless ROLE_SET forbids
      reasons.push(
        `Principal ${a.principalId} already counted; duplicate seat ignored`,
      );
    }
  }
  const distinct = [...byPrincipal.values()];
  const distinctPrincipals = distinct.map((d) => d.principalId);

  switch (req.kind) {
    case "ANY_ONE": {
      if (distinct.length >= 1) {
        return {
          outcome: "SATISFIED",
          distinctApprovingPrincipals: distinctPrincipals,
          reasons,
        };
      }
      return {
        outcome: "PENDING",
        distinctApprovingPrincipals: distinctPrincipals,
        reasons: [...reasons, "Need any one distinct approving principal"],
      };
    }
    case "K_OF_N": {
      const k = req.k ?? 1;
      if (distinct.length >= k) {
        return {
          outcome: "SATISFIED",
          distinctApprovingPrincipals: distinctPrincipals,
          reasons,
        };
      }
      return {
        outcome: "PENDING",
        distinctApprovingPrincipals: distinctPrincipals,
        reasons: [
          ...reasons,
          `Need ${k} distinct approving principals (have ${distinct.length})`,
        ],
      };
    }
    case "ALL_OF": {
      const n = req.n ?? req.roles.length;
      if (n <= 0) {
        return {
          outcome: "BLOCKED",
          distinctApprovingPrincipals: [],
          reasons: ["ALL_OF requires n > 0 or roles"],
        };
      }
      if (distinct.length >= n) {
        return {
          outcome: "SATISFIED",
          distinctApprovingPrincipals: distinctPrincipals,
          reasons,
        };
      }
      return {
        outcome: "PENDING",
        distinctApprovingPrincipals: distinctPrincipals,
        reasons: [
          ...reasons,
          `Need all ${n} distinct approving principals (have ${distinct.length})`,
        ],
      };
    }
    case "ROLE_SET": {
      const needed = [...new Set(req.roles)];
      if (needed.length === 0) {
        return {
          outcome: "BLOCKED",
          distinctApprovingPrincipals: [],
          reasons: ["ROLE_SET requires roles"],
        };
      }
      const filled = new Set<string>();
      const usedPrincipals = new Set<string>();
      for (const role of needed) {
        const seat = approvals.find(
          (a) =>
            a.authorityRole === role && !usedPrincipals.has(a.principalId),
        );
        if (seat) {
          filled.add(role);
          usedPrincipals.add(seat.principalId);
        }
      }
      if (filled.size === needed.length) {
        return {
          outcome: "SATISFIED",
          distinctApprovingPrincipals: [...usedPrincipals],
          reasons,
        };
      }
      const missing = needed.filter((r) => !filled.has(r));
      return {
        outcome: "PENDING",
        distinctApprovingPrincipals: [...usedPrincipals],
        reasons: [...reasons, `Missing role seats: ${missing.join(",")}`],
      };
    }
    default: {
      const _exhaustive: never = req.kind;
      return _exhaustive;
    }
  }
}
