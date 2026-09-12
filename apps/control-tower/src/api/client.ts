export type ApiErrorBody = {
  error?: string;
  message?: string;
  reasonCode?: string;
  requestId?: string;
  outcome?: string;
  issues?: unknown;
};

export class ApiClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;
  readonly body: ApiErrorBody;

  constructor(status: number, body: ApiErrorBody, requestId?: string) {
    super(body.message ?? body.error ?? `HTTP ${status}`);
    this.name = "ApiClientError";
    this.status = status;
    this.code = body.error ?? body.reasonCode ?? `HTTP_${status}`;
    this.body = body;
    if (requestId) this.requestId = requestId;
  }
}

/**
 * sessionStorage holds only a DEVELOPMENT principal *selector* for the
 * header identity adapter. This is NOT an authentication credential.
 * Never store approval nonces, bearer secrets, DB credentials, API keys,
 * or governance proofs here.
 */
const PRINCIPAL_KEY = "orchestrator.principalId";

/** Development default selector — not production identity. */
export const DEV_DEFAULT_PRINCIPAL_ID = "user_local";

export function getPrincipalId(): string {
  return sessionStorage.getItem(PRINCIPAL_KEY) ?? DEV_DEFAULT_PRINCIPAL_ID;
}

export function setPrincipalId(principalId: string): void {
  sessionStorage.setItem(PRINCIPAL_KEY, principalId);
}

/** Assert development selector storage never holds secret material. */
export function assertNoSecretsInBrowserStorage(): void {
  const forbidden = [
    "decisionNonce",
    "decisionNonceHash",
    "bearer",
    "apiKey",
    "DATABASE_URL",
    "APPROVAL_DELIVERY",
  ];
  for (const store of [sessionStorage, localStorage]) {
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i) ?? "";
      const value = store.getItem(key) ?? "";
      for (const needle of forbidden) {
        if (
          key.toLowerCase().includes(needle.toLowerCase()) ||
          value.toLowerCase().includes(needle.toLowerCase())
        ) {
          throw new Error(`Forbidden secret-like material in browser storage: ${key}`);
        }
      }
    }
  }
}

export async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  // DEVELOPMENT header identity adapter only — server must not trust this in PRODUCTION.
  headers.set("x-orchestrator-principal", getPrincipalId());
  const requestId = `ct_${crypto.randomUUID()}`;
  headers.set("x-request-id", requestId);

  const response = await fetch(path, { ...init, headers });
  const responseRequestId = response.headers.get("x-request-id") ?? requestId;
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { message: text };
    }
  }
  if (!response.ok) {
    throw new ApiClientError(
      response.status,
      (body ?? {}) as ApiErrorBody,
      responseRequestId,
    );
  }
  return body as T;
}
