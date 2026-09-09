import type { ClockPort } from "../clock.js";
import type { PostgresDatabase } from "./database.js";
import type { PostgresOrchestratorStack } from "./stack.js";
import { createPostgresOrchestratorStack } from "./stack.js";
import { seedDedicatedPostgresTestProject } from "./test-project-isolation.js";
import { PostgresAuthorityDirectory } from "./repositories/authority-directory.js";
import type { AuthorityGrantSeed } from "./repositories/authority-directory.js";
import { uniquePostgresTestId } from "./test-helpers.js";
import {
  compileCertificationSubjectBinding,
  compileRevocationSubjectBinding,
  compileRunInitiationSubjectBinding,
  mintAssuranceRunId,
} from "../../assurance/run.js";
import { getControlById } from "../../assurance/control.js";
import { mintEvidenceId } from "../../assurance/evidence.js";
import { buildTarget } from "../../assurance/test-fixtures.js";
import type { AssuranceTargetIdentity } from "../../assurance/target.js";
import type { AssuranceProfile } from "../../assurance/profile.js";
import type { AssuranceRun } from "../../assurance/run.js";
import type { SystemCertificate } from "../../assurance/certification.js";

/** Assurance runs use TEST — not EXAMPLE_ENVIRONMENT ("local"). */
export const P23_ENV = "TEST" as const;

export const P23_OPERATOR = "assurance_operator_p23";
export const P23_CERTIFIER = "assurance_certifier_p23";
export const P23_CERTIFIER_Q = "assurance_certifier_q_p23";
export const P23_DUAL = "assurance_dual_p23";
export const P23_GOV_ADMIN = "gov_admin_p23";

export type P23TestEnv = {
  db: PostgresDatabase;
  stack: PostgresOrchestratorStack;
  close: () => Promise<void>;
};

export async function seedP23Authority(
  db: PostgresDatabase,
  projectId: string,
  extra: Array<{
    principalId: string;
    principalType: AuthorityGrantSeed["principalType"];
  }> = [],
): Promise<void> {
  await seedDedicatedPostgresTestProject(db, projectId);
  const authority = new PostgresAuthorityDirectory(db);
  await authority.seed([
    {
      principalId: P23_GOV_ADMIN,
      principalType: "GOVERNANCE_ADMIN",
      projectId,
      environments: [P23_ENV],
    },
    {
      principalId: P23_OPERATOR,
      principalType: "ASSURANCE_OPERATOR",
      projectId,
      environments: [P23_ENV],
    },
    {
      principalId: P23_CERTIFIER,
      principalType: "ASSURANCE_CERTIFIER",
      projectId,
      environments: [P23_ENV],
    },
    {
      principalId: P23_CERTIFIER_Q,
      principalType: "ASSURANCE_CERTIFIER",
      projectId,
      environments: [P23_ENV],
    },
    {
      principalId: P23_DUAL,
      principalType: "ASSURANCE_OPERATOR",
      projectId,
      environments: [P23_ENV],
    },
    {
      principalId: P23_DUAL,
      principalType: "ASSURANCE_CERTIFIER",
      projectId,
      environments: [P23_ENV],
    },
    ...extra.map((p) => ({
      principalId: p.principalId,
      principalType: p.principalType,
      projectId,
      environments: [P23_ENV],
    })),
  ]);
}

export async function createP23Env(
  suffix: string,
  opts?: {
    clock?: ClockPort;
    assuranceCertificationFailpoint?: {
      name: string;
      trigger: () => void;
    };
  },
): Promise<P23TestEnv> {
  const { createTestDatabase } = await import("./test-helpers.js");
  const db = await createTestDatabase(uniquePostgresTestId(`p23-${suffix}`));
  const stack = await createPostgresOrchestratorStack({
    db,
    instanceId: uniquePostgresTestId(`p23-main-${suffix}`),
    seedControlPlane: false,
    ...(opts?.clock !== undefined ? { clock: opts.clock } : {}),
    ...(opts?.assuranceCertificationFailpoint !== undefined
      ? {
          assuranceCertificationFailpoint:
            opts.assuranceCertificationFailpoint,
        }
      : {}),
  });
  return {
    db,
    stack,
    close: async () => {
      await stack.close();
    },
  };
}

