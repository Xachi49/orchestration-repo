import { z } from "zod";

export const TestProfileIdSchema = z.enum([
  "TYPECHECK",
  "UNIT_TESTS",
  "BUILD",
]);
export type TestProfileId = z.infer<typeof TestProfileIdSchema>;

export interface RegisteredTestProfile {
  readonly testProfileId: TestProfileId;
  /** Trusted argv — never model-controlled shell strings. shell:false conceptually. */
  readonly argv: readonly string[];
  readonly shell: false;
  readonly description: string;
  /** Deterministic timeout bound for the registered profile. */
  readonly timeoutSeconds: number;
}

const DEFAULT_PROFILES: readonly RegisteredTestProfile[] = [
  {
    testProfileId: "TYPECHECK",
    argv: ["npm", "run", "typecheck"],
    shell: false,
    description: "TypeScript typecheck via package script",
    timeoutSeconds: 120,
  },
  {
    testProfileId: "UNIT_TESTS",
    argv: ["npm", "test"],
    shell: false,
    description: "Unit test suite via package script",
    timeoutSeconds: 600,
  },
  {
    testProfileId: "BUILD",
    argv: ["npm", "run", "build"],
    shell: false,
    description: "Production build via package script",
    timeoutSeconds: 300,
  },
];

/**
 * Maps plan-referenced testProfileId → trusted code-defined argv.
 * Models cannot introduce new profiles or free-form commands.
 */
export class TestProfileRegistry {
  private readonly byId = new Map<string, RegisteredTestProfile>();

  constructor(profiles: readonly RegisteredTestProfile[] = DEFAULT_PROFILES) {
    for (const profile of profiles) {
      this.byId.set(profile.testProfileId, profile);
    }
  }

  get(testProfileId: string): RegisteredTestProfile | null {
    return this.byId.get(testProfileId) ?? null;
  }

  require(testProfileId: string): RegisteredTestProfile {
    const profile = this.get(testProfileId);
    if (!profile) {
      throw new Error(`Unregistered test profile: ${testProfileId}`);
    }
    return profile;
  }

  list(): readonly RegisteredTestProfile[] {
    return [...this.byId.values()];
  }

  isRegistered(testProfileId: string): boolean {
    return this.byId.has(testProfileId);
  }
}
