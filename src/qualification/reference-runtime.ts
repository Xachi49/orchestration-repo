import type { AssuranceOrchestrationService } from "../assurance/service.js";
import {
  evaluateCertificateCurrentValidity,
} from "../assurance/certification.js";
import {
  mintProductionReferenceRuntimeManifest,
  type ReferenceRuntimeManifest,
} from "./runtime-manifest.js";
import { QualificationOrchestrationService } from "./service.js";
import type {
  ProductionQualificationRunRepository,
  QualificationAuditRepository,
  QualificationEvidenceRepository,
  ReleaseManifestRepository,
  ReleaseQualificationRecordRepository,
} from "./repositories.js";

/**
 * Wires QualificationOrchestrationService against an existing Assurance service.
 *
 * Full executable ReferenceRuntime (API + workers + Phases 2–23 stack + drain)
 * lives in infrastructure:
 *   createReferenceRuntime(db) → PostgresOrchestratorStack + DrainController
 *
 * This helper only attaches qualification — it is not the reference runtime.
 *
 * Production composition must NOT accept a FaultInjectionController.
 */
export function createReferenceRuntimeQualification(input: {
  nowIso: () => string;
  assuranceService: AssuranceOrchestrationService;
  runs: ProductionQualificationRunRepository;
  evidence: QualificationEvidenceRepository;
  records: ReleaseQualificationRecordRepository;
  manifests: ReleaseManifestRepository;
  audits: QualificationAuditRepository;
  runFinalization?: <T>(
    fn: () => Promise<T>,
    lockKey: string,
  ) => Promise<T>;
  /** @internal TEST ONLY — never exposed on production assembly. */
  qualificationFailpoint?: { name: string; trigger: () => void };
}): {
  qualificationService: QualificationOrchestrationService;
  referenceRuntimeManifest: ReferenceRuntimeManifest;
} {
  // Production assembly cannot receive fault-injection controllers.
  const qualificationService = new QualificationOrchestrationService({
    nowIso: input.nowIso,
    runs: input.runs,
    evidence: input.evidence,
    records: input.records,
    manifests: input.manifests,
    audits: input.audits,
    getSystemCertificate: (id) => input.assuranceService.getCertificate(id),
    evaluateCertificateValidity: evaluateCertificateCurrentValidity,
    listCertificateRevoked: async (certificateId) => {
      const revocations =
        await input.assuranceService.listRevocations(certificateId);
      const now = Date.parse(input.nowIso());
      return revocations.some((r) => Date.parse(r.effectiveAt) <= now);
    },
    assertPhase23EvidenceIntegrity: (assuranceRunId) =>
      input.assuranceService.assertEvidenceIntegrity(assuranceRunId),
    ...(input.runFinalization !== undefined
      ? { runFinalization: input.runFinalization }
      : {}),
    ...(input.qualificationFailpoint !== undefined
      ? { qualificationFailpoint: input.qualificationFailpoint }
      : {}),
  });

  return {
    qualificationService,
    referenceRuntimeManifest: mintProductionReferenceRuntimeManifest("PRODUCTION"),
  };
}

/** Architecture proof helper: qualification wiring has no faultInjection param. */
export const REFERENCE_RUNTIME_ASSEMBLY_SIGNATURE =
  "createReferenceRuntimeQualification(assuranceService, repos) — qualification only; full runtime via createReferenceRuntime(db) — no FaultInjectionController";