export async function createP23ConcurrentStack(
  db: PostgresDatabase,
  suffix: string,
  opts?: {
    clock?: ClockPort;
    assuranceCertificationFailpoint?: {
      name: string;
      trigger: () => void;
    };
  },
): Promise<PostgresOrchestratorStack> {
  const stack = await createPostgresOrchestratorStack({
    db,
    instanceId: uniquePostgresTestId(`p23-stack-${suffix}`),
    seedControlPlane: false,
    ...(opts?.clock !== undefined ? { clock: opts.clock } : {}),
    ...(opts?.assuranceCertificationFailpoint !== undefined
      ? {
          assuranceCertificationFailpoint:
            opts.assuranceCertificationFailpoint,
        }
      : {}),
  });
  return {
    ...stack,
    close: async () => undefined,
  };
}

export function p23LifecycleFromAnchor(anchorIso: string) {
  const t0 = Date.parse(anchorIso);
  const at = (ms: number) => new Date(t0 + ms).toISOString();
  return {
    runCreatedAt: at(0),
    evidenceGeneratedAt: at(60_000),
    assessmentAt: at(120_000),
    certificationProofAt: at(180_000),
    certifiedAt: at(240_000),
    grantRevocationEffectiveAt: at(300_000),
    postRevocationAt: at(360_000),
    certificateExpiresAt: at(86_400_000 * 90),
    caseExpiresAt: at(86_400_000 * 30),
    /** Governance/proof expiry far beyond evidence-freshness stress clocks. */
    farFuture: at(86_400_000 * 365),
  };
}

export async function p23CreateInstitution(
  stack: PostgresOrchestratorStack,
  projectId: string,
): Promise<{ institutionId: string; projectId: string }> {
  const institution = await stack.governanceService.createInstitution({
    name: `P23 Inst ${projectId}`,
    projectIds: [projectId],
  });
  return { institutionId: institution.institutionId, projectId };
}

/**
 * Canonical Phase20 path: mandate → activate → open case → attest → proof id.
 */
export async function p23OpenProof(
  stack: PostgresOrchestratorStack,
  input: {
    institutionId: string;
    projectId: string;
    requiredRole: string;
    action: string;
    subjectType: string;
    subjectId: string;
    subjectHash: string;
    subjectVersion?: number;
    attestorPrincipalId: string;
    expiresAt: string;
    effectiveFrom: string;
  },
): Promise<string> {
  const mandate = await stack.governanceService.createMandate({
    institutionId: input.institutionId,
    createdBy: P23_GOV_ADMIN,
    subjectClasses: [input.subjectType],
    requiredAuthorities: [input.requiredRole],
    projectScope: [input.projectId],
    environmentScope: [P23_ENV],
    effectiveFrom: input.effectiveFrom,
  });
  await stack.governanceService.activateMandate({
    mandateId: mandate.mandateId,
    actorPrincipalId: P23_GOV_ADMIN,
  });
  const opened = await stack.governanceService.openGovernanceCase({
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    subjectHash: input.subjectHash,
    ...(input.subjectVersion !== undefined
      ? { subjectVersion: input.subjectVersion }
      : {}),
    requiredRole: input.requiredRole,
    action: input.action,
    projectIds: [input.projectId],
    environmentScope: [P23_ENV],
    mandateIds: [mandate.mandateId],
    expiresAt: input.expiresAt,
  });
  const attested = await stack.governanceService.attest({
    governanceCaseId: opened.governanceCaseId,
    principalId: input.attestorPrincipalId,
    authorityRole: input.requiredRole,
    decision: "APPROVE",
    nonce: `p23_${input.subjectId}_${input.attestorPrincipalId}_${Date.now()}`,
  });
  if (!attested.proof) {
    throw new Error("Expected institutional proof");
  }
  return attested.proof.institutionalAuthorizationProofId;
}

export async function p23OpenRunInitiationProof(
  stack: PostgresOrchestratorStack,
  input: {
    institutionId: string;
    projectId: string;
    assuranceRunId: string;
    targetFingerprint: string;
    profile: AssuranceProfile;
    operatorPrincipalId: string;
    effectiveFrom: string;
    expiresAt: string;
  },
): Promise<string> {
  const subject = compileRunInitiationSubjectBinding({
    assuranceRunId: input.assuranceRunId,
    targetFingerprint: input.targetFingerprint,
    profileId: input.profile.profileId,
    profileVersion: input.profile.profileVersion,
    profileHash: input.profile.profileHash,
  });
  return p23OpenProof(stack, {
    institutionId: input.institutionId,
    projectId: input.projectId,
    requiredRole: subject.requiredRole,
    action: subject.action,
    subjectType: subject.subjectType,
    subjectId: subject.subjectId,
    subjectHash: subject.subjectHash,
    subjectVersion: subject.subjectVersion,
    attestorPrincipalId: input.operatorPrincipalId,
    effectiveFrom: input.effectiveFrom,
    expiresAt: input.expiresAt,
  });
}

