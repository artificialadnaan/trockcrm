// Runtime suite for the view-log RETENTION SWEEP.
//
// `weekly_report_views` exists so "you never sent us that report" can be answered with evidence — full
// IP, full user agent, per access. The same properties that make it useful make an unbounded version of
// it a liability, and the people in it are the client's staff. Twenty-four months is the boundary.
//
// Three things here are silent when wrong, which is why each has a case:
//
//   1. THE CUTOFF. Off by a factor (days vs months) and the sweep either deletes everything or nothing,
//      and "nothing" looks exactly like a healthy run.
//   2. THE PROBE. Migrations do not run on the worker, so between deploys this table may not exist.
//   3. THE BATCH LOOP. It must actually loop — a version that deletes one batch and returns leaves the
//      backlog behind while reporting success.

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrationSql } from "../../../server/tests/helpers/migration-sql.js";
import {
  WEEKLY_REPORT_VIEW_RETENTION_MONTHS,
  runWeeklyReportViewPurge,
} from "../../src/jobs/weekly-report-view-purge.js";

const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const REPORT = U("55551");

let pg: PGlite;
let query: (text: string, params?: unknown[]) => Promise<any>;
const silent = { log: () => {}, warn: () => {}, error: () => {} };

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(migrationSql("0231_weekly_report_views"));
  // PGlite reports a DELETE's row count as `affectedRows`; node-postgres — which is what the job runs on
  // in production, via `pool.query` — calls it `rowCount`. The adapter renames it and nothing else, so
  // the batch loop is still reading a number the DATABASE produced rather than one the test decided.
  // Teaching the job to accept both shapes instead would put a branch in production code that only a
  // test can reach.
  query = async (text: string, params?: unknown[]) => {
    const result: any = await pg.query(text, params);
    return { ...result, rowCount: result.affectedRows ?? result.rowCount ?? 0 };
  };
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(`DELETE FROM public.weekly_report_views;`);
});

/** One access, `monthsAgo` months in the past — relative to the database's clock, as the sweep is. */
async function seedView(monthsAgo: number, eventType = "page") {
  await pg.query(
    `INSERT INTO public.weekly_report_views (weekly_report_id, event_type, occurred_at)
     VALUES ($1::uuid, $2, now() - ($3 || ' months')::interval)`,
    [REPORT, eventType, String(monthsAgo)],
  );
}

async function remaining(): Promise<number> {
  const result = await pg.query(`SELECT count(*)::int AS n FROM public.weekly_report_views`);
  return (result.rows[0] as { n: number }).n;
}

describe("the retention boundary", () => {
  it("removes an access older than the retention window", async () => {
    await seedView(WEEKLY_REPORT_VIEW_RETENTION_MONTHS + 1);

    const result = await runWeeklyReportViewPurge({ query, logger: silent });

    expect(result.ran).toBe(true);
    expect(result.deleted).toBe(1);
    expect(await remaining()).toBe(0);
  });

  it("keeps an access inside the window", async () => {
    // The control, and the one that matters most. Without it a sweep whose interval unit is wrong —
    // months read as days — passes the test above while deleting the entire log on its first run.
    await seedView(WEEKLY_REPORT_VIEW_RETENTION_MONTHS - 1);

    const result = await runWeeklyReportViewPurge({ query, logger: silent });

    expect(result.deleted).toBe(0);
    expect(await remaining()).toBe(1);
  });

  it("keeps a brand-new access, which is every access the day it is logged", async () => {
    await seedView(0);
    await runWeeklyReportViewPurge({ query, logger: silent });
    expect(await remaining()).toBe(1);
  });

  it("splits a mixed table on the boundary rather than by table", async () => {
    await seedView(WEEKLY_REPORT_VIEW_RETENTION_MONTHS + 6, "page");
    await seedView(WEEKLY_REPORT_VIEW_RETENTION_MONTHS + 2, "pdf");
    await seedView(1, "page");
    await seedView(3, "photo");

    const result = await runWeeklyReportViewPurge({ query, logger: silent });

    expect(result.deleted).toBe(2);
    expect(await remaining()).toBe(2);
  });
});

describe("what it does when the table is not there", () => {
  it("skips quietly instead of throwing every time the cron fires", async () => {
    // Migrations run on the API container only. Between an API deploy and a worker deploy — or in any
    // environment where the worker is ahead — this table does not exist yet. Without the probe the sweep
    // throws `relation does not exist` on a schedule and buries the rest of the worker log.
    const missing = new PGlite();
    try {
      const result = await runWeeklyReportViewPurge({
        query: ((text: string, params?: unknown[]) => missing.query(text, params)) as any,
        logger: silent,
      });
      expect(result.ran).toBe(false);
      expect(result.deleted).toBe(0);
    } finally {
      await missing.close();
    }
  });
});

