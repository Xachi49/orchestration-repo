import { objectiveFingerprint } from "../domain/objective/fingerprint.js";
import { objectiveIdempotencyKey } from "../domain/objective/idempotency.js";
import {
  parseEventEnvelope,
  type EventEnvelope,
} from "../domain/run/event-envelope.js";
import {
  assertTransition,
  IllegalRunTransitionError,
} from "../domain/run/run-state.js";
import {
  isControlPlaneError,
} from "../control-plane/index.js";
import type {
  ControlPlaneError,
  ControlPlaneService,
} from "../control-plane/index.js";
import type { ObservabilityPort } from "../observability/index.js";
import type { ControlPlaneClock } from "../control-plane/service.js";
import { AdmissionError } from "./errors.js";
import {
  PROJECT_OBJECTIVE_SUBMITTED,
  type EventStore,
} from "./event-store.js";
import type { AdmissionIdentityGenerator } from "./identity.js";
import type { IdempotencyStore } from "./idempotency-store.js";
import type { ProjectLockService } from "./project-lock.js";
import type { RequesterAuthorizationService } from "./authorization.js";
import {
  parseAdmissionRequest,
  type AdmissionRequest,
} from "./request.js";
import type { AdmissionResult, ControlContextReference } from "./result.js";
import {
  withRunState,
  type RunRecord,
  type RunRepository,
} from "./run-repository.js";
import type { ObjectiveRepository } from "./objective-repository.js";
import { parseObjective } from "../domain/objective/objective.js";

export interface ObjectiveAdmissionServiceDeps {
  controlPlane: ControlPlaneService;
  authorization: RequesterAuthorizationService;
  idempotency: IdempotencyStore;
  locks: ProjectLockService;
  runs: RunRepository;
  events: EventStore;
  identities: AdmissionIdentityGenerator;
  clock: ControlPlaneClock;
  observability: ObservabilityPort;
  /** Optional for Phase 2 compatibility; required for Phase 4 planning. */
  objectives?: ObjectiveRepository;
}

const EVENT_TTL_MS = 24 * 60 * 60 * 1000;
const LOCK_TTL_MS = 60 * 60 * 1000;

function addMs(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}

function eligibilityRejection(
  error: ControlPlaneError,
): AdmissionResult {
  if (error.code === "ENVIRONMENT_NOT_ALLOWED") {
    return {
      outcome: "REJECTED",
      reasonCode: "ENVIRONMENT_NOT_ALLOWED",
      message: error.message,
    };
  }
  if (error.code === "PROJECT_NOT_FOUND") {
    return {
      outcome: "REJECTED",
      reasonCode: "PROJECT_NOT_FOUND",
      message: error.message,
    };
  }
  return {
    outcome: "REJECTED",
    reasonCode: "PROJECT_NOT_ELIGIBLE",
    message: error.message,
  };
}

function traceAttributes(
  fields: Record<string, string>,
): Record<string, string> {
  return fields;
}

/**
 * Front door of the Orchestrator.
 * Admission authority and durable run identity only — no planning or execution.
 */
export class ObjectiveAdmissionService {
  private readonly controlPlane: ControlPlaneService;
  private readonly authorization: RequesterAuthorizationService;
  private readonly idempotency: IdempotencyStore;
  private readonly locks: ProjectLockService;
  private readonly runs: RunRepository;
  private readonly events: EventStore;
  private readonly identities: AdmissionIdentityGenerator;
  private readonly clock: ControlPlaneClock;
  private readonly observability: ObservabilityPort;
  private readonly objectives: ObjectiveRepository | undefined;

  constructor(deps: ObjectiveAdmissionServiceDeps) {
    this.controlPlane = deps.controlPlane;
    this.authorization = deps.authorization;
    this.idempotency = deps.idempotency;
    this.locks = deps.locks;
    this.runs = deps.runs;
    this.events = deps.events;
    this.objectives = deps.objectives;
    this.identities = deps.identities;
    this.clock = deps.clock;
    this.observability = deps.observability;
  }

