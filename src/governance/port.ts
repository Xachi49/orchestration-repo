import type { InstitutionalAuthorizationProof } from "./proof.js";
import type { InstitutionalAuthorityResolution } from "./authority-resolution.js";
import type { MandateResolutionResult } from "./mandate-resolution.js";

/**
 * Shared port for phase services.
 * PHASE_SPECIFIC_ROLE_AUTHORITY AND INSTITUTIONAL_REQUIREMENTS_SATISFIED.
 *
 * When resolveApplicableMandates returns RESOLVED_NONE, phases behave as before.
 */
export interface InstitutionalGovernancePort {
  resolveAuthority(input: {
    principalId: string;
    requiredRole: string;
    projectId: string;
    environment: string;
    action?: string;
    subjectId?: string;
    atIso: string;
  }): Promise<InstitutionalAuthorityResolution>;

  resolveApplicableMandates(input: {
    requiredRole: string;
    projectId: string;
    environment: string;
    subjectClass: string;
    atIso: string;
    action?: string;
    riskLevel?: string;
    materialityContext?: Record<string, number>;
  }): Promise<MandateResolutionResult>;

  validateProof(input: {
    proofId: string;
    subjectType: string;
    subjectId: string;
    subjectHash: string;
    subjectVersion?: number;
    requiredRole: string;
    action?: string;
    projectId: string;
    environment: string;
    atIso: string;
  }): Promise<InstitutionalAuthorizationProof>;

  assertNoActiveHold(input: {
    projectId: string;
    environment: string;
    authorityRole?: string;
    subjectClass?: string;
    atIso: string;
  }): Promise<void>;
}

/** No-op port: no mandates → existing phase behavior unchanged. */
export class NoopInstitutionalGovernancePort
  implements InstitutionalGovernancePort
{
  async resolveAuthority(input: {
    principalId: string;
    requiredRole: string;
    projectId: string;
    environment: string;
    atIso: string;
  }): Promise<InstitutionalAuthorityResolution> {
    return {
      outcome: "AUTHORIZED",
      principalId: input.principalId,
      requiredRole: input.requiredRole,
      projectId: input.projectId,
      environment: input.environment,
      directGrantIds: [],
      delegationChain: [],
      mandateIds: [],
      mandateVersions: [],
      mandateHashes: [],
      scope: {
        projectIds: [input.projectId],
        environments: [input.environment],
      },
      reasons: ["NoopInstitutionalGovernancePort — no institutional constraints"],
      sourceAuthorityFingerprint: "noop",
      institutionalAuthorityFingerprint: "noop",
      resolvedAt: input.atIso,
    };
  }

  async resolveApplicableMandates(): Promise<MandateResolutionResult> {
    return { kind: "RESOLVED_NONE" };
  }

  async validateProof(): Promise<InstitutionalAuthorizationProof> {
    throw new Error("NoopInstitutionalGovernancePort has no proofs");
  }

  async assertNoActiveHold(): Promise<void> {
    // no holds
  }
}
