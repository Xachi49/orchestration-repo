/**
 * Project binding is part of authorization, not a UUID lookup convenience.
 * Global identifiers alone do not grant cross-project access.
 */
export class ProjectScopeError extends Error {
  readonly code = "PROJECT_SCOPE_VIOLATION" as const;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "ProjectScopeError";
    this.details = details;
  }
}

export function isProjectScopeError(
  error: unknown,
): error is ProjectScopeError {
  return error instanceof ProjectScopeError;
}

export function assertProjectScope(
  actualProjectId: string | undefined,
  expectedProjectId: string,
  kind: string,
  id: string,
): void {
  if (actualProjectId !== expectedProjectId) {
    throw new ProjectScopeError(
      `${kind} ${id} is not in project ${expectedProjectId}`,
      {
        kind,
        id,
        actualProjectId: actualProjectId ?? null,
        expectedProjectId,
      },
    );
  }
}
