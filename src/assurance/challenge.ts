import { createHash } from "node:crypto";
import { z } from "zod";
import { CHALLENGE_GENERATOR_VERSION } from "./doctrine.js";
import { AssuranceError } from "./errors.js";
import type { AssuranceProfile } from "./profile.js";
import type { AssuranceTargetIdentity } from "./target.js";
import { computeTargetFingerprint } from "./target.js";

export const ASSURANCE_CHALLENGE_KINDS = [
  "STATIC_CONFORMANCE",
  "DYNAMIC_ACCEPTANCE",
  "RESTART_DURABILITY",
  "CONCURRENT_RACE",
  "FAILPOINT_ROLLBACK",
  "REPLAY",
  "SECURITY_BOUNDARY",
  "DATA_MINIMIZATION",
  "MIGRATION_COMPATIBILITY",
  "CROSS_PHASE_CONTAMINATION",
] as const;

export type AssuranceChallengeKind =
  (typeof ASSURANCE_CHALLENGE_KINDS)[number];

export const AssuranceChallengeSchema = z
  .object({
    challengeId: z.string().min(1),
    challengeVersion: z.string().min(1),
    challengeKind: z.enum(ASSURANCE_CHALLENGE_KINDS),
    controlIds: z.array(z.string().min(1)).min(1),
    seed: z.string().min(1).optional(),
    maximumCases: z.number().int().positive(),
    timeoutMs: z.number().int().positive(),
    allowedEnvironments: z.array(z.enum(["TEST", "STAGING", "PRODUCTION"])).min(1),
    requiredEvidenceKinds: z.array(z.string().min(1)).min(1),
  })
  .strict();

export type AssuranceChallenge = z.infer<typeof AssuranceChallengeSchema>;

export const AssuranceChallengePlanSchema = z
  .object({
    planId: z.string().min(1),
    planHash: z.string().min(1),
    targetFingerprint: z.string().min(1),
    profileId: z.string().min(1),
    profileVersion: z.number().int().positive(),
    profileHash: z.string().min(1),
    generatorVersion: z.string().min(1),
    challenges: z.array(AssuranceChallengeSchema).min(1),
    compiledAt: z.string().datetime(),
  })
  .strict();

export type AssuranceChallengePlan = z.infer<
  typeof AssuranceChallengePlanSchema
>;

export function assertExhaustiveChallengeKind(
  kind: never,
): never {
  throw new AssuranceError(
    "ASSURANCE_CHALLENGE_INVALID",
    `Unhandled challenge kind: ${String(kind)}`,
  );
}

export function describeChallengeKind(kind: AssuranceChallengeKind): string {
  switch (kind) {
    case "STATIC_CONFORMANCE":
      return "Static architecture/invariant conformance";
    case "DYNAMIC_ACCEPTANCE":
      return "Bounded dynamic acceptance probes";
    case "RESTART_DURABILITY":
      return "Restart durability proof";
    case "CONCURRENT_RACE":
      return "Concurrent race serialization";
    case "FAILPOINT_ROLLBACK":
      return "Failpoint rollback";
    case "REPLAY":
      return "Deterministic replay";
    case "SECURITY_BOUNDARY":
      return "Security boundary probes";
    case "DATA_MINIMIZATION":
      return "Data minimization";
    case "MIGRATION_COMPATIBILITY":
      return "Migration compatibility";
    case "CROSS_PHASE_CONTAMINATION":
      return "Cross-phase contamination";
    default:
      return assertExhaustiveChallengeKind(kind);
  }
}

export function computeChallengePlanHash(
  input: Omit<AssuranceChallengePlan, "planHash">,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        planId: input.planId,
        targetFingerprint: input.targetFingerprint,
        profileId: input.profileId,
        profileVersion: input.profileVersion,
        profileHash: input.profileHash,
        generatorVersion: input.generatorVersion,
        challenges: [...input.challenges]
          .map((c) => AssuranceChallengeSchema.parse(c))
          .sort((a, b) => a.challengeId.localeCompare(b.challengeId)),
        compiledAt: input.compiledAt,
      }),
      "utf8",
    )
    .digest("hex");
}

