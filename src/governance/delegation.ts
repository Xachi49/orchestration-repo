import { createHash } from "node:crypto";
import { z } from "zod";
import { GovernanceError } from "./errors.js";

export const DELEGATION_STATES = [
  "PROPOSED",
  "ACTIVE",
  "SUSPENDED",
  "EXPIRED",
  "REVOKED",
  "SUPERSEDED",
] as const;

export type DelegationState = (typeof DELEGATION_STATES)[number];

export const AuthorityDelegationSchema = z
  .object({
    delegationId: z.string().min(1),
    delegationVersion: z.number().int().positive(),
    delegatorPrincipalId: z.string().min(1),
    delegatePrincipalId: z.string().min(1),
    authorityRole: z.string().min(1),
    projectScope: z.array(z.string().min(1)).min(1),
    environmentScope: z.array(z.string().min(1)).min(1),
    actionScope: z.array(z.string().min(1)).default([]),
    subjectScope: z.array(z.string().min(1)).default([]),
    effectiveFrom: z.string().datetime(),
    effectiveUntil: z.string().datetime(),
    maximumRisk: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
    maximumResourceEnvelope: z
      .record(z.string(), z.number().finite().nonnegative())
      .default({}),
    sourceAuthorityGrantIds: z.array(z.string().min(1)).default([]),
    sourceDelegationIds: z.array(z.string().min(1)).default([]),
    delegationDepth: z.number().int().nonnegative(),
    reason: z.string().min(1).max(4000),
    status: z.enum(DELEGATION_STATES),
    delegationHash: z.string().min(1),
    createdAt: z.string().datetime(),
    recordRevision: z.number().int().min(1),
  })
  .strict();

export type AuthorityDelegation = z.infer<typeof AuthorityDelegationSchema>;

export function computeDelegationHash(
  input: Omit<AuthorityDelegation, "delegationHash" | "recordRevision">,
): string {
  return createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex");
}

export function withDelegationHash(
  input: Omit<AuthorityDelegation, "delegationHash">,
): AuthorityDelegation {
  const { recordRevision: _r, ...rest } = input;
  void _r;
  const delegationHash = computeDelegationHash(rest);
  return AuthorityDelegationSchema.parse({ ...input, delegationHash });
}

export function mintDelegationId(input: {
  delegatorPrincipalId: string;
  delegatePrincipalId: string;
  createdAt: string;
}): string {
  return `adel_${createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex")
    .slice(0, 16)}`;
}

export interface DelegatorEffectiveScope {
  projectScope: readonly string[];
  environmentScope: readonly string[];
  authorityRole: string;
  effectiveFrom?: string;
  effectiveUntil?: string;
  maximumRisk?: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  maximumResourceEnvelope: Readonly<Record<string, number>>;
  actionScope: readonly string[];
  sourceAuthorityGrantIds: readonly string[];
  sourceDelegationIds: readonly string[];
  delegationDepth: number;
}

const RISK_RANK: Record<string, number> = {
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4,
};

function isSubset(
  inner: readonly string[],
  outer: readonly string[],
): boolean {
  const set = new Set(outer);
  return inner.every((x) => set.has(x));
}

function envelopeContained(
  inner: Readonly<Record<string, number>>,
  outer: Readonly<Record<string, number>>,
): boolean {
  for (const [k, v] of Object.entries(inner)) {
    const max = outer[k];
    if (max === undefined || v > max) return false;
  }
  return true;
}

/**
 * Delegation may only attenuate. Any expansion → DELEGATION_SCOPE_EXPANSION.
 */
