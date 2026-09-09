/**
 * Phase 23 — Independent assurance / adversarial evaluation / system certification.
 *
 * ASSURANCE ≠ OPERATIONAL AUTHORITY
 * TEST PASS ≠ CERTIFICATE
 * CERTIFICATE ≠ EXECUTION AUTHORIZATION
 * CERTIFICATION ≠ DEPLOYMENT
 */

export const ASSURANCE_ROLES = [
  "ASSURANCE_OPERATOR",
  "ASSURANCE_CERTIFIER",
] as const;

export type AssuranceRole = (typeof ASSURANCE_ROLES)[number];

export const ASSURANCE_ACTIONS = [
  "ASSURANCE_RUN_INITIATION",
  "SYSTEM_CERTIFICATION",
  "SYSTEM_CERTIFICATE_REVOCATION",
] as const;

export type AssuranceAction = (typeof ASSURANCE_ACTIONS)[number];

export const ASSURANCE_DOCTRINE = {
  assuranceNotAuthority: "ASSURANCE != OPERATIONAL AUTHORITY",
  testPassNotCertificate: "TEST PASS != CERTIFICATE",
  certificateNotExecution: "CERTIFICATE != EXECUTION AUTHORIZATION",
  certificateNotPolicy: "CERTIFICATE != POLICY",
  certificateNotConstitution: "CERTIFICATE != CONSTITUTIONAL AUTHORITY",
  certificationNotDeployment: "CERTIFICATION != DEPLOYMENT",
  operatorNotCertifier: "ASSURANCE OPERATOR != CERTIFIER",
  sutNotAssuranceAuthority: "SYSTEM UNDER TEST != ASSURANCE AUTHORITY",
  observationNotProof: "OBSERVATION != PROOF",
  proofNotPermission: "PROOF != PERMISSION",
  modelSuggestionNotEvidence: "MODEL SUGGESTION != ASSURANCE EVIDENCE",
  humanAttestationNotFact: "HUMAN ATTESTATION != FACTUAL EVIDENCE",
  ciSuccessNotRuntimeTruth: "CI SUCCESS != RUNTIME TRUTH",
  singlePassNotConformance: "SINGLE TEST PASS != SYSTEM CONFORMANCE",
  historicalPassNotCurrent: "HISTORICAL PASS != CURRENT CONFORMANCE",
  targetDriftNotCertified: "TARGET DRIFT != CERTIFIED TARGET",
  hashNotSemantics: "EVIDENCE HASH != EVIDENCE SEMANTICS",
  replayNotOriginal: "REPLAY != ORIGINAL EXECUTION",
  faultInjectionNotProduction: "FAULT INJECTION != PRODUCTION AUTHORITY",
  adversarialNotUnbounded: "ADVERSARIAL INPUT != UNBOUNDED ATTACK CAPABILITY",
  inconclusiveNotPass: "INCONCLUSIVE != PASS",
  waivedNotPass: "WAIVED != PASS",
  partialNotFull: "PARTIAL COVERAGE != FULL CERTIFICATION",
  recordNotGrant: "ASSURANCE RECORD != AUTHORITY GRANT",
  certifierNotSuperuser: "CERTIFIER ROLE != SUPERUSER",
  revocationNotDeletion: "CERTIFICATE REVOCATION != HISTORY DELETION",
  assessmentNotCertificate: "ASSESSMENT != CERTIFICATE",
  governingLaw:
    "Assurance may determine whether evidence supports a claim of conformance. Assurance may not create the authority, policy, execution, truth, or governance that it evaluates.",
} as const;

export const CONTROL_CATALOG_VERSION = "phase23-core-v1";
export const ASSURANCE_EVALUATOR_VERSION = "phase23-evaluator-v1";
export const CHALLENGE_GENERATOR_VERSION = "phase23-challenge-gen-v1";
