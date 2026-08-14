import type { AdmissionRequest } from "./request.js";
import type { RequesterGrant } from "./authorization.js";
import {
  EXAMPLE_ENVIRONMENT,
  EXAMPLE_PROJECT_ID,
} from "../control-plane/fixtures.js";

export const EXAMPLE_REQUESTER_ID = "user_local";

export const EXAMPLE_REQUESTER_GRANTS: readonly RequesterGrant[] = [
  {
    requesterId: EXAMPLE_REQUESTER_ID,
    projectId: EXAMPLE_PROJECT_ID,
    environments: [EXAMPLE_ENVIRONMENT, "development"],
  },
];

export function exampleAdmissionRequest(
  overrides: Partial<AdmissionRequest> = {},
): AdmissionRequest {
  return {
    projectId: EXAMPLE_PROJECT_ID,
    objectiveId: "obj_phase2_example",
    objectiveVersion: 1,
    requestedOutcome: "Admit a local patch-only objective",
    acceptanceCriteria: ["Run is ADMITTED", "Event envelope is persisted"],
    nonGoals: ["Execution", "LLM planning"],
    constraints: ["No external side effects"],
    priority: "HIGH",
    requesterId: EXAMPLE_REQUESTER_ID,
    requestedEnvironment: EXAMPLE_ENVIRONMENT,
    submittedAt: "2026-08-14T12:00:00.000Z",
    ...overrides,
  };
}
