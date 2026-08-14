/**
 * Admission boundary — decide whether an objective may enter the system.
 * Phase 0: contract only.
 */
export interface AdmissionPort {
  readonly stage: "ADMISSION";
}