export async function p23OpenCertificationProof(
  stack: PostgresOrchestratorStack,
  input: {
    institutionId: string;
    projectId: string;
    run: AssuranceRun;
    assessmentId: string;
    assessmentHash: string;
    certifierPrincipalId: string;
    effectiveFrom: string;
    expiresAt: string;
  },
): Promise<string> {
  const subject = compileCertificationSubjectBinding({
    assuranceRunId: input.run.assuranceRunId,
    targetFingerprint: input.run.targetFingerprint,
    profileId: input.run.profileId,
    profileVersion: input.run.profileVersion,
    profileHash: input.run.profileHash,
    assessmentId: input.assessmentId,
    assessmentHash: input.assessmentHash,
  });
  return p23OpenProof(stack, {
    institutionId: input.institutionId,
    projectId: input.projectId,
    requiredRole: subject.requiredRole,
    action: subject.action,
    subjectType: subject.subjectType,
    subjectId: subject.subjectId,
    subjectHash: subject.subjectHash,
    subjectVersion: subject.subjectVersion,
    attestorPrincipalId: input.certifierPrincipalId,
    effectiveFrom: input.effectiveFrom,
    expiresAt: input.expiresAt,
  });
}

export async function p23OpenRevocationProof(
  stack: PostgresOrchestratorStack,
  input: {
    institutionId: string;
    projectId: string;
    certificate: SystemCertificate;
    certifierPrincipalId: string;
    effectiveFrom: string;
    expiresAt: string;
  },
): Promise<string> {
  const subject = compileRevocationSubjectBinding({
    certificateId: input.certificate.certificateId,
    certificateHash: input.certificate.certificateHash,
  });
  return p23OpenProof(stack, {
    institutionId: input.institutionId,
    projectId: input.projectId,
    requiredRole: subject.requiredRole,
    action: subject.action,
    subjectType: subject.subjectType,
    subjectId: subject.subjectId,
    subjectHash: subject.subjectHash,
    subjectVersion: subject.subjectVersion,
    attestorPrincipalId: input.certifierPrincipalId,
    effectiveFrom: input.effectiveFrom,
    expiresAt: input.expiresAt,
  });
}

export async function p23RecordPassEvidence(
  stack: PostgresOrchestratorStack,
  input: {
    run: AssuranceRun;
    profile: AssuranceProfile;
    generatedAt: string;
    controlOverrides?: Record<
      string,
      {
        resultCode?: "PASS" | "FAIL" | "INCONCLUSIVE";
        evidenceQuality?: "DIRECT" | "REPRODUCED" | "PARTIAL" | "UNKNOWN";
        skip?: boolean;
        contradict?: boolean;
      }
    >;
  },
): Promise<void> {
  for (const controlId of input.profile.requiredControlIds) {
    const override = input.controlOverrides?.[controlId];
    if (override?.skip) continue;
    const control = getControlById(controlId);
    if (!control) continue;
    for (const kind of control.requiredEvidenceKinds) {
      await stack.assuranceService.recordTrustedEvidence({
        evidenceId: mintEvidenceId(),
        evidenceKind: kind,
        assuranceRunId: input.run.assuranceRunId,
        challengeId: "CH_DYNAMIC_CORE",
        challengeVersion: "1",
        controlIds: [controlId],
        targetFingerprint: input.run.targetFingerprint,
        sourceIdentity: "trusted_internal_adapter",
        generatedAt: input.generatedAt,
        evidenceQuality: override?.evidenceQuality ?? "DIRECT",
        resultCode: override?.resultCode ?? "PASS",
        metadata: { controlId, kind, fixture: "p23" },
      });
      if (override?.contradict) {
        await stack.assuranceService.recordTrustedEvidence({
          evidenceId: mintEvidenceId(),
          evidenceKind: kind,
          assuranceRunId: input.run.assuranceRunId,
          challengeId: "CH_DYNAMIC_CORE",
          challengeVersion: "1",
          controlIds: [controlId],
          targetFingerprint: input.run.targetFingerprint,
          sourceIdentity: "trusted_internal_adapter_alt",
          generatedAt: input.generatedAt,
          evidenceQuality: "DIRECT",
          resultCode: "FAIL",
          metadata: { controlId, kind, fixture: "p23_contradict" },
        });
      }
    }
  }
}

