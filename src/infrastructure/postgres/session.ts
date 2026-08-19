import { AsyncLocalStorage } from "node:async_hooks";
import type { PoolClient } from "pg";

const session = new AsyncLocalStorage<PoolClient>();

export function runWithClient<T>(
  client: PoolClient,
  fn: () => Promise<T>,
): Promise<T> {
  return session.run(client, fn);
}

export function currentClient(): PoolClient | undefined {
  return session.getStore();
}
