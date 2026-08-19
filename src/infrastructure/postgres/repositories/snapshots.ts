import {
  parseExecutionAuthoritySnapshot,
  type ExecutionAuthoritySnapshot,
} from "../../../domain/execution/index.js";
import type { ExecutionAuthoritySnapshotStore } from "../../../execution/authority-snapshot-store.js";
import type { PostgresDatabase } from "../database.js";
import { PostgresJsonDocuments } from "../documents.js";

const COLLECTION = "execution_authority_snapshots";

export class PostgresExecutionAuthoritySnapshotStore
  implements ExecutionAuthoritySnapshotStore
{
  private readonly docs: PostgresJsonDocuments;

  constructor(db: PostgresDatabase) {
    this.docs = new PostgresJsonDocuments(db);
  }

  async save(
    snapshot: ExecutionAuthoritySnapshot,
    executionAttemptId: string,
  ): Promise<ExecutionAuthoritySnapshot> {
    const parsed = parseExecutionAuthoritySnapshot(snapshot);
    await this.docs.insert({
      collection: COLLECTION,
      documentId: parsed.authoritySnapshotId,
      payload: parsed,
      runId: parsed.runId,
      uniqueKey: executionAttemptId,
      immutable: true,
    });
    return parsed;
  }

  async getById(
    authoritySnapshotId: string,
  ): Promise<ExecutionAuthoritySnapshot | null> {
    return this.docs.get(
      COLLECTION,
      authoritySnapshotId,
      parseExecutionAuthoritySnapshot,
    );
  }

  async getByAttempt(
    executionAttemptId: string,
  ): Promise<ExecutionAuthoritySnapshot | null> {
    return this.docs.getByUniqueKey(
      COLLECTION,
      executionAttemptId,
      parseExecutionAuthoritySnapshot,
    );
  }
}
