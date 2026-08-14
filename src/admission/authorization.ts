export const AUTHORIZATION_DECISIONS = [
  "AUTHORIZED",
  "UNAUTHORIZED",
  "UNKNOWN_REQUESTER",
  "PROJECT_ACCESS_DENIED",
  "ENVIRONMENT_ACCESS_DENIED",
] as const;

export type AuthorizationDecisionCode =
  (typeof AUTHORIZATION_DECISIONS)[number];

export interface AuthorizationQuery {
  projectId: string;
  requesterId: string;
  requestedEnvironment: string;
}

export type AuthorizationDecision =
  | { decision: "AUTHORIZED" }
  | {
      decision: Exclude<AuthorizationDecisionCode, "AUTHORIZED">;
    };

export interface RequesterAuthorizationService {
  authorize(query: AuthorizationQuery): Promise<AuthorizationDecision>;
}

export interface RequesterGrant {
  requesterId: string;
  projectId: string;
  environments: readonly string[];
}
