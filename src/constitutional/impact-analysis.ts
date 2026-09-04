import { createHash } from "node:crypto";
import { z } from "zod";
import type { ConstitutionalChangeOperation } from "./operations.js";
import type { GovernanceMandate } from "../governance/mandate.js";

export const ImpactClassificationSchema = z.enum([
  "TIGHTENING",
  "NEUTRAL",
  "RELAXING",
  "STRUCTURAL",
]);

export type ImpactClassification = z.infer<typeof ImpactClassificationSchema>;

export const ConstitutionalImpactAnalysisSchema = z
  .object({
    impactAnalysisId: z.string().min(1),
    proposalId: z.string().min(1),
    proposalHash: z.string().min(1),
    proposalVersion: z.number().int().positive(),
    baseGovernanceFingerprint: z.string().min(1),
    overallClassification: ImpactClassificationSchema,
    findings: z.array(z.string()).default([]),
    relaxationDetected: z.boolean().default(false),
    lockoutRisk: z.boolean().default(false),
    safetyFloorViolations: z.array(z.string()).default([]),
    analysisHash: z.string().min(1),
    createdAt: z.string().datetime(),
  })
  .strict();

export type ConstitutionalImpactAnalysis = z.infer<
  typeof ConstitutionalImpactAnalysisSchema
>;

export function mintImpactAnalysisId(input: {
  proposalId: string;
  createdAt: string;
}): string {
  return `cia_${createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex")
    .slice(0, 20)}`;
}

export function computeImpactAnalysisHash(
  input: Omit<ConstitutionalImpactAnalysis, "analysisHash" | "impactAnalysisId">,
): string {
  return createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex");
}

function quorumK(requirement: GovernanceMandate["quorumRequirement"]): number {
  if (!requirement) return 1;
  if (requirement.kind === "K_OF_N") return requirement.k ?? 1;
  if (requirement.kind === "ALL_OF") return requirement.roles.length || 1;
  return 1;
}

export function analyzeConstitutionalImpact(input: {
  operations: readonly ConstitutionalChangeOperation[];
  currentMandates: readonly GovernanceMandate[];
  proposalId: string;
  proposalHash: string;
  proposalVersion: number;
  baseGovernanceFingerprint: string;
  createdAt: string;
}): ConstitutionalImpactAnalysis {
  const findings: string[] = [];
  let relaxationDetected = false;
  let lockoutRisk = false;
  let overall: ImpactClassification = "NEUTRAL";

  for (const op of input.operations) {
    if (op.kind === "CHANGE_MANDATE_QUORUM") {
      const current = input.currentMandates.find(
        (m) => m.mandateId === op.mandateId,
      );
      if (current) {
        const oldK = quorumK(current.quorumRequirement);
        const newK = quorumK(op.quorumRequirement);
        if (newK < oldK) {
          relaxationDetected = true;
          findings.push(
            `Quorum reduction on ${op.mandateId}: ${oldK} -> ${newK}`,
          );
          overall = "RELAXING";
        } else if (newK > oldK) {
          findings.push(`Quorum increase on ${op.mandateId}: ${oldK} -> ${newK}`);
          if (overall === "NEUTRAL") overall = "TIGHTENING";
        }
      }
    }
    if (op.kind === "CHANGE_MANDATE_SEPARATION_OF_DUTIES") {
      const current = input.currentMandates.find(
        (m) => m.mandateId === op.mandateId,
      );
      const oldCount = current?.separationOfDutyRules.length ?? 0;
      const newCount = op.separationOfDutyRules.length;
      if (newCount < oldCount) {
        relaxationDetected = true;
        findings.push(`SoD weakening on ${op.mandateId}`);
        overall = "RELAXING";
      }
    }
    if (op.kind === "CHANGE_DELEGATION_LIMITS") {
      const current = input.currentMandates.find(
        (m) => m.mandateId === op.mandateId,
      );
      const oldDepth = current?.maximumDelegationDepth ?? 1;
      if (op.maximumDelegationDepth > oldDepth) {
        relaxationDetected = true;
        findings.push(`Delegation depth increase on ${op.mandateId}`);
        overall = "RELAXING";
      }
    }
    if (op.kind === "CHANGE_MANDATE_SCOPE") {
      const current = input.currentMandates.find(
        (m) => m.mandateId === op.mandateId,
      );
      if (current) {
        if (op.projectScope.length > current.projectScope.length) {
          relaxationDetected = true;
          findings.push(`Project scope widening on ${op.mandateId}`);
          overall = "RELAXING";
        }
        if (op.environmentScope.length > current.environmentScope.length) {
          relaxationDetected = true;
          findings.push(`Environment scope widening on ${op.mandateId}`);
          overall = "RELAXING";
        }
      }
    }
    if (
      op.kind === "CREATE_MANDATE_VERSION" ||
      op.kind === "SUPERSEDE_MANDATE_VERSION"
    ) {
      overall = overall === "NEUTRAL" ? "STRUCTURAL" : overall;
      findings.push(`Structural mandate change: ${op.kind}`);
    }
    if (op.kind === "CHANGE_GOVERNANCE_ADMIN_SCOPE") {
      findings.push(
        `Institution project scope constitutional binding change for ${op.institutionId}`,
      );
      overall = overall === "NEUTRAL" ? "STRUCTURAL" : overall;
    }
    if (op.kind === "RETIRE_ORGANIZATIONAL_UNIT") {
      lockoutRisk = true;
      findings.push(`Organizational unit retirement may affect governance paths`);
    }
  }

  const payload = {
    proposalId: input.proposalId,
    proposalHash: input.proposalHash,
    proposalVersion: input.proposalVersion,
    baseGovernanceFingerprint: input.baseGovernanceFingerprint,
    overallClassification: overall,
    findings,
    relaxationDetected,
    lockoutRisk,
    safetyFloorViolations: [] as string[],
    createdAt: input.createdAt,
  };

  const analysisHash = computeImpactAnalysisHash(payload);
  return ConstitutionalImpactAnalysisSchema.parse({
    impactAnalysisId: mintImpactAnalysisId({
      proposalId: input.proposalId,
      createdAt: input.createdAt,
    }),
    ...payload,
    analysisHash,
  });
}
