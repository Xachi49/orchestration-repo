import { createHash } from "node:crypto";
import type { FederationAgreement } from "./agreement.js";
import type { FederationRatification } from "./ratification.js";
import type { FederationParticipationChange } from "./participation.js";

export interface FederationStateFingerprintInput {
  federationId: string;
  /** Active agreement identity when present; otherwise null. */
  activeAgreement: {
    agreementId: string;
    agreementVersion: number;
    agreementHash: string;
    scopeHash: string;
    status: string;
  } | null;
  /** Candidate / current agreement under consideration. */
  agreement: Pick<
    FederationAgreement,
    | "agreementId"
    | "agreementVersion"
    | "agreementHash"
    | "participantInstitutionIds"
    | "scopeHash"
    | "status"
  >;
  ratifications: readonly Pick<
    FederationRatification,
    "ratificationId" | "ratificationHash" | "institutionId"
  >[];
  participationChanges: readonly Pick<
    FederationParticipationChange,
    "changeId" | "changeHash" | "institutionId" | "changeType"
  >[];
}

export function computeFederationStateFingerprint(
  input: FederationStateFingerprintInput,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        federationId: input.federationId,
        activeAgreement: input.activeAgreement,
        agreement: {
          agreementId: input.agreement.agreementId,
          agreementVersion: input.agreement.agreementVersion,
          agreementHash: input.agreement.agreementHash,
          participantInstitutionIds: [
            ...input.agreement.participantInstitutionIds,
          ].sort(),
          scopeHash: input.agreement.scopeHash,
          status: input.agreement.status,
        },
        ratifications: [...input.ratifications]
          .map((r) => ({
            ratificationId: r.ratificationId,
            ratificationHash: r.ratificationHash,
            institutionId: r.institutionId,
          }))
          .sort((a, b) => a.ratificationId.localeCompare(b.ratificationId)),
        participationChanges: [...input.participationChanges]
          .map((c) => ({
            changeId: c.changeId,
            changeHash: c.changeHash,
            institutionId: c.institutionId,
            changeType: c.changeType,
          }))
          .sort((a, b) => a.changeId.localeCompare(b.changeId)),
      }),
      "utf8",
    )
    .digest("hex");
}
