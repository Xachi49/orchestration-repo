import { describe, expect, it } from "vitest";
import { EXAMPLE_BUDGET, EXAMPLE_PROJECT_ID } from "../../control-plane/fixtures.js";
import { PostgresExecutionResourceLedgerStore } from "./repositories/execution-resource-ledger.js";
import {
  createTestStack,
  uniquePostgresTestId,
} from "./test-helpers.js";

describe("PostgreSQL execution resource ledger", () => {
  it("reserveDurationMs persists the exact reservation and reloads after restart", async () => {
    const attemptId = uniquePostgresTestId("ledger_reserve");
    const runId = uniquePostgresTestId("ledger_reserve_run");
    const reservedMs = 45_000;

    const envA = await createTestStack(uniquePostgresTestId("ledger_reserve_a"));
    try {
      const store = new PostgresExecutionResourceLedgerStore(envA.db);
      const initialized = await store.initialize({
        executionAttemptId: attemptId,
        runId,
        projectId: EXAMPLE_PROJECT_ID,
        budget: EXAMPLE_BUDGET,
      });
      expect(initialized.usage.reservedDurationMs).toBe(0);
      expect(initialized.recordRevision).toBe(1);

      const reserved = await store.reserveDurationMs(
        attemptId,
        initialized.recordRevision,
        reservedMs,
      );
      expect(reserved.usage.reservedDurationMs).toBe(reservedMs);
      expect(reserved.recordRevision).toBe(initialized.recordRevision + 1);
      expect(reserved.projectId).toBe(EXAMPLE_PROJECT_ID);
      expect(reserved.runId).toBe(runId);
    } finally {
      await envA.close();
    }

    const envB = await createTestStack(uniquePostgresTestId("ledger_reserve_b"));
    try {
      const storeB = new PostgresExecutionResourceLedgerStore(envB.db);
      const reloaded = await storeB.load(attemptId);
      expect(reloaded).not.toBeNull();
      expect(reloaded!.usage.reservedDurationMs).toBe(reservedMs);
      expect(reloaded!.runId).toBe(runId);
      expect(reloaded!.projectId).toBe(EXAMPLE_PROJECT_ID);
    } finally {
      await envB.close();
    }
  });

  it("settleReservedDuration consumes exact usage and survives reload", async () => {
    const attemptId = uniquePostgresTestId("ledger_settle");
    const runId = uniquePostgresTestId("ledger_settle_run");
    const reservedMs = 20_000;
    const actualMs = 12_500;

    const envA = await createTestStack(uniquePostgresTestId("ledger_settle_a"));
    try {
      const store = new PostgresExecutionResourceLedgerStore(envA.db);
      const initialized = await store.initialize({
        executionAttemptId: attemptId,
        runId,
        projectId: EXAMPLE_PROJECT_ID,
        budget: EXAMPLE_BUDGET,
      });
      const reserved = await store.reserveDurationMs(
        attemptId,
        initialized.recordRevision,
        reservedMs,
      );
      const settled = await store.settleReservedDuration(
        attemptId,
        reserved.recordRevision,
        reservedMs,
        actualMs,
      );
      expect(settled.usage.reservedDurationMs).toBe(0);
      expect(settled.usage.durationMs).toBe(actualMs);
    } finally {
      await envA.close();
    }

    const envB = await createTestStack(uniquePostgresTestId("ledger_settle_b"));
    try {
      const reloaded = await new PostgresExecutionResourceLedgerStore(envB.db).load(
        attemptId,
      );
      expect(reloaded?.usage.reservedDurationMs).toBe(0);
      expect(reloaded?.usage.durationMs).toBe(actualMs);
    } finally {
      await envB.close();
    }
  });

  it("releaseReservation rolls reservation back without consuming duration", async () => {
    const attemptId = uniquePostgresTestId("ledger_release");
    const runId = uniquePostgresTestId("ledger_release_run");
    const reservedMs = 8_000;

    const env = await createTestStack(uniquePostgresTestId("ledger_release_a"));
    try {
      const store = new PostgresExecutionResourceLedgerStore(env.db);
      const initialized = await store.initialize({
        executionAttemptId: attemptId,
        runId,
        projectId: EXAMPLE_PROJECT_ID,
        budget: EXAMPLE_BUDGET,
      });
      const reserved = await store.reserveDurationMs(
        attemptId,
        initialized.recordRevision,
        reservedMs,
      );
      const released = await store.releaseReservation(
        attemptId,
        reserved.recordRevision,
        reservedMs,
      );
      expect(released.usage.reservedDurationMs).toBe(0);
      expect(released.usage.durationMs).toBe(0);

      const loaded = await store.load(attemptId);
      expect(loaded?.usage.reservedDurationMs).toBe(0);
      expect(loaded?.usage.durationMs).toBe(0);
    } finally {
      await env.close();
    }
  });
});
