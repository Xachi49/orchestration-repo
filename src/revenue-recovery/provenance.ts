/**
 * Server-assigned economic trust provenance.
 * Caller-supplied source labels never become trusted provenance.
 *
 * EVENT KIND != TRUST PROVENANCE
 * MANUAL ASSERTION != EXTERNALLY VERIFIED PAYMENT
 */
export const TRUST_PROVENANCE_CLASSES = [
  "FAKE_TEST",
  "MANUAL_ATTESTATION",
  "TRUSTED_CRM",
  "TRUSTED_PAYMENT_SOURCE",
] as const;

export type TrustProvenanceClass = (typeof TRUST_PROVENANCE_CLASSES)[number];

export const PRODUCT_RUNTIME_ENVIRONMENTS = [
  "TEST",
  "DEVELOPMENT",
  "STAGING",
  "PRODUCTION",
] as const;

export type ProductRuntimeEnvironment =
  (typeof PRODUCT_RUNTIME_ENVIRONMENTS)[number];

/** Generic HTTP / operator ingestion always receives MANUAL_ATTESTATION. */
export const GENERIC_EVENT_API_PROVENANCE = "MANUAL_ATTESTATION" as const;

export function isFakeTestAllowed(
  environment: ProductRuntimeEnvironment,
): boolean {
  return environment === "TEST";
}

export function resolveConfidenceFromProvenance(input: {
  eventKind: "APPOINTMENT_BOOKED" | "SALE_RECORDED" | "PAYMENT_RECORDED";
  trustProvenance: TrustProvenanceClass;
  runtimeEnvironment: ProductRuntimeEnvironment;
}):
  | {
      confidenceClass:
        | "ESTIMATED"
        | "ATTESTED_SALE"
        | "ATTESTED_PAYMENT"
        | "CONFIRMED_SALE"
        | "CONFIRMED_PAYMENT";
      attributionType:
        | "APPOINTMENT_VALUE_ESTIMATE"
        | "SALE_RECORDED"
        | "PAYMENT_COLLECTED";
    }
  | { deny: true; reason: string } {
  if (input.trustProvenance === "FAKE_TEST") {
    if (!isFakeTestAllowed(input.runtimeEnvironment)) {
      return {
        deny: true,
        reason: "FAKE_TEST economic provenance rejected outside TEST",
      };
    }
  }

  if (input.eventKind === "APPOINTMENT_BOOKED") {
    return {
      confidenceClass: "ESTIMATED",
      attributionType: "APPOINTMENT_VALUE_ESTIMATE",
    };
  }

  if (input.eventKind === "SALE_RECORDED") {
    if (
      input.trustProvenance === "TRUSTED_CRM" ||
      input.trustProvenance === "FAKE_TEST"
    ) {
      return {
        confidenceClass: "CONFIRMED_SALE",
        attributionType: "SALE_RECORDED",
      };
    }
    if (input.trustProvenance === "MANUAL_ATTESTATION") {
      return {
        confidenceClass: "ATTESTED_SALE",
        attributionType: "SALE_RECORDED",
      };
    }
    // TRUSTED_PAYMENT_SOURCE does not casually imply sale truth.
    return {
      deny: true,
      reason: "Provenance cannot establish CONFIRMED_SALE",
    };
  }

  // PAYMENT_RECORDED
  if (
    input.trustProvenance === "TRUSTED_PAYMENT_SOURCE" ||
    input.trustProvenance === "FAKE_TEST"
  ) {
    return {
      confidenceClass: "CONFIRMED_PAYMENT",
      attributionType: "PAYMENT_COLLECTED",
    };
  }
  if (input.trustProvenance === "MANUAL_ATTESTATION") {
    return {
      confidenceClass: "ATTESTED_PAYMENT",
      attributionType: "PAYMENT_COLLECTED",
    };
  }
  // TRUSTED_CRM alone cannot mint cash-collected truth.
  return {
    deny: true,
    reason: "Provenance cannot establish CONFIRMED_PAYMENT",
  };
}

export function provenanceDisplayLabel(
  confidenceClass: string,
): string {
  switch (confidenceClass) {
    case "ESTIMATED":
      return "Estimated";
    case "ATTESTED_SALE":
    case "ATTESTED_PAYMENT":
      return "Operator Attested";
    case "CONFIRMED_SALE":
      return "CRM Confirmed";
    case "CONFIRMED_PAYMENT":
      return "Payment Confirmed";
    default:
      return confidenceClass;
  }
}
