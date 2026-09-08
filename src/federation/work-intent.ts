import { createHash } from "node:crypto";
import { z } from "zod";
import {
  FederationResourceRequestCeilingSchema,
  type FederationResourceRequestCeiling,
} from "./scope.js";

export const FederatedWorkIntentSchema = z
  .object({
    intentId: z.string().min(1),
    intentVersion: z.number().int().positive(),
    intentHash: z.string().min(1),
    federationId: z.string().min(1),
    agreementId: z.string().min(1),
    agreementVersion: z.number().int().positive(),
    agreementHash: z.string().min(1),
    sourceInstitutionId: z.string().min(1),
    sourceProjectId: z.string().min(1),
    targetInstitutionId: z.string().min(1),
    targetProjectId: z.string().min(1),
    requestedEnvironment: z.string().min(1),
    intentKind: z.literal("OBJECTIVE"),
    requestedOutcome: z.string().min(1),
    acceptanceCriteria: z.array(z.string().min(1)).min(1),
    constraints: z.array(z.string()).default([]),
    nonGoals: z.array(z.string()).default([]),
    priority: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).default("MEDIUM"),
    deadline: z.string().datetime().optional(),
    resourceRequest: FederationResourceRequestCeilingSchema.optional(),
    evidenceReferences: z.array(z.string().min(1)).default([]),
    proposedByPrincipalId: z.string().min(1),
    institutionalAuthorizationProofId: z.string().min(1).optional(),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime().optional(),
    status: z.enum([
      "PROPOSED",
      "ACCEPTED",
      "REJECTED",
      "MATERIALIZED",
      "EXPIRED",
      "WITHDRAWN",
    ]),
  })
  .strict();

export type FederatedWorkIntent = z.infer<typeof FederatedWorkIntentSchema>;

export function computeIntentHash(
  input: Omit<FederatedWorkIntent, "intentHash" | "status">,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        intentId: input.intentId,
        intentVersion: input.intentVersion,
        federationId: input.federationId,
        agreementId: input.agreementId,
        agreementVersion: input.agreementVersion,
        agreementHash: input.agreementHash,
        sourceInstitutionId: input.sourceInstitutionId,
        sourceProjectId: input.sourceProjectId,
        targetInstitutionId: input.targetInstitutionId,
        targetProjectId: input.targetProjectId,
        requestedEnvironment: input.requestedEnvironment,
        intentKind: input.intentKind,
        requestedOutcome: input.requestedOutcome,
        acceptanceCriteria: input.acceptanceCriteria,
        constraints: input.constraints,
        nonGoals: input.nonGoals,
        priority: input.priority,
        deadline: input.deadline ?? null,
        resourceRequest: input.resourceRequest ?? null,
        evidenceReferences: [...input.evidenceReferences].sort(),
        proposedByPrincipalId: input.proposedByPrincipalId,
        institutionalAuthorizationProofId:
          input.institutionalAuthorizationProofId ?? null,
        createdAt: input.createdAt,
        expiresAt: input.expiresAt ?? null,
      }),
      "utf8",
    )
    .digest("hex");
}

export function withIntentHash(
  input: Omit<FederatedWorkIntent, "intentHash">,
): FederatedWorkIntent {
  const { status, ...rest } = input;
  return FederatedWorkIntentSchema.parse({
    ...input,
    intentHash: computeIntentHash(rest),
  });
}

export function mintIntentId(input: {
  agreementId: string;
  sourceInstitutionId: string;
  targetInstitutionId: string;
  createdAt: string;
}): string {
  return `fwi_${createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex")
    .slice(0, 24)}`;
}

export function compileWorkProposalSubjectBinding(input: {
  federationId: string;
  agreementId: string;
  agreementVersion: number;
  agreementHash: string;
  intentId: string;
  intentHash: string;
  sourceInstitutionId: string;
  targetInstitutionId: string;
}): {
  subjectType: "FEDERATION_WORK_PROPOSAL";
  subjectId: string;
  subjectHash: string;
  requiredRole: "FEDERATION_NEGOTIATOR";
  action: "FEDERATION_WORK_PROPOSAL";
} {
  const subjectHash = createHash("sha256")
    .update(
      JSON.stringify({
        federationId: input.federationId,
        agreementId: input.agreementId,
        agreementVersion: input.agreementVersion,
        agreementHash: input.agreementHash,
        intentId: input.intentId,
        intentHash: input.intentHash,
        sourceInstitutionId: input.sourceInstitutionId,
        targetInstitutionId: input.targetInstitutionId,
      }),
      "utf8",
    )
    .digest("hex");
  return {
    subjectType: "FEDERATION_WORK_PROPOSAL",
    subjectId: input.intentId,
    subjectHash,
    requiredRole: "FEDERATION_NEGOTIATOR",
    action: "FEDERATION_WORK_PROPOSAL",
  };
}

export type { FederationResourceRequestCeiling };
