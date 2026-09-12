import type { ProjectAccessDirectory } from "../runtime/access.js";

/**
 * Viewer scope for Control Tower read models.
 * ACCESS ≠ AUTHORITY — visibility does not grant approval or execution rights.
 *
 * ANONYMOUS != AUTHENTICATED PRINCIPAL.
 * Default: fail closed — no bindings ⇒ zero authorized projects.
 * Unrestricted reads require explicit controlTowerDevAllowAll (DEVELOPMENT/TEST only).
 */
export type ControlTowerViewer = {
  principalId: string;
  /** Authorized project ids. Empty when unbound / anonymous without allow-all. */
  allowedProjectIds: readonly string[];
  /**
   * Explicit development fixture only (`ORCHESTRATOR_CONTROL_TOWER_DEV_ALLOW_ALL`).
   * Never inferred from empty bindings, ANONYMOUS, or environment alone.
   */
  unrestricted: boolean;
};

export function resolveControlTowerViewer(input: {
  principalId: string;
  access?: ProjectAccessDirectory;
  authenticationMode: "ANONYMOUS" | "HEADER_PRINCIPAL" | "STATIC_PRINCIPAL";
  runtimeEnvironment: string;
  /** Explicit DEVELOPMENT/TEST fixture — default false. */
  controlTowerDevAllowAll?: boolean;
}): ControlTowerViewer {
  const { principalId, access, runtimeEnvironment, controlTowerDevAllowAll } =
    input;
  void input.authenticationMode;

  const allowAllExplicit =
    controlTowerDevAllowAll === true &&
    (runtimeEnvironment === "DEVELOPMENT" || runtimeEnvironment === "TEST");

  if (allowAllExplicit) {
    return {
      principalId,
      allowedProjectIds: [],
      unrestricted: true,
    };
  }

  const allowed = access ? access.projectsFor(principalId) : [];
  return {
    principalId,
    allowedProjectIds: allowed,
    unrestricted: false,
  };
}

export function viewerMayAccessProject(
  viewer: ControlTowerViewer,
  projectId: string,
): boolean {
  if (viewer.unrestricted) return true;
  return viewer.allowedProjectIds.includes(projectId);
}

export function filterByViewerProjects<T extends { projectId: string }>(
  viewer: ControlTowerViewer,
  rows: readonly T[],
): T[] {
  if (viewer.unrestricted) {
    return [...rows];
  }
  if (viewer.allowedProjectIds.length === 0) return [];
  const allowed = new Set(viewer.allowedProjectIds);
  return rows.filter((row) => allowed.has(row.projectId));
}
