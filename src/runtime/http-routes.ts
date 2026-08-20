export const HTTP_ROUTE_CLASSES = [
  "PUBLIC_OPERATIONAL",
  "AUTHENTICATED_READ",
  "AUTHENTICATED_MUTATION",
  "APPROVER_OPERATION",
  "INTERNAL_ONLY",
] as const;
export type HttpRouteClass = (typeof HTTP_ROUTE_CLASSES)[number];

export function classifyHttpRoute(
  method: string,
  url: string,
): HttpRouteClass {
  const path = url.split("?")[0] ?? url;
  if (
    method === "GET" &&
    (path === "/health" ||
      path === "/health/live" ||
      path === "/health/ready" ||
      path === "/health/info")
  ) {
    return "PUBLIC_OPERATIONAL";
  }
  if (method === "GET" && path === "/ops/diagnostics") {
    return "INTERNAL_ONLY";
  }
  if (
    method === "POST" &&
    /\/approval-requests\/[^/]+\/decision$/.test(path)
  ) {
    return "APPROVER_OPERATION";
  }
  if (method === "GET") {
    return "AUTHENTICATED_READ";
  }
  return "AUTHENTICATED_MUTATION";
}

export function extractProjectIdFromBody(body: unknown): string | undefined {
  if (!body || typeof body !== "object") {
    return undefined;
  }
  const record = body as Record<string, unknown>;
  return typeof record["projectId"] === "string"
    ? record["projectId"]
    : undefined;
}

export function extractRunIdFromUrl(url: string): string | undefined {
  const match = /\/v1\/runs\/([^/]+)/.exec(url.split("?")[0] ?? url);
  return match?.[1];
}

export function extractApprovalRequestIdFromUrl(url: string): string | undefined {
  const match = /\/v1\/approval-requests\/([^/]+)(?:\/|$)/.exec(
    url.split("?")[0] ?? url,
  );
  return match?.[1];
}
