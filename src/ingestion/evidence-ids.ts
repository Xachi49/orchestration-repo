import type { EvidenceRecord } from "../domain/evidence/evidence.js";
import { sha256Text } from "./hashing.js";

export function evidenceIdFor(parts: {
  runId: string;
  sourceType: string;
  sourceIdentifier: string;
  contentHash: string;
}): string {
  return sha256Text(
    `${parts.runId}|${parts.sourceType}|${parts.sourceIdentifier}|${parts.contentHash}`,
  );
}

export function isRepositoryAuthority(record: EvidenceRecord): boolean {
  return (
    record.trustLevel === "SYSTEM_AUTHORITY" ||
    record.trustLevel === "POLICY_AUTHORITY"
  );
}
