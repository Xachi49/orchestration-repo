import type {
  ApprovalDeliverySecretStore,
  DeliverySecretProtector,
} from "../../../authorization/delivery-secret-store.js";
import { DurabilityError } from "../../../durability/errors.js";
import type { PostgresDatabase } from "../database.js";

export class PostgresApprovalDeliverySecretStore
  implements ApprovalDeliverySecretStore
{
  constructor(
    private readonly db: PostgresDatabase,
    private readonly protector: DeliverySecretProtector,
  ) {}

  async storePending(
    approvalRequestId: string,
    plaintextNonce: string,
  ): Promise<void> {
    const encrypted = this.protector.encrypt(plaintextNonce);
    await this.db.query(
      `INSERT INTO approval_delivery_secrets (
         approval_request_id, secret_ciphertext, secret_iv, secret_tag, status
       ) VALUES ($1, $2, $3, $4, 'PENDING')
       ON CONFLICT (approval_request_id) DO UPDATE
         SET secret_ciphertext = EXCLUDED.secret_ciphertext,
             secret_iv = EXCLUDED.secret_iv,
             secret_tag = EXCLUDED.secret_tag,
             status = 'PENDING',
             consumed_at = NULL`,
      [
        approvalRequestId,
        encrypted.ciphertext,
        encrypted.iv,
        encrypted.tag,
      ],
    );
  }

  async revealPending(approvalRequestId: string): Promise<string | null> {
    const result = await this.db.query<{
      secret_ciphertext: Buffer;
      secret_iv: Buffer;
      secret_tag: Buffer;
    }>(
      `SELECT secret_ciphertext, secret_iv, secret_tag
       FROM approval_delivery_secrets
       WHERE approval_request_id = $1 AND status = 'PENDING'`,
      [approvalRequestId],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return this.protector.decrypt({
      ciphertext: row.secret_ciphertext,
      iv: row.secret_iv,
      tag: row.secret_tag,
    });
  }

  async markDelivered(approvalRequestId: string): Promise<void> {
    const result = await this.db.query(
      `UPDATE approval_delivery_secrets
       SET status = 'DELIVERED', consumed_at = NOW()
       WHERE approval_request_id = $1 AND status = 'PENDING'`,
      [approvalRequestId],
    );
    if (result.rowCount !== 1) {
      throw new DurabilityError(
        "PERSISTED_RECORD_INVALID",
        `Could not mark approval delivery secret delivered for ${approvalRequestId}`,
      );
    }
  }

  async consumePending(approvalRequestId: string): Promise<string | null> {
    const plaintext = await this.revealPending(approvalRequestId);
    if (!plaintext) {
      return null;
    }
    await this.markDelivered(approvalRequestId);
    return plaintext;
  }

  async invalidate(approvalRequestId: string): Promise<void> {
    await this.db.query(
      `UPDATE approval_delivery_secrets
       SET status = 'INVALIDATED', consumed_at = NOW()
       WHERE approval_request_id = $1 AND status = 'PENDING'`,
      [approvalRequestId],
    );
  }

  async assertNoPlaintextInOutbox(plaintext: string): Promise<void> {
    if (!plaintext) {
      return;
    }
    const result = await this.db.query<{ found: number }>(
      `SELECT 1 AS found
       FROM transactional_outbox
       WHERE payload::text LIKE $1
       LIMIT 1`,
      [`%${plaintext}%`],
    );
    if (result.rows.length > 0) {
      throw new DurabilityError(
        "PERSISTED_RECORD_INVALID",
        "Plaintext approval nonce found in durable outbox payload",
      );
    }
  }
}
