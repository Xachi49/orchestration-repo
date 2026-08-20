export interface BuildIdentity {
  applicationVersion: string;
  nodeVersion: string;
  runtimeEnvironment: string;
  gitCommitSha?: string;
  buildTimestamp?: string;
}

export function loadBuildIdentity(input: {
  runtimeEnvironment: string;
  applicationVersion: string;
  env?: NodeJS.ProcessEnv;
}): BuildIdentity {
  const env = input.env ?? process.env;
  const identity: BuildIdentity = {
    applicationVersion: input.applicationVersion,
    nodeVersion: process.version,
    runtimeEnvironment: input.runtimeEnvironment,
  };
  const git = env["GIT_COMMIT_SHA"]?.trim();
  const built = env["BUILD_TIMESTAMP"]?.trim();
  if (git) {
    identity.gitCommitSha = git;
  }
  if (built) {
    identity.buildTimestamp = built;
  }
  return identity;
}

export function newRuntimeId(): string {
  return `runtime_${crypto.randomUUID()}`;
}
