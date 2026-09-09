import { createHash } from "node:crypto";
import { z } from "zod";
import { CONTROL_CATALOG_VERSION } from "./doctrine.js";

export const ASSURANCE_CONTROL_CATEGORIES = [
  "AUTHORITY",
  "AUTHORIZATION",
  "DURABILITY",
  "ATOMICITY",
  "CONCURRENCY",
  "IDEMPOTENCY",
  "RECOVERY",
  "PROJECT_ISOLATION",
  "DATA_MINIMIZATION",
  "SECURITY_BOUNDARY",
  "VERIFICATION",
  "MEMORY_INTEGRITY",
  "SCHEDULING",
  "INSTITUTIONAL_GOVERNANCE",
  "CONSTITUTIONAL_GOVERNANCE",
  "FEDERATION",
  "MIGRATION_COMPATIBILITY",
  "API_BOUNDARY",
  "ARCHITECTURE_CONFORMANCE",
] as const;

export type AssuranceControlCategory =
  (typeof ASSURANCE_CONTROL_CATEGORIES)[number];

export const ASSURANCE_CONTROL_CRITICALITY = [
  "CRITICAL",
  "REQUIRED",
  "OPTIONAL",
] as const;

export type AssuranceControlCriticality =
  (typeof ASSURANCE_CONTROL_CRITICALITY)[number];

export const ASSURANCE_EVIDENCE_KINDS = [
  "POSTGRES_ACCEPTANCE",
  "UNIT_TEST",
  "ARCHITECTURE_TEST",
  "MIGRATION_TEST",
  "STATIC_CONFORMANCE",
  "DURABLE_REPLAY",
  "FAILPOINT_RESULT",
  "RUNTIME_OBSERVATION",
] as const;

export type AssuranceEvidenceKind = (typeof ASSURANCE_EVIDENCE_KINDS)[number];

export const AssuranceControlSchema = z
  .object({
    controlId: z.string().min(1),
    controlVersion: z.string().min(1),
    title: z.string().min(1),
    category: z.enum(ASSURANCE_CONTROL_CATEGORIES),
    severity: z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]),
    criticality: z.enum(ASSURANCE_CONTROL_CRITICALITY),
    requiredEvidenceKinds: z.array(z.enum(ASSURANCE_EVIDENCE_KINDS)).min(1),
    evaluationPolicy: z.enum([
      "ALL_DIRECT_OR_REPRODUCED_PASS",
      "ANY_FAIL_BLOCKS",
      "CONTRADICTION_IS_FAIL",
      "CONTRADICTION_IS_INCONCLUSIVE",
    ]),
    doctrineReference: z.string().min(1),
    invariantDescription: z.string().min(1),
  })
  .strict();

export type AssuranceControl = z.infer<typeof AssuranceControlSchema>;

function ctrl(
  partial: Omit<AssuranceControl, "controlVersion"> & {
    controlVersion?: string;
  },
): AssuranceControl {
  return AssuranceControlSchema.parse({
    controlVersion: partial.controlVersion ?? "1",
    ...partial,
  });
}

