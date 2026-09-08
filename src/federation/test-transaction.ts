import type { FederationTestStack } from "./test-fixtures.js";

type RepoWithById<T> = { byId: Map<string, T> };
type RepoWithEvents<T> = { events: T[] };

function snapshotMap<T>(repo: unknown): Map<string, T> {
  return new Map((repo as RepoWithById<T>).byId);
}

function restoreMap<T>(repo: unknown, snap: Map<string, T>): void {
  const target = (repo as RepoWithById<T>).byId;
  target.clear();
  for (const [key, value] of snap) {
    target.set(key, value);
  }
}

export interface FederationTestSnapshot {
  agreements: Map<string, unknown>;
  ratifications: Map<string, unknown>;
  activationRecords: Map<string, unknown>;
  activationByAgreement: Map<string, unknown>;
  participation: Map<string, unknown>;
  intents: Map<string, unknown>;
  acceptances: Map<string, unknown>;
  acceptancesByIntent: Map<string, unknown>;
  materializations: Map<string, unknown>;
  materializationsByIntent: Map<string, unknown>;
  materializationsByIdempotency: Map<string, unknown>;
  evidence: Map<string, unknown>;
  audits: unknown[];
}

export function snapshotFederationStack(
  stack: FederationTestStack,
): FederationTestSnapshot {
  const deps = stack.federationDeps;
  return {
    agreements: snapshotMap(deps.agreements),
    ratifications: snapshotMap(deps.ratifications),
    activationRecords: snapshotMap(deps.activationRecords),
    activationByAgreement: new Map(
      (
        deps.activationRecords as unknown as {
          byAgreement: Map<string, unknown>;
        }
      ).byAgreement,
    ),
    participation: snapshotMap(deps.participationChanges),
    intents: snapshotMap(deps.intents),
    acceptances: snapshotMap(deps.acceptances),
    acceptancesByIntent: new Map(
      (
        deps.acceptances as unknown as { byIntent: Map<string, unknown> }
      ).byIntent,
    ),
    materializations: snapshotMap(deps.materializations),
    materializationsByIntent: new Map(
      (
        deps.materializations as unknown as {
          byIntent: Map<string, unknown>;
        }
      ).byIntent,
    ),
    materializationsByIdempotency: new Map(
      (
        deps.materializations as unknown as {
          byIdempotency: Map<string, unknown>;
        }
      ).byIdempotency,
    ),
    evidence: snapshotMap(deps.evidence),
    audits: [...(deps.audits as unknown as RepoWithEvents<unknown>).events],
  };
}

export function restoreFederationStack(
  stack: FederationTestStack,
  snap: FederationTestSnapshot,
): void {
  const deps = stack.federationDeps;
  restoreMap(deps.agreements, snap.agreements);
  restoreMap(deps.ratifications, snap.ratifications);
  restoreMap(deps.activationRecords, snap.activationRecords);
  const act = deps.activationRecords as unknown as {
    byAgreement: Map<string, unknown>;
  };
  act.byAgreement.clear();
  for (const [k, v] of snap.activationByAgreement) act.byAgreement.set(k, v);
  restoreMap(deps.participationChanges, snap.participation);
  restoreMap(deps.intents, snap.intents);
  restoreMap(deps.acceptances, snap.acceptances);
  const acc = deps.acceptances as unknown as {
    byIntent: Map<string, unknown>;
  };
  acc.byIntent.clear();
  for (const [k, v] of snap.acceptancesByIntent) acc.byIntent.set(k, v);
  restoreMap(deps.materializations, snap.materializations);
  const mat = deps.materializations as unknown as {
    byIntent: Map<string, unknown>;
    byIdempotency: Map<string, unknown>;
  };
  mat.byIntent.clear();
  mat.byIdempotency.clear();
  for (const [k, v] of snap.materializationsByIntent) mat.byIntent.set(k, v);
  for (const [k, v] of snap.materializationsByIdempotency)
    mat.byIdempotency.set(k, v);
  restoreMap(deps.evidence, snap.evidence);
  const audits = deps.audits as unknown as RepoWithEvents<unknown>;
  audits.events.length = 0;
  audits.events.push(...snap.audits);
}

/** In-memory multi-institution activation runner with rollback on throw. */
export function createInMemoryFederationActivationRunner(
  stack: FederationTestStack,
): <T>(
  participantInstitutionIds: readonly string[],
  fn: () => Promise<T>,
) => Promise<T> {
  return async (participantInstitutionIds, fn) => {
    // Canonical sorted lock order (deterministic; no caller-order dependence).
    const sorted = [...participantInstitutionIds].sort((a, b) =>
      a.localeCompare(b),
    );
    void sorted;
    const snap = snapshotFederationStack(stack);
    try {
      return await fn();
    } catch (error) {
      restoreFederationStack(stack, snap);
      throw error;
    }
  };
}
