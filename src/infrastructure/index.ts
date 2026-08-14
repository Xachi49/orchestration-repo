/**
 * Infrastructure ports — replaceable adapters.
 * No GitHub, LLM, shell, or secret-bearing implementations in Phase 0.
 */

export interface ClockPort {
  nowIso(): string;
}

export class SystemClock implements ClockPort {
  nowIso(): string {
    return new Date().toISOString();
  }
}

export interface IdGeneratorPort {
  generate(prefix: string): string;
}

export class CryptoIdGenerator implements IdGeneratorPort {
  generate(prefix: string): string {
    return `${prefix}_${crypto.randomUUID()}`;
  }
}

/** Marker: shell execution is forbidden in Phase 0. */
export interface ShellExecutionPort {
  readonly enabled: false;
}

export const DISABLED_SHELL: ShellExecutionPort = { enabled: false };

/** Marker: LLM providers are not connected in Phase 0. */
export interface LlmPort {
  readonly connected: false;
}

export const DISCONNECTED_LLM: LlmPort = { connected: false };

/** Marker: GitHub APIs are not connected in Phase 0. */
export interface GitHubPort {
  readonly connected: false;
}

export const DISCONNECTED_GITHUB: GitHubPort = { connected: false };