  async admit(input: unknown): Promise<AdmissionResult> {
    const parsed = this.parseRequest(input);
    if (!parsed.ok) {
      return parsed.result;
    }
    return this.admitValidated(parsed.request);
  }

  private parseRequest(
    input: unknown,
  ):
    | { ok: true; request: AdmissionRequest }
    | { ok: false; result: AdmissionResult } {
    try {
      return { ok: true, request: parseAdmissionRequest(input) };
    } catch (error) {
      return {
        ok: false,
        result: {
          outcome: "REJECTED",
          reasonCode: "INVALID_ADMISSION_REQUEST",
          message:
            error instanceof Error
              ? error.message
              : "Invalid admission request",
        },
      };
    }
  }

  private async admitValidated(
    request: AdmissionRequest,
  ): Promise<AdmissionResult> {
    let controlContextReference: ControlContextReference;
    try {
      const context = await this.controlPlane.resolve(
        request.projectId,
        request.requestedEnvironment,
      );
      controlContextReference = {
        projectId: context.project.projectId,
        environment: request.requestedEnvironment,
        policyBundleId: context.activePolicyBundle.policyBundleId,
        budgetProfileId: context.resourceBudget.budgetProfileId,
        resolvedAt: context.resolvedAt,
      };
    } catch (error) {
      if (isControlPlaneError(error)) {
        return eligibilityRejection(error);
      }
      throw error;
    }

    const auth = await this.authorization.authorize({
      projectId: request.projectId,
      requesterId: request.requesterId,
      requestedEnvironment: request.requestedEnvironment,
    });
    if (auth.decision !== "AUTHORIZED") {
      const reasonCode =
        auth.decision === "UNKNOWN_REQUESTER"
          ? "UNKNOWN_REQUESTER"
          : "REQUESTER_UNAUTHORIZED";
      return {
        outcome: "REJECTED",
        reasonCode,
        message: `Requester is not authorized to submit objectives (${auth.decision})`,
      };
    }

    const fingerprint = objectiveFingerprint({
      requestedOutcome: request.requestedOutcome,
      acceptanceCriteria: request.acceptanceCriteria,
      nonGoals: request.nonGoals,
      constraints: request.constraints,
      priority: request.priority,
      ...(request.deadline !== undefined ? { deadline: request.deadline } : {}),
    });
    const idempotencyKey = objectiveIdempotencyKey({
      projectId: request.projectId,
      objectiveId: request.objectiveId,
      objectiveVersion: request.objectiveVersion,
      requestedEnvironment: request.requestedEnvironment,
    });

    const existing = await this.idempotency.getByKey(idempotencyKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return {
          outcome: "CONFLICT",
          reasonCode: "OBJECTIVE_VERSION_CONFLICT",
          message:
            "Objective content changed under the same identity (project, objective, version, environment)",
        };
      }
      const duplicate = await this.duplicateResult(
        existing.status,
        existing.runId,
        idempotencyKey,
      );
      if (duplicate) {
        return duplicate;
      }
    }

    const identity = this.identities.next();
    const now = this.clock.nowIso();
    let reserved = false;
    let locked = false;
    let created: RunRecord | null = null;
    let bound = false;

