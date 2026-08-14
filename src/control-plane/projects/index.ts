/**
 * Control-plane: project registry contracts.
 * Phase 0: types only.
 */
export interface ProjectRecord {
  projectId: string;
  name: string;
  createdAt: string;
}

export interface ProjectRegistryPort {
  getById(projectId: string): Promise<ProjectRecord | null>;
}