export function assertDelegationAttenuation(input: {
  proposed: {
    projectScope: readonly string[];
    environmentScope: readonly string[];
    authorityRole: string;
    effectiveFrom: string;
    effectiveUntil: string;
    maximumRisk?: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
    maximumResourceEnvelope: Readonly<Record<string, number>>;
    actionScope: readonly string[];
  };
  delegator: DelegatorEffectiveScope;
}): void {
  const { proposed, delegator } = input;
  if (!isSubset(proposed.projectScope, delegator.projectScope)) {
    throw new GovernanceError(
      "DELEGATION_SCOPE_EXPANSION",
      "Delegate projectScope is not ⊆ delegator.projectScope",
    );
  }
  if (!isSubset(proposed.environmentScope, delegator.environmentScope)) {
    throw new GovernanceError(
      "DELEGATION_SCOPE_EXPANSION",
      "Delegate environmentScope is not ⊆ delegator.environmentScope",
    );
  }
  if (proposed.authorityRole !== delegator.authorityRole) {
    throw new GovernanceError(
      "DELEGATION_SCOPE_EXPANSION",
      "Delegate role must equal permitted delegated role",
    );
  }
  const fromOk =
    delegator.effectiveFrom === undefined ||
    Date.parse(proposed.effectiveFrom) >= Date.parse(delegator.effectiveFrom);
  const untilOk =
    delegator.effectiveUntil === undefined ||
    Date.parse(proposed.effectiveUntil) <= Date.parse(delegator.effectiveUntil);
  if (!fromOk || !untilOk) {
    throw new GovernanceError(
      "DELEGATION_SCOPE_EXPANSION",
      "Delegate timeWindow is not ⊆ delegator authority time window",
    );
  }
  if (
    proposed.maximumRisk !== undefined &&
    delegator.maximumRisk !== undefined &&
    (RISK_RANK[proposed.maximumRisk] ?? 99) >
      (RISK_RANK[delegator.maximumRisk] ?? 0)
  ) {
    throw new GovernanceError(
      "DELEGATION_SCOPE_EXPANSION",
      "Delegate risk envelope exceeds delegator",
    );
  }
  if (
    !envelopeContained(
      proposed.maximumResourceEnvelope,
      delegator.maximumResourceEnvelope,
    )
  ) {
    throw new GovernanceError(
      "DELEGATION_SCOPE_EXPANSION",
      "Delegate resource envelope exceeds delegator",
    );
  }
  if (!isSubset(proposed.actionScope, delegator.actionScope)) {
    throw new GovernanceError(
      "DELEGATION_SCOPE_EXPANSION",
      "Delegate actionScope is not ⊆ delegator action scope",
    );
  }
}

/**
 * Detect delegation cycles in the chain of sourceDelegationIds.
 */
export function assertNoDelegationCycle(input: {
  newDelegationId: string;
  delegatePrincipalId: string;
  delegatorPrincipalId: string;
  /** Existing ACTIVE/PROPOSED edges: from → to principal */
  edges: ReadonlyArray<{ from: string; to: string; delegationId: string }>;
}): void {
  if (input.delegatorPrincipalId === input.delegatePrincipalId) {
    throw new GovernanceError(
      "AUTHORITY_DELEGATION_CYCLE",
      "Self-delegation is a cycle",
    );
  }
  const adj = new Map<string, string[]>();
  for (const e of input.edges) {
    const list = adj.get(e.from) ?? [];
    list.push(e.to);
    adj.set(e.from, list);
  }
  // Add proposed edge
  const proposed = adj.get(input.delegatorPrincipalId) ?? [];
  proposed.push(input.delegatePrincipalId);
  adj.set(input.delegatorPrincipalId, proposed);

  const visited = new Set<string>();
  const stack = new Set<string>();
  const dfs = (node: string): boolean => {
    if (stack.has(node)) return true;
    if (visited.has(node)) return false;
    visited.add(node);
    stack.add(node);
    for (const next of adj.get(node) ?? []) {
      if (dfs(next)) return true;
    }
    stack.delete(node);
    return false;
  };
  if (dfs(input.delegatorPrincipalId)) {
    throw new GovernanceError(
      "AUTHORITY_DELEGATION_CYCLE",
      "Authority delegation cycle detected",
      { delegationId: input.newDelegationId },
    );
  }
}

export function assertDelegationDepth(
  depth: number,
  maximum: number,
): void {
  if (depth > maximum) {
    throw new GovernanceError(
      "DELEGATION_DEPTH_EXCEEDED",
      `Delegation depth ${depth} exceeds maximum ${maximum}`,
      { depth, maximum },
    );
  }
}
