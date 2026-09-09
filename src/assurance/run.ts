import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { AssuranceTargetIdentitySchema } from "./target.js";

export const ASSURANCE_RUN_STATUSES = [
  "CREATED",
  "PLANNED",
  "EVALUATING",
  "EVALUATED",
  "FAILED",
  "INCONCLUSIVE",
] as const;

export type AssuranceRunStatus = (typeof ASSURANCE_RUN_STATUSES)[number];

export const AssuranceRunSchema = z
  .object({
    assuranceRunId: z.string().min(1),
    targetIdentity: AssuranceTargetIdentitySchema,
    targetFingerprint: z.string().min(1),
    profileId: z.string().min(1),
    profileVersion: z.number().int().positive(),
    profileHash: z.string().min(1),
    challengePlanId: z.string().min(1).optional(),
    challengePlanHash: z.string().min(1).optional(),
    initiatedByPrincipalId: z.string().min(1),
    institutionalAuthorizationProofId: z.string().min(1),
    environment: z.enum(["TEST", "STAGING", "PRODUCTION"]),
    status: z.enum(ASSURANCE_RUN_STATUSES),
    assessmentId: z.string().min(1).optional(),
    assessmentHash: z.string().min(1).optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    recordRevision: z.number().int().positive(),
  })
  .strict();

export type AssuranceRun = z.infer<typeof AssuranceRunSchema>;

export function mintAssuranceRunId(): string {
  return `arun_${randomUUID()}`;
}

export function compileRunInitiationSubjectBinding(input: {
  assuranceRunId: string;
  targetFingerprint: string;
  profileId: string;
  profileVersion: number;
  profileHash: string;
}): {
  subjectType: string;
  subjectId: string;
  subjectHash: string;
  subjectVersion: number;
  requiredRole: "ASSURANCE_OPERATOR";
  action: "ASSURANCE_RUN_INITIATION";
} {
  const subjectHash = createHash("sha256")
    .update(
      JSON.stringify({
        assuranceRunId: input.assuranceRunId,
        targetFingerprint: input.targetFingerprint,
        profileId: input.profileId,
        profileVersion: input.profileVersion,
        profileHash: input.profileHash,
      }),
      "utf8",
    )
    .digest("hex");
  return {
    subjectType: "ASSURANCE_RUN",
    subjectId: input.assuranceRunId,
    subjectHash,
    subjectVersion: 1,
    requiredRole: "ASSURANCE_OPERATOR",
    action: "ASSURANCE_RUN_INITIATION",
  };
}

export function compileCertificationSubjectBinding(input: {
  assuranceRunId: string;
  targetFingerprint: string;
  profileId: string;
  profileVersion: number;
  profileHash: string;
  assessmentId: string;
  assessmentHash: string;
}): {
  subjectType: string;
  subjectId: string;
  subjectHash: string;
  subjectVersion: number;
  requiredRole: "ASSURANCE_CERTIFIER";
  action: "SYSTEM_CERTIFICATION";
} {
  const subjectHash = createHash("sha256")
    .update(
      JSON.stringify({
        assuranceRunId: input.assuranceRunId,
        targetFingerprint: input.targetFingerprint,
        profileId: input.profileId,
        profileVersion: input.profileVersion,
        profileHash: input.profileHash,
        assessmentId: input.assessmentId,
        assessmentHash: input.assessmentHash,
        action: "SYSTEM_CERTIFICATION",
      }),
      "utf8",
    )
    .digest("hex");
  return {
    subjectType: "SYSTEM_CERTIFICATION",
    subjectId: `${input.assuranceRunId}:${input.assessmentId}`,
    subjectHash,
    subjectVersion: 1,
    requiredRole: "ASSURANCE_CERTIFIER",
    action: "SYSTEM_CERTIFICATION",
  };
}

export function compileRevocationSubjectBinding(input: {
  certificateId: string;
  certificateHash: string;
}): {
  subjectType: string;
  subjectId: string;
  subjectHash: string;
  subjectVersion: number;
  requiredRole: "ASSURANCE_CERTIFIER";
  action: "SYSTEM_CERTIFICATE_REVOCATION";
} {
  const subjectHash = createHash("sha256")
    .update(
      JSON.stringify({
        certificateId: input.certificateId,
        certificateHash: input.certificateHash,
        action: "SYSTEM_CERTIFICATE_REVOCATION",
      }),
      "utf8",
    )
    .digest("hex");
  return {
    subjectType: "SYSTEM_CERTIFICATE_REVOCATION",
    subjectId: input.certificateId,
    subjectHash,
    subjectVersion: 1,
    requiredRole: "ASSURANCE_CERTIFIER",
    action: "SYSTEM_CERTIFICATE_REVOCATION",
  };
}
