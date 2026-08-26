import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const runnerPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../src/migrations/runner.ts");
const runnerSource = readFileSync(runnerPath, "utf8");

describe("0239 versioning runner wiring", () => {
  it("preflights globals + per-office versioning before 0235, without an early backfill or ledger", () => {
    const preflight = runnerSource.indexOf("await installTasksAssignedAtVersioning(client, sql)");
    const acknowledgementPhases = runnerSource.indexOf(
      "await runTaskAssignmentAcknowledgementsMigration(client)",
      preflight
    );
    const acknowledgementLedger = runnerSource.indexOf(
      '"INSERT INTO public._migrations (name) VALUES ($1)"',
      acknowledgementPhases
    );
    const preflightWindow = runnerSource.slice(preflight, acknowledgementPhases);

    expect(preflight).toBeGreaterThan(-1);
    expect(acknowledgementPhases).toBeGreaterThan(preflight);
    expect(preflightWindow).not.toContain("runTasksAssignedAtBackfill");
    expect(preflightWindow).not.toContain('INSERT INTO public._migrations');
    expect(acknowledgementLedger).toBeGreaterThan(acknowledgementPhases);
  });

  it("serializes normal 0239 staging, backfill and ledger behind its own session lock", () => {
    const start = runnerSource.indexOf("async function runTasksAssignedAtMigrationUnderLock");
    const end = runnerSource.indexOf("\nasync function runMigrations", start);
    const normal0239 = runnerSource.slice(start, end);
    const lock = normal0239.indexOf("SELECT pg_advisory_lock(hashtext($1))");
    const recheck = normal0239.indexOf("SELECT id FROM public._migrations WHERE name = $1", lock);
    const staging = normal0239.indexOf("await installTasksAssignedAtVersioning(client, sql)", recheck);
    const backfill = normal0239.indexOf("await runTasksAssignedAtBackfill(client)", staging);
    const ledger = normal0239.indexOf('"INSERT INTO public._migrations (name) VALUES ($1)"', backfill);
    const unlock = normal0239.indexOf("SELECT pg_advisory_unlock(hashtext($1))", ledger);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(normal0239).toContain("TASKS_ASSIGNED_AT_MIGRATION_LOCK");
    expect(normal0239).not.toContain("pg_advisory_xact_lock");
    expect(lock).toBeGreaterThan(-1);
    expect(recheck, "runner B must recheck the ledger only after waiting for runner A").toBeGreaterThan(lock);
    expect(staging, "a restart stages the bounded 0239 surface after the recheck").toBeGreaterThan(recheck);
    expect(backfill).toBeGreaterThan(staging);
    expect(ledger, "ledger is written only after the full staged/backfill sequence").toBeGreaterThan(backfill);
    expect(unlock, "release the session lock after recording the ledger").toBeGreaterThan(ledger);
    expect(normal0239).toContain("if (!stagedInThisRun.has(file))");
    expect(normal0239).not.toContain("await client.query(sql)");

    const dispatchStart = runnerSource.indexOf("if (file === TASKS_ASSIGNED_AT_BACKFILL_MIGRATION) {");
    const dispatchEnd = runnerSource.indexOf("console.log(`Running ${file}...`)", dispatchStart);
    const dispatch = runnerSource.slice(dispatchStart, dispatchEnd);
    expect(dispatch).toContain("await runTasksAssignedAtMigrationUnderLock(client, file, stagedInThisRun)");
    expect(dispatch).toContain("continue;");
  });
});