describe("a backlog larger than one batch", () => {
  it("keeps going until the old rows are gone, rather than stopping after the first pass", async () => {
    // `batchSize: 5` against 12 old rows is THE POINT — three passes, the last one short. At the
    // production 5,000 this test would seed 12 rows, delete them in a single statement, and prove
    // nothing at all about looping while its name claimed otherwise. That is why the job takes a batch
    // size: a version that deletes one batch and returns has to be able to fail something.
    for (let index = 0; index < 12; index += 1) await seedView(6);
    for (let index = 0; index < 3; index += 1) await seedView(0);

    const result = await runWeeklyReportViewPurge({
      query,
      logger: silent,
      retentionMonths: 3,
      batchSize: 5,
    });

    expect(result.deleted).toBe(12);
    expect(result.moreRemaining).toBe(false);
    expect(await remaining()).toBe(3);
  });

  it("does not warn about a backlog it just finished clearing", async () => {
    // EXACTLY the ceiling: 40 rows at one per batch. The last batch comes back full, which is what the
    // ceiling watches for — but the backlog is gone. Inferring "more remain" from a full final batch
    // raises a warning that nothing can clear and that no next pass will contradict, because the next
    // pass finds nothing to delete and says nothing at all. Flagged by CodeRabbit.
    for (let index = 0; index < 40; index += 1) await seedView(6);

    // `maxBatches: 40` is what makes this test its own name. At the production 2,000 the loop cleared
    // the backlog and exited through the ordinary empty-batch path, so the final-batch probe never ran
    // — a guard that could not fire, inside the test written to stop exactly that. Flagged by
    // CodeRabbit, and it is the same defect this file exists to catch elsewhere.
    const result = await runWeeklyReportViewPurge({
      query,
      logger: silent,
      retentionMonths: 3,
      batchSize: 1,
      maxBatches: 40,
    });

    expect(result.deleted).toBe(40);
    expect(result.moreRemaining).toBe(false);
    expect(await remaining()).toBe(0);
  });

  it("does not invent a backlog when time ran out on the last of it", async () => {
    // The time-budget branch had the same hole the ceiling branch did: it asserted `moreRemaining`
    // rather than asking. The batch that spends the last of the budget may also have cleared the last
    // row, and a warning about a backlog that is not there is one no later pass will contradict.
    for (let index = 0; index < 3; index += 1) await seedView(6);

    let clock = 0;
    const result = await runWeeklyReportViewPurge({
      query,
      logger: silent,
      retentionMonths: 3,
      batchSize: 3,
      timeBudgetMs: 60_000,
      // Call 1 sets the start, call 2 is the first iteration's check and must be INSIDE the budget so
      // a batch actually runs, call 3 is past it so the loop leaves through the time branch — with the
      // backlog already gone.
      now: () => {
        clock += 1;
        return clock <= 2 ? 0 : 90_000;
      },
    });

    expect(result.deleted).toBe(3);
    expect(await remaining()).toBe(0);
    expect(result.moreRemaining).toBe(false);
  });

  it("stops on its time budget and says the backlog outlived the pass", async () => {
    // THE CEILING IS TIME, NOT A BATCH COUNT, and the arithmetic is why. One link holder may create 300
    // rows a minute — 432,000 a day — through a route with no login. The old limit of 40 batches removed
    // 200,000, so the sweep lost ground every day it ran and the oldest addresses outlived the 24-month
    // promise by more than a year. Caught by Codex.
    //
    // A fake clock rather than a real ten-minute wait: it advances a minute per call, so the budget is
    // spent after a handful of batches and the run has to yield with rows still eligible.
    for (let index = 0; index < 41; index += 1) await seedView(6);

    let clock = 0;
    const result = await runWeeklyReportViewPurge({
      query,
      logger: silent,
      retentionMonths: 3,
      batchSize: 1,
      timeBudgetMs: 5 * 60_000,
      now: () => {
        clock += 60_000;
        return clock;
      },
    });

    // Yielded rather than ground on, and SAID so — a pass that stops early and reports success is how a
    // backlog outlives every sweep that ever looked at it.
    expect(result.moreRemaining).toBe(true);
    expect(result.deleted).toBeLessThan(41);
    expect(await remaining()).toBeGreaterThan(0);
  });
});
