import { z } from "zod";

export const RepositoryProviderSchema = z.enum(["GITHUB"]);
export type RepositoryProvider = z.infer<typeof RepositoryProviderSchema>;

export const RepositoryIdentitySchema = z
  .object({
    provider: RepositoryProviderSchema,
    owner: z.string().min(1),
    repository: z.string().min(1),
  })
  .strict();
export type RepositoryIdentity = z.infer<typeof RepositoryIdentitySchema>;

export const RepositorySourceSchema = z
  .object({
    projectId: z.string().min(1),
    provider: RepositoryProviderSchema,
    owner: z.string().min(1),
    repository: z.string().min(1),
    defaultBranch: z.string().min(1),
    remoteUrl: z.string().min(1),
    installationAccountRef: z.string().min(1).optional(),
    enabled: z.boolean(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type RepositorySource = z.infer<typeof RepositorySourceSchema>;

export function parseRepositorySource(input: unknown): RepositorySource {
  return RepositorySourceSchema.parse(input);
}

const GITHUB_HTTPS =
  /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;
const GITHUB_SSH =
  /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/;

export function parseGitHubRemoteUrl(
  url: string,
): { owner: string; repository: string } | null {
  const https = url.trim().match(GITHUB_HTTPS);
  if (https?.[1] && https[2]) {
    return { owner: https[1], repository: https[2] };
  }
  const ssh = url.trim().match(GITHUB_SSH);
  if (ssh?.[1] && ssh[2]) {
    return { owner: ssh[1], repository: ssh[2] };
  }
  return null;
}

export interface RepositorySourceRegistry {
  getByProjectId(projectId: string): Promise<RepositorySource | null>;
  exists(projectId: string): Promise<boolean>;
  list(): Promise<readonly RepositorySource[]>;
}
