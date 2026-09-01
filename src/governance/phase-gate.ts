import { GovernanceError } from "./errors.js";
import type { InstitutionalGovernancePort } from "./port.js";

/**
 * Phase gate helper:
 *   PHASE_SPECIFIC_ROLE_AUTHORITY AND INSTITUTIONAL_REQUIREMENTS_SATISFIED
 *
 * Order:
 *   assertNoActiveHold → resolveApplicableMandates → proof validation (if applicable)
 *
 * No-op only on authoritative RESOLVED_NONE. Resolution failures fail closed.
 */
export async function assertInstitutionalRequirements(input: {
  port: InstitutionalGovernancePort | undefined;
  requiredRole: string;
  projectId: string;
  environment: string;
  subjectClass: string;
  subjectType: string;
  subjectId: string;
  subjectHash: string;
  subjectVersion?: number;
  action?: string;
  riskLevel?: string;
  materialityContext?: Record<string, number>;
  institutionalProofId?: string;
  atIso: string;
}): Promise<void> {
  if (!input.port) return;

  await input.port.assertNoActiveHold({
    projectId: input.projectId,
    environment: input.environment,
    authorityRole: input.requiredRole,
    subjectClass: input.subjectClass,
    atIso: input.atIso,
  });

  const resolution = await input.port.resolveApplicableMandates({
    requiredRole: input.requiredRole,
    projectId: input.projectId,
    environment: input.environment,
    subjectClass: input.subjectClass,
    atIso: input.atIso,
    ...(input.action !== undefined ? { action: input.action } : {}),
    ...(input.riskLevel !== undefined ? { riskLevel: input.riskLevel } : {}),
    ...(input.materialityContext !== undefined
      ? { materialityContext: input.materialityContext }
      : {}),
  });

  if (resolution.kind === "MANDATE_RESOLUTION_FAILED") {
    throw new GovernanceError(
      "MANDATE_RESOLUTION_FAILED",
      resolution.reason,
    );
  }
  if (resolution.kind === "MANDATE_CONTEXT_INSUFFICIENT") {
    throw new GovernanceError(
      "MANDATE_CONTEXT_INSUFFICIENT",
      resolution.reason,
      { mandateIds: [...resolution.mandateIds] },
    );
  }
  if (resolution.kind === "RESOLVED_NONE") return;

  if (!input.institutionalProofId) {
    throw new GovernanceError(
      "GOVERNANCE_PROOF_REQUIRED",
      `Active institutional mandate requires InstitutionalAuthorizationProof for ${input.requiredRole}`,
      {
        mandateIds: resolution.mandates.map((m) => m.mandateId),
        subjectClass: input.subjectClass,
        requiredRole: input.requiredRole,
      },
    );
  }

  await input.port.validateProof({
    proofId: input.institutionalProofId,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    subjectHash: input.subjectHash,
    ...(input.subjectVersion !== undefined
      ? { subjectVersion: input.subjectVersion }
      : {}),
    requiredRole: input.requiredRole,
    ...(input.action !== undefined ? { action: input.action } : {}),
    projectId: input.projectId,
    environment: input.environment,
    atIso: input.atIso,
  });
}
