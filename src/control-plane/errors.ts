export const CONTROL_PLANE_ERROR_CODES = [
  "PROJECT_NOT_FOUND",
  "PROJECT_INACTIVE",
  "POLICY_BUNDLE_NOT_FOUND",
  "POLICY_CONFLICT",
  "CAPABILITY_NOT_FOUND",
  "CAPABILITY_DISABLED",
  "ENVIRONMENT_NOT_ALLOWED",
  "BUDGET_PROFILE_NOT_FOUND",
  "BUDGET_EXCEEDED",
  "UNESTIMATED_RESOURCE",
] as const;

export type ControlPlaneErrorCode = (typeof CONTROL_PLANE_ERROR_CODES)[number];

export class ControlPlaneError extends Error {
  readonly code: ControlPlaneErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: ControlPlaneErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "ControlPlaneError";
    this.code = code;
    this.details = details;
  }
}

export function isControlPlaneError(error: unknown): error is ControlPlaneError {
  return error instanceof ControlPlaneError;
}
