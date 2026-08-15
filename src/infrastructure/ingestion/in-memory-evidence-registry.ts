import {
  parseEvidenceRecord,
  type EvidenceRecord,
} from "../../domain/evidence/evidence.js";
import type { EvidenceRegistry } from "../../ingestion/context.js";

export class InMemoryEvidenceRegistry implements EvidenceRegistry {
  private readonly byId = new Map<string, EvidenceRecord>();

  async put(record: EvidenceRecord): Promise<EvidenceRecord> {
    const parsed = parseEvidenceRecord(record);
    this.byId.set(parsed.evidenceId, parsed);
    return parsed;
  }

  async getById(evidenceId: string): Promise<EvidenceRecord | null> {
    return this.byId.get(evidenceId) ?? null;
  }

  async listByRunId(runId: string): Promise<readonly EvidenceRecord[]> {
    return [...this.byId.values()].filter((record) => record.runId === runId);
  }
}
