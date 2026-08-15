import path from "node:path";
import { sanitizeRunId } from "../ingestion/workspace-paths.js";

export function artifactRootFor(dataRoot: string, runId: string): string {
  return path.resolve(dataRoot, "runs", sanitizeRunId(runId), "artifacts");
}
