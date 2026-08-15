import {
  parseModificationRequest,
  type ModificationRequest,
} from "../domain/authorization/index.js";
import { AuthorizationError } from "./errors.js";

export interface ModificationRequestRepository {
  save(request: ModificationRequest): Promise<ModificationRequest>;
  getByApprovalRequest(
    approvalRequestId: string,
  ): Promise<ModificationRequest | null>;
  listByRun(runId: string): Promise<readonly ModificationRequest[]>;
}

export class InMemoryModificationRequestRepository
  implements ModificationRequestRepository
{
  private readonly byId = new Map<string, ModificationRequest>();
  private readonly byApproval = new Map<string, string>();
  private readonly orderByRun = new Map<string, string[]>();

  async save(request: ModificationRequest): Promise<ModificationRequest> {
    const parsed = parseModificationRequest(request);
    if (this.byId.has(parsed.modificationRequestId)) {
      throw new AuthorizationError(
        "MODIFICATION_REQUEST_INVALID",
        `Modification request already exists: ${parsed.modificationRequestId}`,
      );
    }
    this.byId.set(parsed.modificationRequestId, parsed);
    this.byApproval.set(parsed.approvalRequestId, parsed.modificationRequestId);
    const order = this.orderByRun.get(parsed.runId) ?? [];
    order.push(parsed.modificationRequestId);
    this.orderByRun.set(parsed.runId, order);
    return parsed;
  }

  async getByApprovalRequest(
    approvalRequestId: string,
  ): Promise<ModificationRequest | null> {
    const id = this.byApproval.get(approvalRequestId);
    if (!id) {
      return null;
    }
    return this.byId.get(id) ?? null;
  }

  async listByRun(runId: string): Promise<readonly ModificationRequest[]> {
    const order = this.orderByRun.get(runId) ?? [];
    return order
      .map((id) => this.byId.get(id))
      .filter((request): request is ModificationRequest => Boolean(request));
  }
}
