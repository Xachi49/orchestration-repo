/**
 * HTTP project access. Distinct from requester grants and approver authority.
 */
export interface ProjectAccessDirectory {
  canAccessProject(principalId: string, projectId: string): boolean;
  projectsFor(principalId: string): readonly string[];
}

export class InMemoryProjectAccessDirectory implements ProjectAccessDirectory {
  private readonly bindings = new Map<string, Set<string>>();

  constructor(
    initial: readonly { principalId: string; projectIds: readonly string[] }[] = [],
  ) {
    for (const binding of initial) {
      this.grant(binding.principalId, binding.projectIds);
    }
  }

  grant(principalId: string, projectIds: readonly string[]): void {
    const set = this.bindings.get(principalId) ?? new Set<string>();
    for (const projectId of projectIds) {
      set.add(projectId);
    }
    this.bindings.set(principalId, set);
  }

  canAccessProject(principalId: string, projectId: string): boolean {
    return this.bindings.get(principalId)?.has(projectId) === true;
  }

  projectsFor(principalId: string): readonly string[] {
    return [...(this.bindings.get(principalId) ?? [])];
  }
}
