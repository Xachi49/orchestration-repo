import type { SystemCertificate } from "../assurance/certification.js";
import type { ReadinessReport } from "./readiness.js";
import { evaluateReadinessOverall } from "./readiness.js";
import type { ReleaseQualificationOutcome } from "./qualification-record.js";
import { QualificationError } from "./errors.js";
import {
  assertReleaseCandidateMatchesAssuranceTarget,
  type ReleaseCandidateIdentity,
} from "./release-candidate.js";
import { computeReleaseCandidateFingerprint } from "./release-candidate.js";

export function evaluateReleaseQualificationOutcome(input: {
  candidate: ReleaseCandidateIdentity;
  expectedCandidateFingerprint: string;
  certificate: SystemCertificate;
  certificateCurrentlyValid: boolean;
  readiness: ReadinessReport;
  systemEvidenceOverall: "PASS" | "FAIL" | "INCONCLUSIVE";
}): ReleaseQualificationOutcome {
  const fp = computeReleaseCandidateFingerprint(input.candidate);
  if (fp !== input.expectedCandidateFingerprint) {
    throw new QualificationError(
      "RELEASE_CANDIDATE_DRIFT",
      "Release candidate fingerprint drift during qualification",
    );
  }
  assertReleaseCandidateMatchesAssuranceTarget(
    input.candidate,
    input.certificate.targetFingerprint,
  );
  if (!input.certificateCurrentlyValid) {
    return "NOT_QUALIFIED";
  }
  const readinessOverall =
    input.readiness.overall ?? evaluateReadinessOverall(input.readiness.results);
  if (readinessOverall === "FAIL" || input.systemEvidenceOverall === "FAIL") {
    return "NOT_QUALIFIED";
  }
  if (
    readinessOverall === "INCONCLUSIVE" ||
    input.systemEvidenceOverall === "INCONCLUSIVE"
  ) {
    return "INCONCLUSIVE";
  }
  return "QUALIFIED_FOR_RELEASE";
}
