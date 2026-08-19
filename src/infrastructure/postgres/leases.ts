import {
  DEFAULT_LEASE_TTL_SECONDS,
  type CoordinatorLease,
  type LeaseStatus,
} from "../../domain/durability/index.js";
import { DurabilityError } from "../../durability/errors.js";
import type { PostgresDatabase } from "./database.js";

function mapLease(row: {
  coordination_key: string;
  phase: string;
  owner_id: string;
  fence_token: string | number;
  lease_expires_at: Date;
  acquired_at: Date;
  last_heartbeat_at: Date;
  status: string;
}): CoordinatorLease {
  return {
    coordinationKey: row.coordination_key,
    phase: row.phase,
    ownerId: row.owner_id,
    fenceToken: Number(row.fence_token),
    leaseExpiresAt: row.lease_expires_at.toISOString(),
    acquiredAt: row.acquired_at.toISOString(),
    lastHeartbeatAt: row.last_heartbeat_at.toISOString(),
    status: row.status as LeaseStatus,
  };
}

/**
 * Durable coordinator leases. Validity uses PostgreSQL NOW(), not the
 * application clock. APPLICATION CLOCK != DISTRIBUTED LEASE CLOCK.
 */
export class PostgresLeaseStore {
  constructor(
    private readonly db: PostgresDatabase,
    private readonly ttlSeconds = DEFAULT_LEASE_TTL_SECONDS,
  ) {}

  async get(coordinationKey: string): Promise<CoordinatorLease | null> {
    return this.load(coordinationKey);
  }

  async acquire(input: {
    coordinationKey: string;
    phase: string;
    ownerId: string;
  }): Promise<CoordinatorLease> {
    const inserted = await this.db.query<{
      coordination_key: string;
      phase: string;
      owner_id: string;
      fence_token: string | number;
      lease_expires_at: Date;
      acquired_at: Date;
      last_heartbeat_at: Date;
      status: string;
    }>(
      `INSERT INTO coordinator_leases (
         coordination_key, phase, owner_id, fence_token, lease_expires_at, status
       ) VALUES ($1, $2, $3, 1, NOW() + make_interval(secs => $4), 'HELD')
       ON CONFLICT (coordination_key) DO UPDATE
       SET owner_id = EXCLUDED.owner_id,
           fence_token = coordinator_leases.fence_token + 1,
           lease_expires_at = NOW() + make_interval(secs => $4),
           acquired_at = NOW(),
           last_heartbeat_at = NOW(),
           status = 'HELD',
           phase = EXCLUDED.phase
       WHERE coordinator_leases.lease_expires_at < NOW()
          OR coordinator_leases.status <> 'HELD'
          OR coordinator_leases.owner_id = EXCLUDED.owner_id
       RETURNING coordination_key, phase, owner_id, fence_token,
                 lease_expires_at, acquired_at, last_heartbeat_at, status`,
      [input.coordinationKey, input.phase, input.ownerId, this.ttlSeconds],
    );
    const row = inserted.rows[0];
    if (row) {
      return mapLease(row);
    }
    const current = await this.load(input.coordinationKey);
    if (current && current.ownerId === input.ownerId && current.status === "HELD") {
      return current;
    }
    throw new DurabilityError(
      "LEASE_ALREADY_HELD",
      `Lease already held for ${input.coordinationKey}`,
      { coordinationKey: input.coordinationKey },
    );
  }

  async heartbeat(input: {
    coordinationKey: string;
    ownerId: string;
    fenceToken: number;
  }): Promise<CoordinatorLease> {
    const result = await this.db.query<{
      coordination_key: string;
      phase: string;
      owner_id: string;
      fence_token: string | number;
      lease_expires_at: Date;
      acquired_at: Date;
      last_heartbeat_at: Date;
      status: string;
    }>(
      `UPDATE coordinator_leases
       SET last_heartbeat_at = NOW(),
           lease_expires_at = NOW() + make_interval(secs => $4)
       WHERE coordination_key = $1
         AND owner_id = $2
         AND fence_token = $3
         AND status = 'HELD'
         AND lease_expires_at >= NOW()
       RETURNING coordination_key, phase, owner_id, fence_token,
                 lease_expires_at, acquired_at, last_heartbeat_at, status`,
      [input.coordinationKey, input.ownerId, input.fenceToken, this.ttlSeconds],
    );
    const row = result.rows[0];
    if (!row) {
      throw new DurabilityError(
        "LEASE_OWNERSHIP_LOST",
        `Heartbeat rejected for ${input.coordinationKey}`,
        { coordinationKey: input.coordinationKey, fenceToken: input.fenceToken },
      );
    }
    return mapLease(row);
  }

  async release(input: {
    coordinationKey: string;
    ownerId: string;
    fenceToken: number;
  }): Promise<void> {
    await this.db.query(
      `UPDATE coordinator_leases
       SET status = 'RELEASED'
       WHERE coordination_key = $1 AND owner_id = $2 AND fence_token = $3`,
      [input.coordinationKey, input.ownerId, input.fenceToken],
    );
  }

  async load(coordinationKey: string): Promise<CoordinatorLease | null> {
    const result = await this.db.query<{
      coordination_key: string;
      phase: string;
      owner_id: string;
      fence_token: string | number;
      lease_expires_at: Date;
      acquired_at: Date;
      last_heartbeat_at: Date;
      status: string;
    }>(
      `SELECT coordination_key, phase, owner_id, fence_token,
              lease_expires_at, acquired_at, last_heartbeat_at, status
       FROM coordinator_leases WHERE coordination_key = $1`,
      [coordinationKey],
    );
    const row = result.rows[0];
    return row ? mapLease(row) : null;
  }

  async listExpired(): Promise<CoordinatorLease[]> {
    const result = await this.db.query<{
      coordination_key: string;
      phase: string;
      owner_id: string;
      fence_token: string | number;
      lease_expires_at: Date;
      acquired_at: Date;
      last_heartbeat_at: Date;
      status: string;
    }>(
      `SELECT coordination_key, phase, owner_id, fence_token,
              lease_expires_at, acquired_at, last_heartbeat_at, status
       FROM coordinator_leases
       WHERE status = 'HELD' AND lease_expires_at < NOW()`,
    );
    return result.rows.map(mapLease);
  }

  async assertWritable(input: {
    coordinationKey: string;
    ownerId: string;
    fenceToken: number;
  }): Promise<void> {
    const result = await this.db.query<{ ok: number }>(
      `SELECT 1 AS ok FROM coordinator_leases
       WHERE coordination_key = $1
         AND owner_id = $2
         AND fence_token = $3
         AND status = 'HELD'
         AND lease_expires_at >= NOW()`,
      [input.coordinationKey, input.ownerId, input.fenceToken],
    );
    if (result.rows.length === 0) {
      throw new DurabilityError(
        "STALE_FENCE_TOKEN",
        `Stale fence token ${input.fenceToken} for ${input.coordinationKey}`,
        { coordinationKey: input.coordinationKey, fenceToken: input.fenceToken },
      );
    }
  }
}
