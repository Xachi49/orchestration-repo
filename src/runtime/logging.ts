export const TEST_SECRET_SENTINELS = [
  "TEST_DB_PASSWORD_SENTINEL",
  "TEST_API_KEY_SENTINEL",
  "TEST_APPROVAL_NONCE_SENTINEL",
  "TEST_DELIVERY_KEY_SENTINEL",
] as const;

const SECRET_PATTERNS: readonly RegExp[] = [
  /postgres:\/\/[^/\s]+/gi,
  /postgresql:\/\/[^/\s]+/gi,
  /password=\S+/gi,
  /authorization:\s*\S+/gi,
  /bearer\s+\S+/gi,
  /api[_-]?key[=:]\s*\S+/gi,
  /APPROVAL_DELIVERY_SECRET_KEY[=:]\s*\S+/gi,
  /DATABASE_URL[=:]\s*\S+/gi,
];

const SECRET_KEYS = new Set([
  "password",
  "secret",
  "token",
  "authorization",
  "apiKey",
  "api_key",
  "databaseUrl",
  "DATABASE_URL",
  "deliverySecret",
  "nonce",
  "decisionNonce",
  "ciphertext",
]);

export function redactText(input: string): string {
  let next = input;
  for (const sentinel of TEST_SECRET_SENTINELS) {
    next = next.split(sentinel).join("[REDACTED]");
  }
  for (const pattern of SECRET_PATTERNS) {
    next = next.replace(pattern, "[REDACTED]");
  }
  return next.replace(/(:\/\/[^:/?#]+:)([^@/]+)(@)/g, "$1***$3");
}

export function redactUnknown(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value);
  return redactText(text);
}

export function redactRecord(
  input: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (SECRET_KEYS.has(key) || /secret|password|token|nonce|key/i.test(key)) {
      out[key] = "[REDACTED]";
      continue;
    }
    if (typeof value === "string") {
      out[key] = redactText(value);
    } else if (value instanceof Error) {
      out[key] = redactUnknown(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export interface LogFields {
  timestamp: string;
  level: "debug" | "info" | "warn" | "error";
  service: string;
  runtimeId: string;
  message: string;
  requestId?: string;
  projectId?: string;
  runId?: string;
  phase?: string;
  operation?: string;
  result?: string;
  durationMs?: number;
  [key: string]: unknown;
}

export interface StructuredLogger {
  log(fields: Omit<LogFields, "timestamp" | "service" | "runtimeId"> & {
    timestamp?: string;
  }): void;
  lines(): readonly string[];
}

/**
 * Structured operational logs. LOGS != EVENT AUTHORITY.
 */
export class MemoryStructuredLogger implements StructuredLogger {
  private readonly captured: string[] = [];

  constructor(
    private readonly runtimeId: string,
    private readonly sink: (line: string) => void = (line) => {
      process.stdout.write(`${line}\n`);
    },
    private readonly service = "orchestrator",
  ) {}

  log(
    fields: Omit<LogFields, "timestamp" | "service" | "runtimeId"> & {
      timestamp?: string;
    },
  ): void {
    const record = redactRecord({
      timestamp: fields.timestamp ?? new Date().toISOString(),
      service: this.service,
      runtimeId: this.runtimeId,
      ...fields,
    });
    const line = JSON.stringify(record);
    this.captured.push(line);
    this.sink(line);
  }

  lines(): readonly string[] {
    return this.captured;
  }
}
