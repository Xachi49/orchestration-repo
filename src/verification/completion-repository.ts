import {
  parseCompletionRecord,
  type CompletionRecord,
} from "../domain/verification/index.js";
import { VerificationError } from "./errors.js";

export interface CompletionRecordRepository {
  append(record: CompletionRecord): Promise<CompletionRecord>;
  getByRun(runId: string): Promise<CompletionRecord | null>;
  exists(completionRecordId: string): Promise<boolean>;
}

/**
 * Append-only. At most one authoritative completion record per completed run.
 */
export class InMemoryCompletionRecordRepository
  implements CompletionRecordRepository
{
  private readonly byId = new Map<string, CompletionRecord>();
  private readonly byRun = new Map<string, string>();

  async append(record: CompletionRecord): Promise<CompletionRecord> {
    const parsed = parseCompletionRecord(record);
    if (this.byId.has(parsed.completionRecordId)) {
      throw new VerificationError(
        "COMPLETION_RECORD_CONFLICT",
        `Completion record already exists: ${parsed.completionRecordId}`,
        { completionRecordId: parsed.completionRecordId },
      );
    }
    if (this.byRun.has(parsed.runId)) {
      throw new VerificationError(
        "COMPLETION_RECORD_CONFLICT",
        `Run already has a completion record: ${parsed.runId}`,
        { runId: parsed.runId },
      );
    }
    this.byId.set(parsed.completionRecordId, Object.freeze(parsed));
    this.byRun.set(parsed.runId, parsed.completionRecordId);
    return parsed;
  }

  async getByRun(runId: string): Promise<CompletionRecord | null> {
    const id = this.byRun.get(runId);
    return id !== undefined ? (this.byId.get(id) ?? null) : null;
  }

  async exists(completionRecordId: string): Promise<boolean> {
    return this.byId.has(completionRecordId);
  }
}
