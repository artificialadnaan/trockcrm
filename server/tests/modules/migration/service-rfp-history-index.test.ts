import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { runServiceRfpHistoryIndexMigration, runServiceRfpSubmissionsMigration } from "../../../src/migrations/service-rfp-history-index.js";

const migrationSql = readFileSync(new URL("../../../../migrations/0245_service_rfp_submissions.sql", import.meta.url), "utf8");
const normalize = (value: string) => value.replace(/\s+/g, " ").trim();

describe("service RFP online history index migration", () => {
  it.each([null, false, true])("handles absent/invalid/valid index without a blocking build: %s", async (validity) => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    query.mockResolvedValueOnce({ rows: validity === null ? [] : [{ is_valid: validity }] });
    await runServiceRfpHistoryIndexMigration({ query } as never);
    const calls = query.mock.calls.map(([statement]) => String(statement));
    const creates = calls.filter((statement) => statement.startsWith("CREATE INDEX"));
    expect(creates).toHaveLength(validity === true ? 0 : 1);
    expect(calls.filter((statement) => statement.startsWith("DROP INDEX"))).toHaveLength(validity === false ? 1 : 0);
    if (creates.length) {
      expect(creates[0]).toContain("CREATE INDEX CONCURRENTLY IF NOT EXISTS job_queue_service_rfp_history_idx");
      const declared = migrationSql.match(/CREATE INDEX IF NOT EXISTS job_queue_service_rfp_history_idx[\s\S]*?;/)![0].replace(/;$/, "");
      expect(normalize(creates[0]!.replace(" CONCURRENTLY", ""))).toBe(normalize(declared));
    }
    expect(calls.some((statement) => /^BEGIN|^COMMIT/.test(statement))).toBe(false);
    expect(calls.filter((statement) => statement.startsWith("DROP INDEX")).every((statement) => statement.includes(" CONCURRENTLY "))).toBe(true);
  });

  it("holds a session lock across the standalone online build, file and ledger", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await expect(runServiceRfpSubmissionsMigration({ query } as never, migrationSql)).resolves.toBe(true);
    const calls = query.mock.calls.map(([statement]) => String(statement));
    expect(calls[0]).toContain("pg_advisory_lock");
    expect(calls[1]).toContain("SELECT id FROM public._migrations");
    const createIndex = calls.findIndex((statement) => statement.startsWith("CREATE INDEX CONCURRENTLY"));
    expect(createIndex).toBeGreaterThan(1);
    expect(calls[createIndex + 1]).toBe(migrationSql);
    expect(calls[createIndex + 2]).toContain("INSERT INTO public._migrations");
    expect(calls.at(-1)).toContain("pg_advisory_unlock");
    expect(migrationSql).toContain("IF to_regclass('public.job_queue_service_rfp_history_idx') IS NULL THEN");
    const runner = readFileSync(new URL("../../../src/migrations/runner.ts", import.meta.url), "utf8");
    expect(runner).toContain("if (file === SERVICE_RFP_SUBMISSIONS_MIGRATION)");
    expect(runner).toContain("await runServiceRfpSubmissionsMigration(client,");
  });

  it("rechecks the ledger after locking and skips an already completed deployment", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ id: 245 }] });
    await expect(runServiceRfpSubmissionsMigration({ query } as never, migrationSql)).resolves.toBe(false);
    expect(query).toHaveBeenCalledTimes(3);
    expect(String(query.mock.calls[2]![0])).toContain("pg_advisory_unlock");
  });

  it("releases the session lock without publishing a ledger entry when the online build fails", async () => {
    const query = vi.fn().mockImplementation(async (statement: string) => {
      if (statement.startsWith("CREATE INDEX CONCURRENTLY")) throw new Error("interrupted build");
      return { rows: [] };
    });
    await expect(runServiceRfpSubmissionsMigration({ query } as never, migrationSql)).rejects.toThrow("interrupted build");
    expect(query.mock.calls.some(([statement]) => statement.includes("INSERT INTO public._migrations"))).toBe(false);
    expect(query.mock.calls.at(-1)![0]).toContain("pg_advisory_unlock");
  });
});
