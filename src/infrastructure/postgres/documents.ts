import { DurabilityError } from "../../durability/errors.js";
import { wrapDatabaseError } from "./database.js";
import type { PostgresDatabase } from "./database.js";
import { hydrateRecord } from "./hydrate.js";

export interface JsonDocumentRow {
  collection: string;
  documentId: string;
  projectId: string | null;
  runId: string | null;
  uniqueKey: string | null;
  payload: unknown;
  recordRevision: number;
  immutable: boolean;
}

export class PostgresJsonDocuments {
  constructor(private readonly db: PostgresDatabase) {}

  async insert<T>(input: {
    collection: string;
    documentId: string;
    payload: T;
    projectId?: string;
    runId?: string;
    uniqueKey?: string;
    immutable?: boolean;
  }): Promise<T> {
    try {
      await this.db.query(
        `INSERT INTO json_documents (
           collection, document_id, project_id, run_id, unique_key, payload, immutable
         ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
        [
          input.collection,
          input.documentId,
          input.projectId ?? null,
          input.runId ?? null,
          input.uniqueKey ?? null,
          JSON.stringify(input.payload),
          input.immutable ?? false,
        ],
      );
      return input.payload;
    } catch (error) {
      throw wrapDatabaseError(error);
    }
  }

  async get<T>(
    collection: string,
    documentId: string,
    parse: (input: unknown) => T,
  ): Promise<T | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM json_documents WHERE collection = $1 AND document_id = $2`,
      [collection, documentId],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return hydrateRecord(parse, row.payload, `${collection}:${documentId}`);
  }

  async require<T>(
    collection: string,
    documentId: string,
    parse: (input: unknown) => T,
  ): Promise<T> {
    const found = await this.get(collection, documentId, parse);
    if (!found) {
      throw new DurabilityError(
        "PERSISTED_RECORD_INVALID",
        `Missing ${collection} ${documentId}`,
      );
    }
    return found;
  }

  async upsert<T>(input: {
    collection: string;
    documentId: string;
    payload: T;
    projectId?: string;
    runId?: string;
    uniqueKey?: string;
    immutable?: boolean;
  }): Promise<T> {
    await this.db.query(
      `INSERT INTO json_documents (
         collection, document_id, project_id, run_id, unique_key, payload, immutable, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, NOW())
       ON CONFLICT (collection, document_id) DO UPDATE
       SET payload = EXCLUDED.payload,
           project_id = EXCLUDED.project_id,
           run_id = EXCLUDED.run_id,
           unique_key = EXCLUDED.unique_key,
           record_revision = json_documents.record_revision + 1,
           updated_at = NOW()
       WHERE json_documents.immutable = FALSE`,
      [
        input.collection,
        input.documentId,
        input.projectId ?? null,
        input.runId ?? null,
        input.uniqueKey ?? null,
        JSON.stringify(input.payload),
        input.immutable ?? false,
      ],
    );
    return input.payload;
  }

  async updatePayload<T>(input: {
    collection: string;
    documentId: string;
    payload: T;
    expectedRevision?: number;
  }): Promise<T> {
    const result = await this.db.query(
      input.expectedRevision !== undefined
        ? `UPDATE json_documents
           SET payload = $3::jsonb,
               record_revision = record_revision + 1,
               updated_at = NOW()
           WHERE collection = $1 AND document_id = $2 AND record_revision = $4 AND immutable = FALSE`
        : `UPDATE json_documents
           SET payload = $3::jsonb,
               record_revision = record_revision + 1,
               updated_at = NOW()
           WHERE collection = $1 AND document_id = $2 AND immutable = FALSE`,
      input.expectedRevision !== undefined
        ? [
            input.collection,
            input.documentId,
            JSON.stringify(input.payload),
            input.expectedRevision,
          ]
        : [input.collection, input.documentId, JSON.stringify(input.payload)],
    );
    if (result.rowCount !== 1) {
      throw new DurabilityError(
        "DURABLE_CONFLICT",
        `Failed to update ${input.collection}:${input.documentId}`,
      );
    }
    return input.payload;
  }

  async listByRun<T>(
    collection: string,
    runId: string,
    parse: (input: unknown) => T,
  ): Promise<T[]> {
    const result = await this.db.query<{ payload: unknown; document_id: string }>(
      `SELECT document_id, payload FROM json_documents
       WHERE collection = $1 AND run_id = $2
       ORDER BY created_at ASC, document_id ASC`,
      [collection, runId],
    );
    return result.rows.map((row) =>
      hydrateRecord(parse, row.payload, `${collection}:${row.document_id}`),
    );
  }

  async listByProject<T>(
    collection: string,
    projectId: string,
    parse: (input: unknown) => T,
  ): Promise<T[]> {
    const result = await this.db.query<{ payload: unknown; document_id: string }>(
      `SELECT document_id, payload FROM json_documents
       WHERE collection = $1 AND project_id = $2
       ORDER BY created_at ASC, document_id ASC`,
      [collection, projectId],
    );
    return result.rows.map((row) =>
      hydrateRecord(parse, row.payload, `${collection}:${row.document_id}`),
    );
  }

  async listCollection<T>(
    collection: string,
    parse: (input: unknown) => T,
  ): Promise<T[]> {
    const result = await this.db.query<{ payload: unknown; document_id: string }>(
      `SELECT document_id, payload FROM json_documents
       WHERE collection = $1
       ORDER BY created_at ASC, document_id ASC`,
      [collection],
    );
    return result.rows.map((row) =>
      hydrateRecord(parse, row.payload, `${collection}:${row.document_id}`),
    );
  }

  async exists(collection: string, documentId: string): Promise<boolean> {
    const result = await this.db.query<{ ok: number }>(
      `SELECT 1 AS ok FROM json_documents WHERE collection = $1 AND document_id = $2`,
      [collection, documentId],
    );
    return result.rows.length > 0;
  }

  async getByUniqueKey<T>(
    collection: string,
    uniqueKey: string,
    parse: (input: unknown) => T,
  ): Promise<T | null> {
    const result = await this.db.query<{ payload: unknown; document_id: string }>(
      `SELECT document_id, payload FROM json_documents
       WHERE collection = $1 AND unique_key = $2`,
      [collection, uniqueKey],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return hydrateRecord(parse, row.payload, `${collection}:${row.document_id}`);
  }
}
