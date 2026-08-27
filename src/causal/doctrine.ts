/**
 * Phase 18 doctrine — causal knowledge informs decisions; it does not authorize them.
 */
export const CAUSAL_DOCTRINE = {
  correlationNotCausation: "CORRELATION != CAUSATION",
  hypothesisNotIdentified: "CAUSAL HYPOTHESIS != IDENTIFIED EFFECT",
  identificationNotEstimation: "IDENTIFICATION != ESTIMATION",
  estimationNotGeneralization: "ESTIMATION != GENERALIZATION",
  experimentNotUniversalLaw: "EXPERIMENT RESULT != UNIVERSAL CAUSAL LAW",
  statisticalNotBusiness:
    "STATISTICAL SIGNIFICANCE != BUSINESS SIGNIFICANCE",
  modelDagNotTrueDag: "MODEL-GENERATED DAG != TRUE DAG",
  humanReviewNotEvidence: "HUMAN REVIEW != FACTUAL EVIDENCE",
  promotedClaimNotPolicy: "PROMOTED CAUSAL CLAIM != POLICY",
  causalKnowledgeNotControlPlane:
    "CAUSAL KNOWLEDGE != CURRENT CONTROL-PLANE TRUTH",
  calibrationCandidateNotModelChange:
    "CALIBRATION CANDIDATE != MODEL CHANGE",
  informsDoesNotAuthorize:
    "Causal knowledge informs decisions. It does not authorize them.",
} as const;

export const CLOSED_LEARNING_LOOP = [
  "Phase 16 uncertainty",
  "Phase 17 experiment",
  "Phase 8 verification",
  "Phase 17 evidence",
  "Phase 18 causal identification",
  "causal evidence gap OR promoted bounded claim",
  "Phase 16 calibration/re-analysis candidate",
] as const;
