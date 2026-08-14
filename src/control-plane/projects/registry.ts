import type { Project } from "./project.js";

/**
 * Read-side project registry.
 * Mutation is not part of this port; seed via infrastructure constructors.
 */
export interface ProjectRegistry {
  getById(projectId: string): Promise<Project | null>;
  exists(projectId: string): Promise<boolean>;
  list(): Promise<readonly Project[]>;
}

/** Phase 0 name retained as an alias. */
export type ProjectRegistryPort = ProjectRegistry;
