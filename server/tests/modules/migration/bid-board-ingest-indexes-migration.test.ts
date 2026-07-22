import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it, vi } from "vitest";
import {
  BID_BOARD_INGEST_MIGRATION,
  JOB_QUEUE_BBI_ONE_LIVE_JOB_INDEX,
  JOB_QUEUE_PROCESSING_INDEX,
  runBidBoardIngestIndexMigration,
} from "../../../src/migrations/bid-board-ingest-indexes.js";

const migrationPath = resolve(
  import.meta.dirname,
  "../../../../migrations/0188_bid_board_ingestion_inbox.sql"
);

describe("bid board ingest job_queue index migration (CONCURRENTLY)", () => {
  it("builds BOTH job_queue indexes CONCURRENTLY when neither exists (no DROP)", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] }) // processing idx: not present
      .mockResolvedValueOnce(undefined) // processing CREATE
      .mockResolvedValueOnce({ rows: [] }) // one-live idx: not present
      .mockResolvedValueOnce(undefined); // one-live CREATE

    await runBidBoardIngestIndexMigration({ query } as never);

    const sql = query.mock.calls.map((call) => String(call[0]));
    const creates = sql.filter((s) => s.includes("INDEX CONCURRENTLY"));
    expect(creates).toHaveLength(2);
    expect(creates[0]).toContain(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${JOB_QUEUE_PROCESSING_INDEX}`);
    expect(creates[0]).toContain("public.job_queue (job_type, started_processing_at)");
    expect(creates[0]).toContain("WHERE status = 'processing'");
    expect(creates[1]).toContain(
      `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ${JOB_QUEUE_BBI_ONE_LIVE_JOB_INDEX}`
    );
    expect(creates[1]).toContain("(payload->>'inboxId')");
    expect(creates[1]).toContain("job_type = 'bid_board_ingest' AND status IN ('pending', 'processing')");
    expect(sql.some((s) => s.includes("DROP INDEX CONCURRENTLY"))).toBe(false);
  });

  it("drops an INVALID index stub before recreating it CONCURRENTLY, leaving a valid sibling untouched", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ is_valid: false }] }) // processing: invalid stub from a prior aborted build
      .mockResolvedValueOnce(undefined) // DROP processing
      .mockResolvedValueOnce(undefined) // CREATE processing
      .mockResolvedValueOnce({ rows: [{ is_valid: true }] }) // one-live: already valid
      .mockResolvedValueOnce(undefined); // CREATE one-live (IF NOT EXISTS → server-side no-op)

    await runBidBoardIngestIndexMigration({ query } as never);

    const sql = query.mock.calls.map((call) => String(call[0]));
    const drops = sql.filter((s) => s.includes("DROP INDEX CONCURRENTLY"));
    expect(drops).toHaveLength(1);
    expect(drops[0]).toContain(`DROP INDEX CONCURRENTLY IF EXISTS public.${JOB_QUEUE_PROCESSING_INDEX}`);
  });

  it("does not drop indexes that are valid or absent", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ is_valid: true }] }) // processing: valid
      .mockResolvedValueOnce(undefined) // CREATE processing
      .mockResolvedValueOnce({ rows: [] }) // one-live: absent
      .mockResolvedValueOnce(undefined); // CREATE one-live

    await runBidBoardIngestIndexMigration({ query } as never);

    const sql = query.mock.calls.map((call) => String(call[0]));
    expect(sql.some((s) => s.includes("DROP INDEX CONCURRENTLY"))).toBe(false);
    expect(sql.filter((s) => s.includes("INDEX CONCURRENTLY IF NOT EXISTS"))).toHaveLength(2);
  });

  it("keeps the migration SQL file annotated for the runner intercept + plain IF NOT EXISTS no-op", () => {
    const sql = readFileSync(migrationPath, "utf8");
    expect(BID_BOARD_INGEST_MIGRATION).toBe("0188_bid_board_ingestion_inbox.sql");
    // The runner intercepts this file to build the two job_queue indexes CONCURRENTLY first.
    expect(sql).toContain("server/src/migrations/runner.ts");
    // The in-file plain builds stay (they no-op via IF NOT EXISTS once the helper has built them).
    expect(sql).toContain(`CREATE INDEX IF NOT EXISTS ${JOB_QUEUE_PROCESSING_INDEX}`);
    expect(sql).toContain(`CREATE UNIQUE INDEX IF NOT EXISTS ${JOB_QUEUE_BBI_ONE_LIVE_JOB_INDEX}`);
  });
});
