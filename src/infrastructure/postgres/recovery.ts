import {
  DEFAULT_LEASE_TTL_SECONDS,
  type RecoveryOutcome,
} from "../../domain/durability/index.js";
import type { PostgresDatabase } from "./database.js";
import type { PostgresLeaseStore } from "./leases.js";
import type { StepExecutionRepository } from "../../execution/step-repository.js";
import type { PlanningUsageLedger } from "../../planning/model.js";
import type { ValidationUsageLedger } from "../../validation/model.js";
import type { VerificationInferenceLedger } from "../../verification/inference-ledger.js";

export interface RecoveryItem {
  kind: string;
  id: string;
  outcome: RecoveryOutcome;
  detail: string;
}

/**
 * Safe reconciliation only. Never blindly repeats uncertain side effects
 * or model calls.
 */
export class DurableRecoveryService {
  constructor(
    private readonly db: PostgresDatabase,
    private readonly leases: PostgresLeaseStore,
    private readonly steps?: StepExecutionRepository,
    private readonly planningUsage?: PlanningUsageLedger,
    private readonly validationUsage?: ValidationUsageLedger,
    private readonly verificationInference?: VerificationInferenceLedger,
  ) {}

  async recover(): Promise<readonly RecoveryItem[]> {
    const items: RecoveryItem[] = [];
    const expired = await this.leases.listExpired();
    for (const lease of expired) {
      items.push({
        kind: "lease",
        id: lease.coordinationKey,
        outcome: "REACQUIRED",
        detail: `Expired lease ${lease.coordinationKey} fenceToken=${lease.fenceToken} may be acquired by a new owner`,
      });
    }

    const running = await this.db.query<{ document_id: string; payload: { status?: string } }>(
      `SELECT document_id, payload FROM json_documents
       WHERE collection = 'step_executions' AND payload->>'status' = 'RUNNING'`,
    );
    for (const row of running.rows) {
      items.push({
        kind: "execution-step",
        id: row.document_id,
        outcome: "UNSAFE_TO_RETRY",
        detail: "Step left RUNNING after owner loss; SIDE_EFFECT_STATE_UNKNOWN — contain unless actuator reconciliation proves otherwise",
      });
    }

    const dispatched = await this.db.query<{ document_id: string; collection: string }>(
      `SELECT collection, document_id FROM json_documents
       WHERE collection IN ('planning_usage', 'validation_usage')
         AND payload->'durabilityState' = '"DISPATCH_STARTED"'`,
    );
    for (const row of dispatched.rows) {
      items.push({
        kind: row.collection,
        id: row.document_id,
        outcome: "REQUIRES_MANUAL_REVIEW",
        detail: "Inference call left DISPATCH_STARTED; treat as AMBIGUOUS and charge reservation conservatively. Do not redispatch.",
      });
      if (row.collection === "planning_usage") {
        await this.planningUsage?.markAmbiguous?.(row.document_id);
      }
      if (row.collection === "validation_usage") {
        await this.validationUsage?.markAmbiguous?.(row.document_id);
      }
    }

    const expiredOutbox = await this.db.query<{ outbox_id: string }>(
      `SELECT outbox_id FROM transactional_outbox
       WHERE status = 'LEASED' AND lease_expires_at < NOW()`,
    );
    for (const row of expiredOutbox.rows) {
      items.push({
        kind: "outbox",
        id: row.outbox_id,
        outcome: "REACQUIRED",
        detail: "Expired outbox lease may be reclaimed by a newer dispatcher",
      });
    }

    const learning = await this.db.query<{ coordination_key: string }>(
      `SELECT coordination_key FROM coordinator_fences
       WHERE phase = 'learning' AND status = 'IN_PROGRESS'`,
    );
    for (const row of learning.rows) {
      items.push({
        kind: "learning-coordinator",
        id: row.coordination_key,
        outcome: "REQUIRES_MANUAL_REVIEW",
        detail: "Abandoned learning coordinator requires reconciliation",
      });
    }

    void this.steps;
    void this.verificationInference;
    void DEFAULT_LEASE_TTL_SECONDS;
    return items;
  }
}