    try {
      const reservedResult = await this.idempotency.reserve(
        idempotencyKey,
        fingerprint,
        now,
      );
      if (reservedResult.status === "OBJECTIVE_VERSION_CONFLICT") {
        return {
          outcome: "CONFLICT",
          reasonCode: "OBJECTIVE_VERSION_CONFLICT",
          message:
            "Objective content changed under the same identity (project, objective, version, environment)",
        };
      }
      if (reservedResult.status !== "NEW") {
        const duplicate = await this.duplicateResult(
          reservedResult.status === "COMPLETED_DUPLICATE"
            ? "COMPLETED"
            : "ACTIVE",
          reservedResult.runId,
          idempotencyKey,
        );
        if (duplicate) {
          return duplicate;
        }
        return {
          outcome: "CONFLICT",
          reasonCode: "IDEMPOTENCY_RESERVATION_FAILED",
          message: "Idempotency key is reserved without a bound run",
        };
      }
      reserved = true;

      const lockResult = await this.locks.acquire({
        projectId: request.projectId,
        runId: identity.runId,
        lockOwner: request.requesterId,
        acquiredAt: now,
        expiresAt: addMs(now, LOCK_TTL_MS),
      });
      if (lockResult.result === "RESOURCE_CONFLICT") {
        throw new AdmissionError(
          "PROJECT_LOCK_CONFLICT",
          `Project ${request.projectId} is locked by another run`,
          {
            projectId: request.projectId,
            conflictingRunId: lockResult.lock?.runId ?? null,
          },
        );
      }
      locked = true;

      const received: RunRecord = {
        runId: identity.runId,
        projectId: request.projectId,
        objectiveId: request.objectiveId,
        objectiveVersion: request.objectiveVersion,
        idempotencyKey,
        requesterId: request.requesterId,
        requestedEnvironment: request.requestedEnvironment,
        state: "RECEIVED",
        createdAt: now,
        updatedAt: now,
        correlationId: identity.correlationId,
        traceId: identity.traceId,
      };

      try {
        created = await this.runs.create(received);
      } catch (error) {
        throw new AdmissionError(
          "RUN_CREATION_FAILED",
          "Failed to persist RECEIVED run",
          { runId: identity.runId, cause: String(error) },
        );
      }

      let admittedState: "ADMITTED";
      try {
        admittedState = assertTransition(created.state, "ADMITTED") as "ADMITTED";
      } catch (error) {
        const code =
          error instanceof IllegalRunTransitionError
            ? "INVALID_RUN_TRANSITION"
            : "INVALID_RUN_TRANSITION";
        throw new AdmissionError(
          code,
          error instanceof Error ? error.message : "Illegal run transition",
          { runId: created.runId, from: created.state, to: "ADMITTED" },
        );
      }

      const admitted = withRunState(created, admittedState, now, {
        admittedAt: now,
      });
      created = await this.runs.save(admitted);

      let eventEnvelope: EventEnvelope;
      try {
        eventEnvelope = await this.events.append(
          this.buildEvent(request, created, identity, now, idempotencyKey),
        );
      } catch (error) {
        throw new AdmissionError(
          "EVENT_CREATION_FAILED",
          "Failed to persist admission event envelope",
          { runId: created.runId, cause: String(error) },
        );
      }

      try {
        await this.idempotency.complete(idempotencyKey, created.runId, now);
        bound = true;
      } catch (error) {
        throw new AdmissionError(
          "IDEMPOTENCY_RESERVATION_FAILED",
          "Failed to bind idempotency key to run",
          { runId: created.runId, cause: String(error) },
        );
      }

      try {
        await this.locks.release(request.projectId, created.runId);
        locked = false;
      } catch (error) {
        throw new AdmissionError(
          "ADMISSION_COMPENSATION_FAILED",
          "Failed to release admission-scoped project lock",
          { runId: created.runId, cause: String(error) },
        );
      }

      if (this.objectives) {
        const objective = parseObjective({
          objectiveId: request.objectiveId,
          objectiveVersion: request.objectiveVersion,
          projectId: request.projectId,
          requestedOutcome: request.requestedOutcome,
          acceptanceCriteria: request.acceptanceCriteria,
          nonGoals: request.nonGoals,
          constraints: request.constraints,
          priority: request.priority,
          requesterId: request.requesterId,
          createdAt: request.submittedAt,
          ...(request.deadline !== undefined
            ? { deadline: request.deadline }
            : {}),
        });
        await this.objectives.save(objective);
        await this.objectives.bindRun(
          created.runId,
          objective.objectiveId,
          objective.objectiveVersion,
        );
      }

      this.observability.recordEvent(
        "admission.admitted",
        traceAttributes({
          runId: created.runId,
          correlationId: created.correlationId,
          traceId: created.traceId,
          objectiveId: created.objectiveId,
          projectId: created.projectId,
        }),
      );

      return {
        outcome: "ADMITTED",
        runId: created.runId,
        state: "ADMITTED",
        eventEnvelope,
        controlContextReference,
        idempotencyKey,
        correlationId: created.correlationId,
        traceId: created.traceId,
      };
    } catch (error) {
      await this.compensate({
        reserved,
        bound,
        locked,
        created,
        idempotencyKey,
        projectId: request.projectId,
        runId: identity.runId,
        now,
        skipRunCompensation: bound,
      });
      if (error instanceof AdmissionError && error.code === "PROJECT_LOCK_CONFLICT") {
        return {
          outcome: "CONFLICT",
          reasonCode: "PROJECT_LOCK_CONFLICT",
          message: error.message,
        };
      }
      throw error;
    }
  }

  private async duplicateResult(
    status: "RESERVED" | "ACTIVE" | "COMPLETED" | "ACTIVE_DUPLICATE" | "COMPLETED_DUPLICATE",
    runId: string | null,
    idempotencyKey: string,
  ): Promise<AdmissionResult | null> {
    const completed =
      status === "COMPLETED" || status === "COMPLETED_DUPLICATE";
    const active =
      status === "ACTIVE" ||
      status === "ACTIVE_DUPLICATE" ||
      status === "RESERVED";

    if (!completed && !active) {
      return null;
    }
    if (!runId) {
      if (status === "RESERVED") {
        return null;
      }
      return {
        outcome: "CONFLICT",
        reasonCode: completed
          ? "COMPLETED_DUPLICATE"
          : "ACTIVE_DUPLICATE",
        message: "Duplicate idempotency record is missing runId",
      };
    }
    const run = await this.runs.getById(runId);
    if (!run) {
      return {
        outcome: "CONFLICT",
        reasonCode: "IDEMPOTENCY_RESERVATION_FAILED",
        message: "Idempotency record references a missing run",
      };
    }
    return {
      outcome: completed ? "COMPLETED_DUPLICATE" : "ACTIVE_DUPLICATE",
      runId: run.runId,
      state: run.state,
      idempotencyKey,
    };
  }

  private buildEvent(
    request: AdmissionRequest,
    run: RunRecord,
    identity: { eventId: string; correlationId: string; traceId: string },
    now: string,
    idempotencyKey: string,
  ): EventEnvelope {
    return parseEventEnvelope({
      eventId: identity.eventId,
      eventType: PROJECT_OBJECTIVE_SUBMITTED,
      eventVersion: "1",
      runId: run.runId,
      correlationId: identity.correlationId,
      causationId: identity.eventId,
      idempotencyKey,
      projectId: request.projectId,
      objectiveId: request.objectiveId,
      objectiveVersion: request.objectiveVersion,
      traceId: identity.traceId,
      createdAt: now,
      expiresAt: addMs(now, EVENT_TTL_MS),
      schemaVersion: "1.0.0",
      data: {
        requesterId: request.requesterId,
        requestedEnvironment: request.requestedEnvironment,
        priority: request.priority,
        submittedAt: request.submittedAt,
      },
    });
  }

  private async compensate(input: {
    reserved: boolean;
    bound: boolean;
    locked: boolean;
    created: RunRecord | null;
    idempotencyKey: string;
    projectId: string;
    runId: string;
    now: string;
    skipRunCompensation: boolean;
  }): Promise<void> {
    try {
      if (input.created && !input.skipRunCompensation) {
        const nextState =
          input.created.state === "ADMITTED"
            ? "CANCELLED"
            : "ADMISSION_REJECTED";
        if (
          input.created.state !== "ADMISSION_REJECTED" &&
          input.created.state !== "CANCELLED"
        ) {
          const rejectedState = assertTransition(
            input.created.state,
            nextState,
          );
          await this.runs.save(
            withRunState(input.created, rejectedState, input.now, {
              failureReasonCode: "ADMISSION_COMPENSATED",
            }),
          );
        }
      }
      if (input.locked) {
        await this.locks.release(input.projectId, input.runId);
      }
      if (input.reserved && !input.bound) {
        await this.idempotency.release(input.idempotencyKey);
      }
    } catch (error) {
      throw new AdmissionError(
        "ADMISSION_COMPENSATION_FAILED",
        "Failed to compensate a partial admission",
        { runId: input.runId, cause: String(error) },
      );
    }
  }
}