export function compileChallengePlan(input: {
  profile: AssuranceProfile;
  target: AssuranceTargetIdentity;
  compiledAt: string;
  seed?: string;
}): AssuranceChallengePlan {
  const targetFingerprint = computeTargetFingerprint(input.target);
  const seed = input.seed ?? "core-qualification-seed-v1";
  const rawChallenges = [
    {
      challengeId: "CH_STATIC_CORE",
      challengeVersion: "1",
      challengeKind: "STATIC_CONFORMANCE",
      controlIds: [
        "ARCH_ONE_AUTHORITY_REGISTRY",
        "ARCH_FED_ENTERS_PHASE2",
        "CONST_CURRENT_AUTHORIZES_PROPOSED",
        "SCHED_NE_AUTHORITY",
      ],
      maximumCases: 8,
      timeoutMs: 30_000,
      allowedEnvironments: ["TEST", "STAGING", "PRODUCTION"],
      requiredEvidenceKinds: ["STATIC_CONFORMANCE", "ARCHITECTURE_TEST"],
    },
    {
      challengeId: "CH_DYNAMIC_CORE",
      challengeVersion: "1",
      challengeKind: "DYNAMIC_ACCEPTANCE",
      controlIds: input.profile.requiredControlIds.filter((id) =>
        [
          "AUTHZ_PASS_NE_APPROVED",
          "AUTHZ_APPROVED_NE_EXECUTED",
          "VERIFY_EXEC_NE_VERIFIED",
          "MEMORY_HIST_NE_TRUSTED",
          "GOV_IDENTITY_NE_AUTHORITY",
          "GOV_DELEGATION_NE_EXPANSION",
          "FED_AGREEMENT_NE_LOCAL",
          "FED_NO_TRANSITIVE_TRUST",
        ].includes(id),
      ),
      seed,
      maximumCases: 32,
      timeoutMs: 60_000,
      allowedEnvironments: ["TEST", "STAGING"],
      requiredEvidenceKinds: ["UNIT_TEST", "POSTGRES_ACCEPTANCE"],
    },
    {
      challengeId: "CH_SECURITY",
      challengeVersion: "1",
      challengeKind: "SECURITY_BOUNDARY",
      controlIds: ["SEC_PROD_FAULT_DENIED", "SEC_DATA_MINIMIZATION"],
      seed,
      maximumCases: 16,
      timeoutMs: 30_000,
      allowedEnvironments: ["TEST", "STAGING"],
      requiredEvidenceKinds: ["UNIT_TEST", "ARCHITECTURE_TEST"],
    },
    {
      challengeId: "CH_MIGRATION",
      challengeVersion: "1",
      challengeKind: "MIGRATION_COMPATIBILITY",
      controlIds: ["MIG_COMPATIBILITY"],
      maximumCases: 4,
      timeoutMs: 30_000,
      allowedEnvironments: ["TEST", "STAGING", "PRODUCTION"],
      requiredEvidenceKinds: ["MIGRATION_TEST"],
    },
    {
      challengeId: "CH_REPLAY",
      challengeVersion: "1",
      challengeKind: "REPLAY",
      controlIds: ["DURAB_COMMIT_NE_EFFECT", "DURAB_IDEM_NE_EXACTLY_ONCE"],
      seed,
      maximumCases: 8,
      timeoutMs: 30_000,
      allowedEnvironments: ["TEST", "STAGING"],
      requiredEvidenceKinds: ["DURABLE_REPLAY", "UNIT_TEST"],
    },
    {
      challengeId: "CH_FAILPOINT",
      challengeVersion: "1",
      challengeKind: "FAILPOINT_ROLLBACK",
      controlIds: ["DURAB_COMMIT_NE_EFFECT", "SEC_PROD_FAULT_DENIED"],
      seed,
      maximumCases: 4,
      timeoutMs: 30_000,
      allowedEnvironments: ["TEST", "STAGING"],
      requiredEvidenceKinds: ["FAILPOINT_RESULT"],
    },
  ];
  const challenges = rawChallenges
    .filter((c) => c.controlIds.length > 0)
    .map((c) => AssuranceChallengeSchema.parse(c));

  for (const c of challenges) {
    describeChallengeKind(c.challengeKind);
  }

  const withoutHash = {
    planId: `plan_${targetFingerprint.slice(0, 16)}_${input.profile.profileVersion}`,
    targetFingerprint,
    profileId: input.profile.profileId,
    profileVersion: input.profile.profileVersion,
    profileHash: input.profile.profileHash,
    generatorVersion: CHALLENGE_GENERATOR_VERSION,
    challenges,
    compiledAt: input.compiledAt,
  };
  return AssuranceChallengePlanSchema.parse({
    ...withoutHash,
    planHash: computeChallengePlanHash(withoutHash),
  });
}

/** Deterministic adversarial case identity for a challenge seed + index. */
export function mintAdversarialCaseIdentity(input: {
  challengeId: string;
  challengeVersion: string;
  seed: string;
  caseIndex: number;
}): { caseId: string; inputHash: string } {
  const material = {
    generatorVersion: CHALLENGE_GENERATOR_VERSION,
    challengeId: input.challengeId,
    challengeVersion: input.challengeVersion,
    seed: input.seed,
    caseIndex: input.caseIndex,
  };
  const inputHash = createHash("sha256")
    .update(JSON.stringify(material), "utf8")
    .digest("hex");
  return {
    caseId: `case_${input.challengeId}_${input.caseIndex}_${inputHash.slice(0, 12)}`,
    inputHash,
  };
}
