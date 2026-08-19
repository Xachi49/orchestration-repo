import { SUPPORTED_SCHEMA_VERSION } from "../../domain/durability/index.js";
import type { StorageMode } from "../../domain/durability/index.js";
import type { PostgresDatabase } from "./database.js";
import { PostgresMigrationRunner } from "./migrate.js";

export interface DatabaseReadiness {
  storageMode: StorageMode;
  databaseReachable: boolean;
  schemaCompatible: boolean;
  schemaVersion?: string;
  supportedSchemaVersion: string;
}

export class PostgresHealthService {
  constructor(
    private readonly db: PostgresDatabase,
    private readonly storageMode: StorageMode,
  ) {}

  async readiness(): Promise<DatabaseReadiness> {
    const reachable = await this.db.ping();
    if (!reachable) {
      return {
        storageMode: this.storageMode,
        databaseReachable: false,
        schemaCompatible: false,
        supportedSchemaVersion: SUPPORTED_SCHEMA_VERSION,
      };
    }
    const runner = new PostgresMigrationRunner(this.db);
    try {
      await runner.assertCompatible();
      const status = await runner.status();
      return {
        storageMode: this.storageMode,
        databaseReachable: true,
        schemaCompatible: true,
        ...(status.current !== undefined
          ? { schemaVersion: status.current }
          : {}),
        supportedSchemaVersion: SUPPORTED_SCHEMA_VERSION,
      };
    } catch {
      const status = await runner.status().catch(() => undefined);
      return {
        storageMode: this.storageMode,
        databaseReachable: true,
        schemaCompatible: false,
        ...(status?.current !== undefined
          ? { schemaVersion: status.current }
          : {}),
        supportedSchemaVersion: SUPPORTED_SCHEMA_VERSION,
      };
    }
  }
}
