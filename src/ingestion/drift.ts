export const DRIFT_RESULTS = [
  "CURRENT",
  "DRIFT_DETECTED",
  "REMOTE_UNAVAILABLE",
  "INVALID_STATE",
] as const;
export type DriftResultCode = (typeof DRIFT_RESULTS)[number];

export type DriftResult =
  | { result: "CURRENT"; lockedSha: string; remoteSha: string }
  | {
      result: "DRIFT_DETECTED";
      lockedSha: string;
      remoteSha: string;
    }
  | { result: "REMOTE_UNAVAILABLE"; lockedSha: string }
  | { result: "INVALID_STATE"; reason: string };

export function compareLockedToRemote(
  lockedSha: string | undefined,
  remoteSha: string | undefined,
): DriftResult {
  if (!lockedSha || !/^[0-9a-f]{40}$/i.test(lockedSha)) {
    return { result: "INVALID_STATE", reason: "locked SHA is missing or malformed" };
  }
  if (!remoteSha) {
    return { result: "REMOTE_UNAVAILABLE", lockedSha };
  }
  if (!/^[0-9a-f]{40}$/i.test(remoteSha)) {
    return { result: "INVALID_STATE", reason: "remote SHA is malformed" };
  }
  if (lockedSha.toLowerCase() === remoteSha.toLowerCase()) {
    return { result: "CURRENT", lockedSha, remoteSha };
  }
  return { result: "DRIFT_DETECTED", lockedSha, remoteSha };
}
