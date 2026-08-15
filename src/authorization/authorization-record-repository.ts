import {
  parseAuthorizationRecord,
  type AuthorizationRecord,
} from "../domain/authorization/index.js";
import { AuthorizationError } from "./errors.js";

export interface AuthorizationRecordRepository {
  append(record: AuthorizationRecord): Promise<AuthorizationRecord>;
  getByApprovalRequest(
    approvalRequestId: string,
  ): Promise<AuthorizationRecord | null>;
  getLatestByRun(runId: string): Promise<AuthorizationRecord | null>;
  listByRun(runId: string): Promise<readonly AuthorizationRecord[]>;
  exists(authorizationRecordId: string): Promise<boolean>;
}

/**
 * Append-only authorization audit store (in-memory).
 * Future durable storage must remain append-only and never update prior rows.
 */
export class InMemoryAuthorizationRecordRepository
  implements AuthorizationRecordRepository
{
  private readonly byId = new Map<string, AuthorizationRecord>();
  private readonly byApproval = new Map<string, string>();
  private readonly orderByRun = new Map<string, string[]>();

  async append(record: AuthorizationRecord): Promise<AuthorizationRecord> {
    const parsed = parseAuthorizationRecord(record);
    if (this.byId.has(parsed.authorizationRecordId)) {
      throw new AuthorizationError(
        "AUTHORIZATION_PERSISTENCE_FAILED",
        `Authorization record already exists: ${parsed.authorizationRecordId}`,
      );
    }
    if (this.byApproval.has(parsed.approvalRequestId)) {
      throw new AuthorizationError(
        "AUTHORIZATION_ALREADY_DECIDED",
        `Authorization already recorded for request ${parsed.approvalRequestId}`,
      );
    }
    this.byId.set(parsed.authorizationRecordId, parsed);
    this.byApproval.set(parsed.approvalRequestId, parsed.authorizationRecordId);
    const order = this.orderByRun.get(parsed.runId) ?? [];
    order.push(parsed.authorizationRecordId);
    this.orderByRun.set(parsed.runId, order);
    return parsed;
  }

  async getByApprovalRequest(
    approvalRequestId: string,
  ): Promise<AuthorizationRecord | null> {
    const id = this.byApproval.get(approvalRequestId);
    if (!id) {
      return null;
    }
    return this.byId.get(id) ?? null;
  }

  async getLatestByRun(runId: string): Promise<AuthorizationRecord | null> {
    const order = this.orderByRun.get(runId);
    const latestId = order?.[order.length - 1];
    if (!latestId) {
      return null;
    }
    return this.byId.get(latestId) ?? null;
  }

  async listByRun(runId: string): Promise<readonly AuthorizationRecord[]> {
    const order = this.orderByRun.get(runId) ?? [];
    return order
      .map((id) => this.byId.get(id))
      .filter((record): record is AuthorizationRecord => Boolean(record));
  }

  async exists(authorizationRecordId: string): Promise<boolean> {
    return this.byId.has(authorizationRecordId);
  }
}
