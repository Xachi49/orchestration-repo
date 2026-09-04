import type { ConstitutionalTestStack } from "./test-fixtures.js";

type RepoWithById<T> = { byId: Map<string, T> };
type RepoWithByProposal<T> = {
  byId: Map<string, T>;
  byProposal: Map<string, T>;
  byIdempotency?: Map<string, T>;
};
type RepoWithEvents<T> = { events: T[] };
type RepoWithByProposalList<T> = {
  byId: Map<string, T>;
  byProposal: Map<string, T[]>;
};

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

function snapshotByProposal<T>(repo: unknown): {
  byId: Map<string, T>;
  byProposal: Map<string, T>;
  byIdempotency: Map<string, T>;
} {
  const r = repo as RepoWithByProposal<T>;
  return {
    byId: new Map(r.byId),
    byProposal: new Map(r.byProposal),
    byIdempotency: new Map(r.byIdempotency ?? new Map()),
  };
}

function restoreByProposal<T>(
  repo: unknown,
  snap: ReturnType<typeof snapshotByProposal<T>>,
): void {
  const r = repo as RepoWithByProposal<T>;
  r.byId.clear();
  r.byProposal.clear();
  if (r.byIdempotency) {
    r.byIdempotency.clear();
  }
  for (const [k, v] of snap.byId) r.byId.set(k, v);
  for (const [k, v] of snap.byProposal) r.byProposal.set(k, v);
  if (r.byIdempotency) {
    for (const [k, v] of snap.byIdempotency) r.byIdempotency.set(k, v);
  }
}

function snapshotReviewDecisions(repo: unknown): {
  byId: Map<string, unknown>;
  byProposal: Map<string, unknown[]>;
} {
  const r = repo as RepoWithByProposalList<unknown>;
  return {
    byId: new Map(r.byId),
    byProposal: new Map(
      [...r.byProposal.entries()].map(([k, v]) => [k, [...v]]),
    ),
  };
}

function restoreReviewDecisions(
  repo: unknown,
  snap: ReturnType<typeof snapshotReviewDecisions>,
): void {
  const r = repo as RepoWithByProposalList<unknown>;
  r.byId.clear();
  r.byProposal.clear();
  for (const [k, v] of snap.byId) r.byId.set(k, v);
  for (const [k, v] of snap.byProposal) r.byProposal.set(k, v);
}

export interface ConstitutionalTestSnapshot {
  institutions: Map<string, unknown>;
  units: Map<string, unknown>;
  mandates: Map<string, unknown>;
  proposals: Map<string, unknown>;
  activationRecords: ReturnType<typeof snapshotByProposal<unknown>>;
  reviewDecisions: ReturnType<typeof snapshotReviewDecisions>;
  audits: unknown[];
}

export function snapshotConstitutionalStack(
  stack: ConstitutionalTestStack,
): ConstitutionalTestSnapshot {
  return {
    institutions: snapshotMap(stack.institutions),
    units: snapshotMap(stack.units),
    mandates: snapshotMap(stack.mandates),
    proposals: snapshotMap(stack.constitutionalDeps.proposals),
    activationRecords: snapshotByProposal(stack.constitutionalDeps.activationRecords),
    reviewDecisions: snapshotReviewDecisions(
      stack.constitutionalDeps.reviewDecisions,
    ),
    audits: [
      ...(stack.constitutionalDeps.audits as unknown as RepoWithEvents<unknown>)
        .events,
    ],
  };
}

export function restoreConstitutionalStack(
  stack: ConstitutionalTestStack,
  snap: ConstitutionalTestSnapshot,
): void {
  restoreMap(stack.institutions, snap.institutions);
  restoreMap(stack.units, snap.units);
  restoreMap(stack.mandates, snap.mandates);
  restoreMap(stack.constitutionalDeps.proposals, snap.proposals);
  restoreByProposal(stack.constitutionalDeps.activationRecords, snap.activationRecords);
  restoreReviewDecisions(
    stack.constitutionalDeps.reviewDecisions,
    snap.reviewDecisions,
  );
  const auditRepo =
    stack.constitutionalDeps.audits as unknown as RepoWithEvents<unknown>;
  auditRepo.events.length = 0;
  auditRepo.events.push(...snap.audits);
}

/** In-memory transaction rollback for constitutional activation unit tests. */
export function createInMemoryInstitutionActivationRunner(
  stack: ConstitutionalTestStack,
): <T>(_institutionId: string, fn: () => Promise<T>) => Promise<T> {
  return async (_institutionId, fn) => {
    const snap = snapshotConstitutionalStack(stack);
    try {
      return await fn();
    } catch (error) {
      restoreConstitutionalStack(stack, snap);
      throw error;
    }
  };
}
