const PASSWORD_IN_URL = /(:\/\/[^:/?#]+:)([^@/]+)(@)/;

export function redactDatabaseUrl(url: string): string {
  return url.replace(PASSWORD_IN_URL, "$1***$3");
}

export function redactUnknown(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(PASSWORD_IN_URL, "$1***$3")
    .replaceAll("TEST_DB_PASSWORD_SENTINEL", "[REDACTED]")
    .replaceAll("TEST_API_KEY_SENTINEL", "[REDACTED]")
    .replaceAll("TEST_APPROVAL_NONCE_SENTINEL", "[REDACTED]")
    .replaceAll("TEST_DELIVERY_KEY_SENTINEL", "[REDACTED]");
}

export function connectionDetailsForLog(url: string): {
  redactedUrl: string;
} {
  return { redactedUrl: redactDatabaseUrl(url) };
}
