import { RuntimeError } from "./errors.js";

export interface AuthenticatedPrincipal {
  principalId: string;
  authenticationMode: "HEADER_PRINCIPAL" | "STATIC_PRINCIPAL" | "ANONYMOUS";
}

/**
 * HTTP perimeter identity only.
 * Does not grant approval, execution, policy, or capability authority.
 */
export interface RequestAuthenticator {
  authenticate(
    headers: Readonly<Record<string, string | string[] | undefined>>,
  ): AuthenticatedPrincipal;
}

export class AnonymousRequestAuthenticator implements RequestAuthenticator {
  authenticate(): AuthenticatedPrincipal {
    return {
      principalId: "anonymous",
      authenticationMode: "ANONYMOUS",
    };
  }
}

export class StaticRequestAuthenticator implements RequestAuthenticator {
  constructor(private readonly principalId: string) {}

  authenticate(): AuthenticatedPrincipal {
    return {
      principalId: this.principalId,
      authenticationMode: "STATIC_PRINCIPAL",
    };
  }
}

export class HeaderRequestAuthenticator implements RequestAuthenticator {
  authenticate(
    headers: Readonly<Record<string, string | string[] | undefined>>,
  ): AuthenticatedPrincipal {
    const raw = headers["x-orchestrator-principal"];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (!value || value.trim().length === 0) {
      throw new RuntimeError(
        "UNAUTHENTICATED",
        "Missing x-orchestrator-principal",
      );
    }
    return {
      principalId: value.trim(),
      authenticationMode: "HEADER_PRINCIPAL",
    };
  }
}

export class FakeRequestAuthenticator implements RequestAuthenticator {
  constructor(private readonly principal: AuthenticatedPrincipal | null) {}

  authenticate(): AuthenticatedPrincipal {
    if (!this.principal) {
      throw new RuntimeError("UNAUTHENTICATED", "No test principal bound");
    }
    return this.principal;
  }
}

export function createRequestAuthenticator(input: {
  mode: "ANONYMOUS" | "HEADER_PRINCIPAL" | "STATIC_PRINCIPAL";
  staticPrincipalId?: string;
}): RequestAuthenticator {
  if (input.mode === "ANONYMOUS") {
    return new AnonymousRequestAuthenticator();
  }
  if (input.mode === "STATIC_PRINCIPAL") {
    if (!input.staticPrincipalId) {
      throw new RuntimeError(
        "RUNTIME_CONFIG_INVALID",
        "STATIC_PRINCIPAL requires a principal id",
      );
    }
    return new StaticRequestAuthenticator(input.staticPrincipalId);
  }
  return new HeaderRequestAuthenticator();
}
