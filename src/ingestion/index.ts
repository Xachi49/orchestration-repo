/**
 * Ingestion boundary — collect evidence into verified/untrusted classifications.
 * Phase 0: contract only. External content is assumed untrusted.
 */
export interface IngestionPort {
  readonly stage: "INGESTION";
  readonly treatsExternalContentAsUntrusted: true;
}
