const PASSWORD_IN_URL = /(:\/\/[^:/?#]+:)([^@/]+)(@)/;

export function redactDatabaseUrl(url: string): string {
  return url.replace(PASSWORD_IN_URL, "$1***$3");
}

export function redactUnknown(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(PASSWORD_IN_URL, "$1***$3");
}

export function connectionDetailsForLog(url: string): {
  redactedUrl: string;
} {
  return { redactedUrl: redactDatabaseUrl(url) };
}
