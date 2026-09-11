import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ASSURANCE_EVALUATOR_VERSION } from "./doctrine.js";
import { SUPPORTED_SCHEMA_VERSION } from "../domain/durability/index.js";

export type ArchitectureConformanceRuleId =
  | "ONE_CANONICAL_AUTHORITY_REGISTRY"
  | "FEDERATION_ENTERS_PHASE2"
  | "PHASE22_MIGRATION_PRESENT"
  | "CONSTITUTIONAL_GATE_PROTECTED"
  | "NO_ASSURANCE_SHELL_CHALLENGE"
  | "SUPPORTED_SCHEMA_MATCHES_HEAD"
  | "NO_PHASE24_DEPLOYER"
  | "PHASE24_QUALIFICATION_REQUIRES_CERTIFICATE"
  | "PRODUCTION_NO_MEMORY_FALLBACK"
  | "HISTORICAL_MIGRATIONS_016_017_018_PRESENT"
  | "NO_STARTUP_AUTHORITY_SEED_BY_DEFAULT"
  | "READY_DERIVED_FROM_READINESS_EVALUATOR"
  | "NO_PRODUCTION_REPOSITORY_SOURCE_SEED_ON_STARTUP";

export interface ArchitectureConformanceResult {
  ruleId: ArchitectureConformanceRuleId;
  result: "PASS" | "FAIL";
  reasonCode: string;
}