/** Core catalog covering critical architecture boundaries through Phase 22. */
export const CORE_CONTROL_CATALOG: readonly AssuranceControl[] = [
  ctrl({
    controlId: "AUTHZ_PASS_NE_APPROVED",
    title: "PASS ≠ APPROVED",
    category: "AUTHORIZATION",
    severity: "CRITICAL",
    criticality: "CRITICAL",
    requiredEvidenceKinds: ["UNIT_TEST", "ARCHITECTURE_TEST"],
    evaluationPolicy: "ALL_DIRECT_OR_REPRODUCED_PASS",
    doctrineReference: "Phase 6",
    invariantDescription: "Validation PASS does not grant human approval",
  }),
  ctrl({
    controlId: "AUTHZ_APPROVED_NE_EXECUTED",
    title: "APPROVED ≠ EXECUTED",
    category: "AUTHORIZATION",
    severity: "CRITICAL",
    criticality: "CRITICAL",
    requiredEvidenceKinds: ["UNIT_TEST"],
    evaluationPolicy: "ALL_DIRECT_OR_REPRODUCED_PASS",
    doctrineReference: "Phase 7",
    invariantDescription: "Approval does not itself execute work",
  }),
  ctrl({
    controlId: "VERIFY_EXEC_NE_VERIFIED",
    title: "EXECUTION_SUCCEEDED ≠ VERIFIED_SUCCESS",
    category: "VERIFICATION",
    severity: "CRITICAL",
    criticality: "CRITICAL",
    requiredEvidenceKinds: ["UNIT_TEST"],
    evaluationPolicy: "ALL_DIRECT_OR_REPRODUCED_PASS",
    doctrineReference: "Phase 8",
    invariantDescription: "Execution success is not verification success",
  }),
  ctrl({
    controlId: "MEMORY_HIST_NE_TRUSTED",
    title: "HISTORICAL_DATA ≠ TRUSTED_PRECEDENT",
    category: "MEMORY_INTEGRITY",
    severity: "CRITICAL",
    criticality: "CRITICAL",
    requiredEvidenceKinds: ["UNIT_TEST"],
    evaluationPolicy: "ALL_DIRECT_OR_REPRODUCED_PASS",
    doctrineReference: "Phase 9",
    invariantDescription: "History is not automatic trusted precedent",
  }),
  ctrl({
    controlId: "DURAB_COMMIT_NE_EFFECT",
    title: "DATABASE_COMMIT ≠ EXTERNAL_EFFECT_COMPLETION",
    category: "DURABILITY",
    severity: "CRITICAL",
    criticality: "CRITICAL",
    requiredEvidenceKinds: ["UNIT_TEST", "DURABLE_REPLAY"],
    evaluationPolicy: "ALL_DIRECT_OR_REPRODUCED_PASS",
    doctrineReference: "Phase 11",
    invariantDescription: "Commit is not exactly-once external completion",
  }),
  ctrl({
    controlId: "DURAB_IDEM_NE_EXACTLY_ONCE",
    title: "IDEMPOTENCY ≠ EXACTLY_ONCE",
    category: "IDEMPOTENCY",
    severity: "CRITICAL",
    criticality: "CRITICAL",
    requiredEvidenceKinds: ["UNIT_TEST"],
    evaluationPolicy: "ALL_DIRECT_OR_REPRODUCED_PASS",
    doctrineReference: "Phase 11",
    invariantDescription: "Idempotency keys do not claim exactly-once effects",
  }),
  ctrl({
    controlId: "SCHED_NE_AUTHORITY",
    title: "SCHEDULING ≠ AUTHORITY",
    category: "SCHEDULING",
    severity: "CRITICAL",
    criticality: "CRITICAL",
    requiredEvidenceKinds: ["UNIT_TEST", "ARCHITECTURE_TEST"],
    evaluationPolicy: "ALL_DIRECT_OR_REPRODUCED_PASS",
    doctrineReference: "Phase 13",
    invariantDescription: "Scheduler eligibility is not authorization",
  }),
  ctrl({
    controlId: "GOV_IDENTITY_NE_AUTHORITY",
    title: "IDENTITY ≠ AUTHORITY",
    category: "INSTITUTIONAL_GOVERNANCE",
    severity: "CRITICAL",
    criticality: "CRITICAL",
    requiredEvidenceKinds: ["UNIT_TEST"],
    evaluationPolicy: "ALL_DIRECT_OR_REPRODUCED_PASS",
    doctrineReference: "Phase 20",
    invariantDescription: "Identity alone does not grant authority",
  }),
  ctrl({
    controlId: "GOV_DELEGATION_NE_EXPANSION",
    title: "DELEGATION ≠ AUTHORITY_EXPANSION",
    category: "INSTITUTIONAL_GOVERNANCE",
    severity: "CRITICAL",
    criticality: "CRITICAL",
    requiredEvidenceKinds: ["UNIT_TEST"],
    evaluationPolicy: "ALL_DIRECT_OR_REPRODUCED_PASS",
    doctrineReference: "Phase 20",
    invariantDescription: "Delegation only attenuates",
  }),
  ctrl({
    controlId: "CONST_CURRENT_AUTHORIZES_PROPOSED",
    title: "CURRENT_CONSTITUTION authorizes PROPOSED",
    category: "CONSTITUTIONAL_GOVERNANCE",
    severity: "CRITICAL",
    criticality: "CRITICAL",
    requiredEvidenceKinds: ["UNIT_TEST", "ARCHITECTURE_TEST"],
    evaluationPolicy: "ALL_DIRECT_OR_REPRODUCED_PASS",
    doctrineReference: "Phase 21",
    invariantDescription: "Proposed rules cannot authorize their own adoption",
  }),
  ctrl({
    controlId: "FED_AGREEMENT_NE_LOCAL",
    title: "FEDERATION_AGREEMENT ≠ LOCAL_AUTHORITY",
    category: "FEDERATION",
    severity: "CRITICAL",
    criticality: "CRITICAL",
    requiredEvidenceKinds: ["UNIT_TEST", "POSTGRES_ACCEPTANCE"],
    evaluationPolicy: "ALL_DIRECT_OR_REPRODUCED_PASS",
    doctrineReference: "Phase 22",
    invariantDescription: "Federation does not mint local operational authority",
  }),
  ctrl({
    controlId: "FED_NO_TRANSITIVE_TRUST",
    title: "A↔B + B↔C ≠ A↔C",
    category: "FEDERATION",
    severity: "CRITICAL",
    criticality: "CRITICAL",
    requiredEvidenceKinds: ["UNIT_TEST", "POSTGRES_ACCEPTANCE"],
    evaluationPolicy: "ALL_DIRECT_OR_REPRODUCED_PASS",
    doctrineReference: "Phase 22",
    invariantDescription: "Federation trust is non-transitive",
  }),
  ctrl({
    controlId: "ARCH_ONE_AUTHORITY_REGISTRY",
    title: "One canonical authority registry",
    category: "ARCHITECTURE_CONFORMANCE",
    severity: "CRITICAL",
    criticality: "CRITICAL",
    requiredEvidenceKinds: ["STATIC_CONFORMANCE", "ARCHITECTURE_TEST"],
    evaluationPolicy: "ALL_DIRECT_OR_REPRODUCED_PASS",
    doctrineReference: "Phase 20/23",
    invariantDescription: "No alternate authority_grants registry",
  }),
  ctrl({
    controlId: "ARCH_FED_ENTERS_PHASE2",
    title: "Federation materialization enters Phase 2",
    category: "ARCHITECTURE_CONFORMANCE",
    severity: "CRITICAL",
    criticality: "CRITICAL",
    requiredEvidenceKinds: ["STATIC_CONFORMANCE", "UNIT_TEST"],
    evaluationPolicy: "ALL_DIRECT_OR_REPRODUCED_PASS",
    doctrineReference: "Phase 22",
    invariantDescription: "Federated acceptance ≠ Phase2 admission",
  }),
  ctrl({
    controlId: "MIG_COMPATIBILITY",
    title: "Migration compatibility fail-closed",
    category: "MIGRATION_COMPATIBILITY",
    severity: "CRITICAL",
    criticality: "CRITICAL",
    requiredEvidenceKinds: ["MIGRATION_TEST"],
    evaluationPolicy: "ALL_DIRECT_OR_REPRODUCED_PASS",
    doctrineReference: "Phase 11/23",
    invariantDescription: "Unknown future schemas fail closed",
  }),
  ctrl({
    controlId: "SEC_DATA_MINIMIZATION",
    title: "Assurance storage data minimization",
    category: "DATA_MINIMIZATION",
    severity: "HIGH",
    criticality: "REQUIRED",
    requiredEvidenceKinds: ["UNIT_TEST", "POSTGRES_ACCEPTANCE"],
    evaluationPolicy: "ALL_DIRECT_OR_REPRODUCED_PASS",
    doctrineReference: "Phase 12/23",
    invariantDescription: "No secrets or CoT in assurance records",
  }),
  ctrl({
    controlId: "SEC_PROD_FAULT_DENIED",
    title: "Production fault injection denied",
    category: "SECURITY_BOUNDARY",
    severity: "CRITICAL",
    criticality: "CRITICAL",
    requiredEvidenceKinds: ["UNIT_TEST", "ARCHITECTURE_TEST"],
    evaluationPolicy: "ALL_DIRECT_OR_REPRODUCED_PASS",
    doctrineReference: "Phase 23",
    invariantDescription: "Fault injection impossible in PRODUCTION",
  }),
  ctrl({
    controlId: "OPTIONAL_COVERAGE_SAMPLE",
    title: "Optional coverage sample",
    category: "API_BOUNDARY",
    severity: "LOW",
    criticality: "OPTIONAL",
    requiredEvidenceKinds: ["UNIT_TEST"],
    evaluationPolicy: "ALL_DIRECT_OR_REPRODUCED_PASS",
    doctrineReference: "Phase 23",
    invariantDescription: "Optional control does not gate full qualification",
  }),
];

export function computeControlCatalogHash(
  controls: readonly AssuranceControl[] = CORE_CONTROL_CATALOG,
): string {
  const sorted = [...controls]
    .map((c) => AssuranceControlSchema.parse(c))
    .sort((a, b) => a.controlId.localeCompare(b.controlId));
  return createHash("sha256")
    .update(
      JSON.stringify({
        catalogVersion: CONTROL_CATALOG_VERSION,
        controls: sorted,
      }),
      "utf8",
    )
    .digest("hex");
}

export function getControlById(controlId: string): AssuranceControl | undefined {
  return CORE_CONTROL_CATALOG.find((c) => c.controlId === controlId);
}

export function listRequiredControlIds(
  includeOptional = false,
): readonly string[] {
  return CORE_CONTROL_CATALOG.filter(
    (c) =>
      c.criticality === "CRITICAL" ||
      c.criticality === "REQUIRED" ||
      (includeOptional && c.criticality === "OPTIONAL"),
  ).map((c) => c.controlId);
}
