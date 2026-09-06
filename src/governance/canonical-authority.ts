import { randomUUID } from "node:crypto";
import { z } from "zod";

/** Canonical durable grant from authority_grants — the sole direct authority source. */
export const CanonicalAuthorityGrantSchema = z
  .object({
    grantId: z.string().min(1),
    principalId: z.string().min(1),
    authorityRole: z.string().min(1),
    projectId: z.string().min(1),
    environmentScope: z.array(z.string().min(1)).min(1),
    enabled: z.boolean().default(true),
    effectiveFrom: z.string().datetime().optional(),
    effectiveUntil: z.string().datetime().optional(),
    actionScope: z.array(z.string().min(1)).default([]),
    maximumRisk: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
    maximumResourceEnvelope: z
      .record(z.string(), z.number().finite().nonnegative())
      .default({}),
  })
  .strict();

export type CanonicalAuthorityGrant = z.infer<
  typeof CanonicalAuthorityGrantSchema
>;

export interface CanonicalAuthorityGrantPort {
  listByPrincipal(principalId: string): Promise<readonly CanonicalAuthorityGrant[]>;
  getById(grantId: string): Promise<CanonicalAuthorityGrant | null>;
  listByProject?(projectId: string): Promise<readonly CanonicalAuthorityGrant[]>;
}

export const OPERATIONAL_PHASE_ROLES = [
  "APPROVER",
  "PROGRAM_MATERIALIZER",
  "PORTFOLIO_ALLOCATOR",
  "STRATEGY_SELECTOR",
  "EXPERIMENT_SPONSOR",
  "CAUSAL_REVIEWER",
  "DECISION_POLICY_APPROVER",
  "DECISION_POLICY_ACTIVATOR",
] as const;

export type OperationalPhaseRole = (typeof OPERATIONAL_PHASE_ROLES)[number];

export function isOperationalPhaseRole(role: string): role is OperationalPhaseRole {
  return (OPERATIONAL_PHASE_ROLES as readonly string[]).includes(role);
}

export class InMemoryCanonicalAuthorityGrantRepository
  implements CanonicalAuthorityGrantPort
{
  private readonly byId = new Map<string, CanonicalAuthorityGrant>();

  async save(grant: CanonicalAuthorityGrant): Promise<CanonicalAuthorityGrant> {
    const parsed = CanonicalAuthorityGrantSchema.parse(grant);
    this.byId.set(parsed.grantId, parsed);
    return parsed;
  }

  async seed(input: {
    principalId: string;
    authorityRole: string;
    projectId: string;
    environmentScope: readonly string[];
    grantId?: string;
    effectiveFrom?: string;
    effectiveUntil?: string;
    actionScope?: readonly string[];
    maximumRisk?: CanonicalAuthorityGrant["maximumRisk"];
    maximumResourceEnvelope?: Record<string, number>;
  }): Promise<CanonicalAuthorityGrant> {
    return this.save({
      grantId: input.grantId ?? randomUUID(),
      principalId: input.principalId,
      authorityRole: input.authorityRole,
      projectId: input.projectId,
      environmentScope: [...input.environmentScope],
      enabled: true,
      actionScope: input.actionScope ? [...input.actionScope] : [],
      maximumResourceEnvelope: input.maximumResourceEnvelope ?? {},
      ...(input.effectiveFrom !== undefined
        ? { effectiveFrom: input.effectiveFrom }
        : {}),
      ...(input.effectiveUntil !== undefined
        ? { effectiveUntil: input.effectiveUntil }
        : {}),
      ...(input.maximumRisk !== undefined
        ? { maximumRisk: input.maximumRisk }
        : {}),
    });
  }

  async listByPrincipal(
    principalId: string,
  ): Promise<readonly CanonicalAuthorityGrant[]> {
    return [...this.byId.values()].filter(
      (g) => g.principalId === principalId && g.enabled,
    );
  }

  async getById(grantId: string): Promise<CanonicalAuthorityGrant | null> {
    const grant = this.byId.get(grantId);
    if (!grant || !grant.enabled) return null;
    return grant;
  }

  async listByProject(
    projectId: string,
  ): Promise<readonly CanonicalAuthorityGrant[]> {
    return [...this.byId.values()].filter(
      (g) => g.projectId === projectId && g.enabled,
    );
  }

  async markDisabled(grantId: string): Promise<CanonicalAuthorityGrant | null> {
    const grant = this.byId.get(grantId);
    if (!grant) return null;
    const next = CanonicalAuthorityGrantSchema.parse({ ...grant, enabled: false });
    this.byId.set(grantId, next);
    return next;
  }
}
