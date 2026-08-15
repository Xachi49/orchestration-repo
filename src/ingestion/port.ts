/**
 * Ingestion boundary — collect evidence into verified/untrusted classifications.
 * External content is assumed untrusted and is never system authority.
 */
export interface IngestionPort {
  readonly stage: "INGESTION";
  readonly treatsExternalContentAsUntrusted: true;
}

export const INGESTION_BOUNDARY: IngestionPort = {
  stage: "INGESTION",
  treatsExternalContentAsUntrusted: true,
};