function readSafe(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

export function evaluateArchitectureConformance(
  repoRoot = process.cwd(),
): {
  results: ArchitectureConformanceResult[];
  fingerprint: string;
  evaluatorVersion: string;
} {
  const authorityDir = readSafe(
    join(repoRoot, "src/infrastructure/postgres/repositories/authority-directory.ts"),
  );
  const federationService = readSafe(
    join(repoRoot, "src/federation/service.ts"),
  );
  const activationCapability = readSafe(
    join(repoRoot, "src/constitutional/activation-capability.ts"),
  );
  const challenge = readSafe(join(repoRoot, "src/assurance/challenge.ts"));
  const durability = readSafe(
    join(repoRoot, "src/domain/durability/index.ts"),
  );
  const qualificationService = readSafe(
    join(repoRoot, "src/qualification/service.ts"),
  );
  const qualificationDoctrine = readSafe(
    join(repoRoot, "src/qualification/doctrine.ts"),
  );
  const referenceRuntime = readSafe(
    join(repoRoot, "src/infrastructure/postgres/reference-runtime.ts"),
  );
  const qualificationWiring = readSafe(
    join(repoRoot, "src/qualification/reference-runtime.ts"),
  );
  const migration016 = existsSync(
    join(repoRoot, "migrations/016_phase21_constitutional_change_control.sql"),
  );
  const migration017 = existsSync(
    join(repoRoot, "migrations/017_phase22_governed_federation.sql"),
  );
  const migration018 = existsSync(
    join(repoRoot, "migrations/018_phase23_independent_assurance.sql"),
  );
  const migrationsDir = join(repoRoot, "migrations");

  const results: ArchitectureConformanceResult[] = [
    {
      ruleId: "ONE_CANONICAL_AUTHORITY_REGISTRY",
      result:
        authorityDir.includes("authority_grants") &&
        !existsSync(join(repoRoot, "src/assurance/authority-registry.ts"))
          ? "PASS"
          : "FAIL",
      reasonCode: "AUTHORITY_REGISTRY_CHECK",
    },
    {
      ruleId: "FEDERATION_ENTERS_PHASE2",
      result:
        federationService.includes("admission") &&
        federationService.includes("admit")
          ? "PASS"
          : "FAIL",
      reasonCode: "FEDERATION_PHASE2_CHECK",
    },
    {
      ruleId: "PHASE22_MIGRATION_PRESENT",
      result: migration017 ? "PASS" : "FAIL",
      reasonCode: "PHASE22_MIGRATION_CHECK",
    },
    {
      ruleId: "CONSTITUTIONAL_GATE_PROTECTED",
      result: activationCapability.includes("ConstitutionalActivationCapability")
        ? "PASS"
        : "FAIL",
      reasonCode: "CONSTITUTIONAL_GATE_CHECK",
    },
    {
      ruleId: "NO_ASSURANCE_SHELL_CHALLENGE",
      result:
        !challenge.includes("child_process") &&
        !challenge.includes("execSync") &&
        !challenge.includes("arbitraryUrl")
          ? "PASS"
          : "FAIL",
      reasonCode: "NO_SHELL_CHALLENGE",
    },
    {
      ruleId: "SUPPORTED_SCHEMA_MATCHES_HEAD",
      result: durability.includes(`"${SUPPORTED_SCHEMA_VERSION}"`)
        ? "PASS"
        : "FAIL",
      reasonCode: "SCHEMA_HEAD_CHECK",
    },
    {
      ruleId: "NO_PHASE24_DEPLOYER",
      result:
        !qualificationService.includes("deploy(") &&
        !qualificationService.includes("DeploymentAdapter") &&
        qualificationDoctrine.includes("RELEASE_QUALIFIED != DEPLOYED")
          ? "PASS"
          : "FAIL",
      reasonCode: "NO_DEPLOYER_CHECK",
    },
    {
      ruleId: "PHASE24_QUALIFICATION_REQUIRES_CERTIFICATE",
      result:
        qualificationService.includes("PHASE23_CERTIFICATE_REQUIRED") &&
        qualificationService.includes("assertReleaseCandidateMatchesAssuranceTarget")
          ? "PASS"
          : "FAIL",
      reasonCode: "CERTIFICATE_BINDING_CHECK",
    },
    {
      ruleId: "PRODUCTION_NO_MEMORY_FALLBACK",
      result:
        referenceRuntime.includes("createReferenceRuntime") &&
        referenceRuntime.includes("PostgresOrchestratorStack") &&
        referenceRuntime.includes("DrainController") &&
        qualificationWiring.includes("no FaultInjectionController")
          ? "PASS"
          : "FAIL",
      reasonCode: "PRODUCTION_STORAGE_CHECK",
    },
    {
      ruleId: "HISTORICAL_MIGRATIONS_016_017_018_PRESENT",
      result: migration016 && migration017 && migration018 ? "PASS" : "FAIL",
      reasonCode: "HISTORICAL_MIGRATION_CHECK",
    },
    {
      ruleId: "NO_STARTUP_AUTHORITY_SEED_BY_DEFAULT",
      result:
        referenceRuntime.includes("seedControlPlane: input.seedControlPlane ?? false") &&
        readSafe(join(repoRoot, "src/infrastructure/postgres/stack.ts")).includes(
          "if (options.seedControlPlane !== false)",
        ) &&
        readSafe(
          join(
            repoRoot,
            "src/infrastructure/postgres/stack.ts",
          ),
        ).includes("authorityDirectory.seed")
          ? "PASS"
          : "FAIL",
      reasonCode: "STARTUP_SEED_GATE",
    },
    {
      ruleId: "READY_DERIVED_FROM_READINESS_EVALUATOR",
      result:
        referenceRuntime.includes("evaluateReadiness(evaluatedAt)") &&
        referenceRuntime.includes('report.overall !== "PASS"') &&
        !referenceRuntime.includes("forceReady") &&
        !referenceRuntime.includes("acceptCallerReport")
          ? "PASS"
          : "FAIL",
      reasonCode: "READY_DERIVATION_CHECK",
    },
    {
      ruleId: "NO_PRODUCTION_REPOSITORY_SOURCE_SEED_ON_STARTUP",
      result:
        referenceRuntime.includes(
          "seedRepositorySources: input.seedRepositorySources ?? false",
        ) &&
        readSafe(join(repoRoot, "src/infrastructure/postgres/stack.ts")).includes(
          "if (options.seedRepositorySources === true)",
        ) &&
        !referenceRuntime.includes("EXAMPLE_REPOSITORY_SOURCE") &&
        !referenceRuntime.includes("await sources.seed")
          ? "PASS"
          : "FAIL",
      reasonCode: "REPOSITORY_SOURCE_SEED_GATE",
    },
  ];

  void migrationsDir;

  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ results, evaluatorVersion: ASSURANCE_EVALUATOR_VERSION }), "utf8")
    .digest("hex");

  return {
    results,
    fingerprint,
    evaluatorVersion: ASSURANCE_EVALUATOR_VERSION,
  };
}
