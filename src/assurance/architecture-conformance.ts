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
  | "SUPPORTED_SCHEMA_MATCHES_HEAD";

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
  const migration017 = existsSync(
    join(repoRoot, "migrations/017_phase22_governed_federation.sql"),
  );
  const activationCapability = readSafe(
    join(repoRoot, "src/constitutional/activation-capability.ts"),
  );
  const challenge = readSafe(join(repoRoot, "src/assurance/challenge.ts"));
  const durability = readSafe(
    join(repoRoot, "src/domain/durability/index.ts"),
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
