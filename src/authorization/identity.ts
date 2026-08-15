export interface AuthorizationIdentityGenerator {
  nextApprovalRequestId(): string;
  nextAuthorizationRecordId(): string;
  nextModificationRequestId(): string;
}

export class SequenceAuthorizationIdentityGenerator
  implements AuthorizationIdentityGenerator
{
  private approvalCounter = 0;
  private recordCounter = 0;
  private modificationCounter = 0;

  nextApprovalRequestId(): string {
    this.approvalCounter += 1;
    return `apr_${this.approvalCounter}`;
  }

  nextAuthorizationRecordId(): string {
    this.recordCounter += 1;
    return `authz_${this.recordCounter}`;
  }

  nextModificationRequestId(): string {
    this.modificationCounter += 1;
    return `mod_${this.modificationCounter}`;
  }
}

/** Default Phase 6 approval window: 24 hours. */
export const DEFAULT_APPROVAL_WINDOW_MS = 24 * 60 * 60 * 1000;

export function addMsIso(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}

export function isExpired(expiresAt: string, nowIso: string): boolean {
  return Date.parse(nowIso) >= Date.parse(expiresAt);
}
