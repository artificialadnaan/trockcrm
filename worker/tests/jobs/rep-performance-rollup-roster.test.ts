// The WRITE half of the director-dashboard roster flag (migration 0219).
//
// `getRepPerformanceSnapshots` gates the READ on `generates_sales`, and a read gate can only filter rows
// that already exist. This job is what creates them. While it selected `u.role = 'rep'` alone, an admin
// could tick a director as a sales carrier and watch them appear on the rep cards and the funnel while
// staying permanently absent from the Activity Pulse, the strategic alerts and the coaching prompts —
// all three of which are driven from these snapshot rows. The flag would have looked half-wired, and the
// symptom (three panels quietly missing one person) is the kind nobody reports.
//
// This suite lives under worker/tests/jobs/ ON PURPOSE: the worker's CI config runs this directory, and
// the sibling tests colocated under worker/src are NOT executed by the gate.
import { describe, expect, it, vi } from "vitest";

const connectMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/db.js", () => ({ pool: { connect: connectMock } }));

import { runRepPerformanceRollup } from "../../src/jobs/rep-performance-rollup.js";

async function captureInsertSql(): Promise<string> {
  const queries: string[] = [];
  const client = {
    query: vi.fn(async (sql: string) => {
      queries.push(sql);
      if (sql.includes("SELECT id, slug, name FROM public.offices")) {
        return { rows: [{ id: "office-1", slug: "north", name: "North" }], rowCount: 1 };
      }
      return { rows: [], rowCount: sql.includes("INSERT INTO public.rep_performance_snapshots") ? 1 : 0 };
    }),
    release: vi.fn(),
  };
  connectMock.mockResolvedValue(client);

  await runRepPerformanceRollup(new Date("2026-05-07T12:00:00.000Z"));

  const insertSql = queries.find((query) => query.includes("INSERT INTO public.rep_performance_snapshots"));
  if (!insertSql) throw new Error("rollup never issued the snapshot INSERT");
  return insertSql;
}

describe("rep performance rollup roster", () => {
  it("writes snapshots for flagged sales carriers, not only role='rep'", async () => {
    const insertSql = await captureInsertSql();

    // The union is the assertion. A bare `u.role = 'rep'` here is exactly the defect: the read side would
    // have nothing to return for a flagged director.
    expect(insertSql).toContain("u.generates_sales = true");
    expect(insertSql).toMatch(/u\.role = 'rep' OR u\.generates_sales = true/);
  });

  it("keeps writing for every active rep, so unticking someone does not destroy their history", async () => {
    const insertSql = await captureInsertSql();

    // Deliberately a UNION rather than a replacement. If this became `generates_sales` alone, unticking a
    // rep would stop accruing their snapshots, and re-ticking them later would show an empty trend with
    // no way to recover the gap. The read gate already hides them; the rows are just kept warm.
    expect(insertSql).toContain("u.role = 'rep'");
    expect(insertSql).toContain("u.is_active = true");
    // ...and the office scoping the read side matches (u.office_id) is untouched.
    expect(insertSql).toContain("u.office_id = $4");
  });
});
