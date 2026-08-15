import type { RepositorySource } from "./repository-source.js";
import type { CommitMetadata } from "./remote-repository.js";
import {
  EXAMPLE_PROJECT,
  EXAMPLE_PROJECT_ID,
} from "../control-plane/fixtures.js";
import { parseGitHubRemoteUrl } from "./repository-source.js";

export const EXAMPLE_COMMIT_SHA =
  "1111111111111111111111111111111111111111";
export const EXAMPLE_DRIFT_SHA =
  "2222222222222222222222222222222222222222";

const parsed = parseGitHubRemoteUrl(EXAMPLE_PROJECT.repositoryUrl);
if (!parsed) {
  throw new Error("Example project repositoryUrl is not a GitHub URL");
}

export const EXAMPLE_REPOSITORY_OWNER = parsed.owner;
export const EXAMPLE_REPOSITORY_NAME = parsed.repository;

export const EXAMPLE_REPOSITORY_SOURCE: RepositorySource = {
  projectId: EXAMPLE_PROJECT_ID,
  provider: "GITHUB",
  owner: EXAMPLE_REPOSITORY_OWNER,
  repository: EXAMPLE_REPOSITORY_NAME,
  defaultBranch: EXAMPLE_PROJECT.defaultBranch,
  remoteUrl: EXAMPLE_PROJECT.repositoryUrl,
  enabled: true,
  createdAt: EXAMPLE_PROJECT.createdAt,
  updatedAt: EXAMPLE_PROJECT.updatedAt,
};

export const EXAMPLE_COMMIT_METADATA: CommitMetadata = {
  sha: EXAMPLE_COMMIT_SHA,
  message: "example commit",
  authorName: "example",
  committedAt: "2026-08-14T12:00:00.000Z",
};

export const EXAMPLE_WORKSPACE_FILES: ReadonlyArray<{
  relativePath: string;
  content: Buffer;
}> = [
  {
    relativePath: "package.json",
    content: Buffer.from(
      '{"name":"example","lockfileVersion":1}\n',
      "utf8",
    ),
  },
  {
    relativePath: "package-lock.json",
    content: Buffer.from('{"lockfileVersion":3}\n', "utf8"),
  },
  {
    relativePath: "tsconfig.json",
    content: Buffer.from('{"compilerOptions":{"strict":true}}\n', "utf8"),
  },
  {
    relativePath: "src/index.ts",
    content: Buffer.from("export const value = 1;\n", "utf8"),
  },
  {
    relativePath: "src/index.test.ts",
    content: Buffer.from('import { value } from "./index.js";\n', "utf8"),
  },
  {
    relativePath: "README.md",
    content: Buffer.from("# example\n", "utf8"),
  },
  {
    relativePath: "dist/out.js",
    content: Buffer.from("generated\n", "utf8"),
  },
  {
    relativePath: "assets/blob.bin",
    content: Buffer.from([0x00, 0x01, 0x02, 0xff]),
  },
];
