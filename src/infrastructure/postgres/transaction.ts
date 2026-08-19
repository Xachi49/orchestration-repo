import type { PostgresDatabase } from "./database.js";
import type { TransactionManager } from "../../durability/transaction.js";

export class PostgresTransactionManager implements TransactionManager {
  constructor(private readonly db: PostgresDatabase) {}

  withTransaction<T>(fn: () => Promise<T>): Promise<T> {
    return this.db.withTransaction(fn);
  }
}
