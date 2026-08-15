import { ControlPlaneService } from "../../control-plane/service.js";
import {
  EXAMPLE_BUDGET,
  EXAMPLE_CAPABILITIES,
  EXAMPLE_POLICY_BUNDLE,
  EXAMPLE_PROJECT,
} from "../../control-plane/fixtures.js";
import { EXAMPLE_REQUESTER_GRANTS } from "../../admission/fixtures.js";
import type { RequesterGrant } from "../../admission/authorization.js";
import { ObjectiveAdmissionService } from "../../admission/service.js";
import { NoopObservability } from "../../observability/index.js";
import { FixedClock } from "../clock.js";
import { InMemoryProjectRegistry } from "../control-plane/in-memory-project-registry.js";
import { InMemoryCapabilityRegistry } from "../control-plane/in-memory-capability-registry.js";
import { InMemoryPolicyRegistry } from "../control-plane/in-memory-policy-registry.js";
import { InMemoryResourceBudgetRegistry } from "../control-plane/in-memory-budget-registry.js";
import { InMemoryRequesterAuthorization } from "./in-memory-authorization.js";
import { InMemoryIdempotencyStore } from "./in-memory-idempotency-store.js";
import { InMemoryProjectLockService } from "./in-memory-project-lock.js";
import { InMemoryRunRepository } from "./in-memory-run-repository.js";
import { InMemoryEventStore } from "./in-memory-event-store.js";
import { SequenceAdmissionIdentityGenerator } from "./identity.js";

export interface LocalAdmissionStack {
  service: ObjectiveAdmissionService;
  controlPlane: ControlPlaneService;
  runs: InMemoryRunRepository;
  events: InMemoryEventStore;
  locks: InMemoryProjectLockService;
  idempotency: InMemoryIdempotencyStore;
  clock: FixedClock;
}

export function createLocalAdmissionStack(options?: {
  grants?: readonly RequesterGrant[];
  clockIso?: string;
}): LocalAdmissionStack {
  const clock = new FixedClock(options?.clockIso ?? "2026-08-14T12:00:00.000Z");
  const controlPlane = new ControlPlaneService({
    projects: new InMemoryProjectRegistry([EXAMPLE_PROJECT]),
    capabilities: new InMemoryCapabilityRegistry(EXAMPLE_CAPABILITIES),
    policies: new InMemoryPolicyRegistry([EXAMPLE_POLICY_BUNDLE], { clock }),
    budgets: new InMemoryResourceBudgetRegistry([EXAMPLE_BUDGET]),
    clock,
  });
  const runs = new InMemoryRunRepository();
  const events = new InMemoryEventStore();
  const locks = new InMemoryProjectLockService();
  const idempotency = new InMemoryIdempotencyStore();
  const service = new ObjectiveAdmissionService({
    controlPlane,
    authorization: new InMemoryRequesterAuthorization(
      options?.grants ?? EXAMPLE_REQUESTER_GRANTS,
    ),
    idempotency,
    locks,
    runs,
    events,
    identities: new SequenceAdmissionIdentityGenerator(),
    clock,
    observability: new NoopObservability(),
  });
  return { service, controlPlane, runs, events, locks, idempotency, clock };
}
