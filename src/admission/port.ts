/**
 * Admission boundary — decide whether an objective may enter the system.
 */
export interface AdmissionPort {
  readonly stage: "ADMISSION";
}
