import pg from "pg";
import { DurabilityError } from "../../durability/errors.js";
import {
  runInTransactionScope,
} from "../../durability/transaction.js";
import { MAX_TRANSACTION_RETRIES } from "../../domain/durability/index.js";
import { currentClient, runWithClient } from "./session.js";
import { redactUnknown } from "./redact.js";

export interface PostgresPoolOptions {
  connectionString: string;
  max: number;
  connectionTimeoutMillis: number;
  idleTimeoutMillis: number;
}

export class PostgresDatabase {
  readonly pool: pg.Pool;
  readonly instanceId: string;

  constructor(options: PostgresPoolOptions & { instanceId: string }) {
    this.instanceId = options.instanceId;
    this.pool = new pg.Pool({
      connectionString: options.connectionString,
      max: options.max,
      connectionTimeoutMillis: options.connectionTimeoutMillis,
      idleTimeoutMillis: options.idleTimeoutMillis,
    });
    this.pool.on("error", () => {
      // Fail closed on idle client errors; callers observe the next query.
    });
  }

  async query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<pg.QueryResult<T>> {
    const client = currentClient();
    try {
      if (client) {
        return await client.query<T>(sql, params as unknown[]);
      }
      return await this.pool.query<T>(sql, params as unknown[]);
    } catch (error) {
      throw wrapDatabaseError(error);
    }
  }

  async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
    const existing = currentClient();
    if (existing) {
      return fn();
    }

    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_TRANSACTION_RETRIES; attempt += 1) {
      const client = await this.connect();
      try {
        await client.query("BEGIN");
        const result = await runWithClient(client, () =>
          runInTransactionScope(fn),
        );
        await client.query("COMMIT");
        return result;
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // ignore rollback failure
        }
        lastError = error;
        if (!isRetryableConcurrencyError(error) || attempt === MAX_TRANSACTION_RETRIES) {
          throw wrapDatabaseError(error);
        }
        await sleep(25 * attempt + Math.floor(Math.random() * 25));
      } finally {
        client.release();
      }
    }
    throw wrapDatabaseError(lastError);
  }

  async nowIso(): Promise<string> {
    const result = await this.query<{ now: Date }>("SELECT NOW() AS now");
    const now = result.rows[0]?.now;
    if (!now) {
      throw new DurabilityError(
        "DATABASE_UNAVAILABLE",
        "Database did not return CURRENT_TIMESTAMP",
      );
    }
    return now.toISOString();
  }

  async ping(): Promise<boolean> {
    try {
      await this.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async connect(): Promise<pg.PoolClient> {
    try {
      return await this.pool.connect();
    } catch (error) {
      throw new DurabilityError(
        "DATABASE_UNAVAILABLE",
        `PostgreSQL connection failed: ${redactUnknown(error)}`,
      );
    }
  }
}

export function wrapDatabaseError(error: unknown): DurabilityError {
  if (error instanceof DurabilityError) {
    return error;
  }
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : undefined;
  if (code === "23505") {
    return new DurabilityError(
      "DURABLE_CONFLICT",
      `Unique constraint conflict: ${redactUnknown(error)}`,
      { pgCode: code },
    );
  }
  if (code === "57P01" || code === "57P03" || code === "08006" || code === "08001") {
    return new DurabilityError(
      "DATABASE_UNAVAILABLE",
      `PostgreSQL unavailable: ${redactUnknown(error)}`,
      { pgCode: code },
    );
  }
  return new DurabilityError(
    "DATABASE_TRANSACTION_FAILED",
    redactUnknown(error),
    code !== undefined ? { pgCode: code } : {},
  );
}

export function isRetryableConcurrencyError(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : error instanceof DurabilityError
        ? String(error.details["pgCode"] ?? "")
        : "";
  return code === "40001" || code === "40P01";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