export type P23QualifiedContext = {
  projectId: string;
  institutionId: string;
  profile: AssuranceProfile;
  target: AssuranceTargetIdentity;
  run: AssuranceRun;
  assessmentId: string;
  assessmentHash: string;
  assuranceRunId: string;
};

/**
 * Ladder through QUALIFIED assessment (no certificate).
 */
export async function p23QualifyThroughAssessment(
  stack: PostgresOrchestratorStack,
  input: {
    projectId: string;
    institutionId: string;
    operatorPrincipalId?: string;
    targetOverrides?: Partial<AssuranceTargetIdentity>;
    evidenceGeneratedAt: string;
    proofEffectiveFrom: string;
    proofExpiresAt: string;
    controlOverrides?: Parameters<typeof p23RecordPassEvidence>[1]["controlOverrides"];
  },
): Promise<P23QualifiedContext> {
  const profile = await stack.assuranceService.ensureCoreProfile();
  const target = buildTarget(
    {
      ...input.targetOverrides,
      assuranceProfileId: profile.profileId,
      assuranceProfileVersion: profile.profileVersion,
      assuranceProfileHash: profile.profileHash,
    },
    profile,
  );
  const { computeTargetFingerprint } = await import(
    "../../assurance/target.js"
  );
  const targetFingerprint = computeTargetFingerprint(target);
  const assuranceRunId = mintAssuranceRunId();
  const operator = input.operatorPrincipalId ?? P23_OPERATOR;
  const proofId = await p23OpenRunInitiationProof(stack, {
    institutionId: input.institutionId,
    projectId: input.projectId,
    assuranceRunId,
    targetFingerprint,
    profile,
    operatorPrincipalId: operator,
    effectiveFrom: input.proofEffectiveFrom,
    expiresAt: input.proofExpiresAt,
  });
  const run = await stack.assuranceService.createRun({
    target,
    profileId: profile.profileId,
    profileVersion: profile.profileVersion,
    initiatedByPrincipalId: operator,
    institutionalAuthorizationProofId: proofId,
    projectId: input.projectId,
    environment: P23_ENV,
    assuranceRunId,
  });
  await stack.assuranceService.compilePlan(run.assuranceRunId);
  await p23RecordPassEvidence(stack, {
    run,
    profile,
    generatedAt: input.evidenceGeneratedAt,
    ...(input.controlOverrides !== undefined
      ? { controlOverrides: input.controlOverrides }
      : {}),
  });
  const evaluated = await stack.assuranceService.evaluate(run.assuranceRunId);
  const assessment = await stack.assuranceService.getAssessmentByRun(
    run.assuranceRunId,
  );
  if (!assessment) {
    throw new Error("assessment missing after evaluate");
  }
  return {
    projectId: input.projectId,
    institutionId: input.institutionId,
    profile,
    target,
    run: evaluated.run,
    assessmentId: assessment.assessmentId,
    assessmentHash: assessment.assessmentHash,
    assuranceRunId: run.assuranceRunId,
  };
}

export async function p23CertifyQualified(
  stack: PostgresOrchestratorStack,
  ctx: P23QualifiedContext,
  input: {
    certifierPrincipalId?: string;
    proofEffectiveFrom: string;
    proofExpiresAt: string;
  },
): Promise<SystemCertificate> {
  const certifier = input.certifierPrincipalId ?? P23_CERTIFIER;
  const proofId = await p23OpenCertificationProof(stack, {
    institutionId: ctx.institutionId,
    projectId: ctx.projectId,
    run: ctx.run,
    assessmentId: ctx.assessmentId,
    assessmentHash: ctx.assessmentHash,
    certifierPrincipalId: certifier,
    effectiveFrom: input.proofEffectiveFrom,
    expiresAt: input.proofExpiresAt,
  });
  return stack.assuranceService.certify({
    assuranceRunId: ctx.assuranceRunId,
    certifierPrincipalId: certifier,
    institutionalAuthorizationProofId: proofId,
    projectId: ctx.projectId,
    environment: P23_ENV,
    currentTarget: ctx.target,
  });
}

export async function p23CountScoped(
  db: PostgresDatabase,
  sql: string,
  params: unknown[],
): Promise<number> {
  const result = await db.query<{ c: number }>(sql, params);
  return result.rows[0]?.c ?? 0;
}
