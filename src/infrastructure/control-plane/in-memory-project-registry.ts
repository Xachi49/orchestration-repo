import { parseProject, type Project } from "../../control-plane/projects/project.js";
import type { ProjectRegistry } from "../../control-plane/projects/registry.js";

export class InMemoryProjectRegistry implements ProjectRegistry {
  private readonly projects: ReadonlyMap<string, Project>;

  constructor(seed: readonly Project[] = []) {
    const map = new Map<string, Project>();
    for (const item of seed) {
      const project = parseProject(item);
      if (map.has(project.projectId)) {
        throw new Error(
          `Duplicate projectId in seed: ${project.projectId}`,
        );
      }
      map.set(project.projectId, Object.freeze(project));
    }
    this.projects = map;
  }

  async getById(projectId: string): Promise<Project | null> {
    return this.projects.get(projectId) ?? null;
  }

  async exists(projectId: string): Promise<boolean> {
    return this.projects.has(projectId);
  }

  async list(): Promise<readonly Project[]> {
    return [...this.projects.values()];
  }
}
