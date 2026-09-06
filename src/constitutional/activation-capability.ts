import { createHash } from "node:crypto";
import type { ProtectedGovernanceMutation } from "./protected-mutations.js";

export interface ConstitutionalActivationCapabilityPayload {
  proposalId: string;
  proposalHash: string;
  proposalVersion: number;
  activationRecordId: string;
  baseGovernanceFingerprint: string;
  institutionId: string;
  activatedByPrincipalId: string;
  /** Compiled mutation plan hash — binds capability to exact authorized ops. */
  mutationPlanHash: string;
  /**
   * Protected Phase20 methods authorized by this activation's compiled plan.
   * Institution match alone must never authorize an unbound mutation.
   */
  authorizedProtectedMutations: readonly ProtectedGovernanceMutation[];
}

const mintedCapabilities = new WeakSet<object>();

/**
 * Unforgeable runtime capability — only minted by Phase 21 activation after
 * authoritative activation-record binding validation.
 *
 * Authenticity = class identity + WeakSet mint membership (process-local).
 * Scope = frozen payload (institution, proposal identity, plan hash, authorized
 * protected mutations). Gates must verify authenticity AND scope — never
 * WeakSet membership alone.
 */
export class ConstitutionalActivationCapability {
  readonly payload: Readonly<ConstitutionalActivationCapabilityPayload>;

  private constructor(payload: ConstitutionalActivationCapabilityPayload) {
    this.payload = Object.freeze({
      ...payload,
      authorizedProtectedMutations: Object.freeze([
        ...payload.authorizedProtectedMutations,
      ]),
    });
    mintedCapabilities.add(this);
  }

  static mint(
    payload: ConstitutionalActivationCapabilityPayload,
  ): ConstitutionalActivationCapability {
    return new ConstitutionalActivationCapability(payload);
  }

  static isCapability(
    value: unknown,
  ): value is ConstitutionalActivationCapability {
    return (
      value instanceof ConstitutionalActivationCapability &&
      mintedCapabilities.has(value)
    );
  }

  authorizesProtectedMutation(mutation: ProtectedGovernanceMutation): boolean {
    return this.payload.authorizedProtectedMutations.includes(mutation);
  }

  capabilityFingerprint(): string {
    return createHash("sha256")
      .update(JSON.stringify(this.payload), "utf8")
      .digest("hex");
  }
}
