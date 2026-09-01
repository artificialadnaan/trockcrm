import { describe, expect, it } from "vitest";
import {
  buildBackfillPlan,
  parseBackfillArgs,
  runBackfillForSchema,
  type PhotoFileRow,
  type QueryClient,
} from "./backfill-photo-folder-buckets.js";

// Pure planner + runner coverage for the photo folder-bucket backfill. The planner's whole job is to
// answer "does this row's stored path already equal the one its OWN taken_at derives?" — everything that
// isn't a clear NO must be left alone, because the write is unconditional once planned.

const rows: PhotoFileRow[] = [
  // 1. THE BUG: taken in April, presigned (and therefore filed) in September.
  {
    id: "imported-april",
    subcategory: "Site Visits",
    folderPath: "Photos/Site Visits/2026-09",
    takenAt: new Date("2026-04-07T15:30:00.000Z"),
  },
  // 2. Uploaded the same month it was taken — already correct, and the shape every post-fix row has.
  {
    id: "same-month",
    subcategory: "Site Visits",
    folderPath: "Photos/Site Visits/2026-09",
    takenAt: new Date("2026-09-02T10:00:00.000Z"),
  },
  // 3. No subcategory — the bucket hangs directly off the top folder.
  {
    id: "no-subcategory",
    subcategory: null,
    folderPath: "Photos/2026-09",
    takenAt: new Date("2026-01-19T08:00:00.000Z"),
  },
  // 4. Legacy row with no folder_path at all — NULL "differs", so it gets one.
  {
    id: "null-path",
    subcategory: "Progress",
    folderPath: null,
    takenAt: new Date("2025-11-30T23:00:00.000Z"),
  },
  // 5. taken_at arriving as a driver string rather than a Date.
  {
    id: "string-date",
    subcategory: "Site Visits",
    folderPath: "Photos/Site Visits/2026-09",
    takenAt: "2026-03-15T12:00:00.000Z",
  },
  // 6. Unusable taken_at — no correct bucket exists to guess, and buildFolderPath would throw on it.
  {
    id: "garbage-date",
    subcategory: "Site Visits",
    folderPath: "Photos/Site Visits/2026-09",
    takenAt: "not-a-date",
  },
];

describe("photo folder-bucket backfill planner", () => {
  it("re-files only the photos whose stored bucket disagrees with their capture date", () => {
    const plan = buildBackfillPlan(rows);

    expect(plan.willUpdate.map((m) => m.id)).toEqual([
      "imported-april",
      "no-subcategory",
      "null-path",
      "string-date",
    ]);
    expect(Object.fromEntries(plan.willUpdate.map((m) => [m.id, m.to]))).toEqual({
      "imported-april": "Photos/Site Visits/2026-04",
      "no-subcategory": "Photos/2026-01",
      "null-path": "Photos/Progress/2025-11",
      "string-date": "Photos/Site Visits/2026-03",
    });
    // same-month (already correct) + garbage-date (unusable) are the two no-ops.
    expect(plan.skipped).toBe(2);
    expect(plan.byTarget["Photos/Site Visits/2026-04"]).toBe(1);
  });

  it("carries the pre-change path and the source taken_at for the UPDATE guard and the audit snapshot", () => {
    const plan = buildBackfillPlan([rows[0]]);
    expect(plan.willUpdate[0]).toEqual({
      id: "imported-april",
      from: "Photos/Site Visits/2026-09",
      to: "Photos/Site Visits/2026-04",
      takenAt: new Date("2026-04-07T15:30:00.000Z"),
    });
  });

  it("is idempotent — replanning its own output finds nothing to do", () => {
    const moved = buildBackfillPlan(rows).willUpdate;
    const afterRun: PhotoFileRow[] = moved.map((move) => {
      const original = rows.find((row) => row.id === move.id)!;
      return { ...original, folderPath: move.to };
    });
    expect(buildBackfillPlan(afterRun).willUpdate).toHaveLength(0);
  });

  it("defaults to dry-run and rejects contradictory mode flags", () => {
    expect(parseBackfillArgs(["node", "script"]).mode).toBe("dry-run");
    expect(parseBackfillArgs(["node", "script", "--commit"]).mode).toBe("commit");
    expect(() => parseBackfillArgs(["node", "script", "--commit", "--dry-run"])).toThrow();
  });
});

/** Fake client: the SELECT returns fixtures, everything else (SET/count/BEGIN/UPDATE) succeeds. */
function fakeClient(selectRows: Record<string, unknown>[]) {
  const queries: string[] = [];
  const client: QueryClient = {
    async query(text: string) {
      queries.push(text);
      if (/FROM files\b/i.test(text) && /taken_at IS NOT NULL/i.test(text) && /SELECT id/i.test(text)) {
        return { rows: selectRows, rowCount: selectRows.length };
      }
      if (/count\(\*\)/i.test(text)) return { rows: [{ count: selectRows.length }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
  };
  return { client, queries };
}

describe("photo folder-bucket backfill runner", () => {
  it("dry-run reads but never opens a transaction or UPDATEs", async () => {
    const { client, queries } = fakeClient([rows[0]]);
    const result = await runBackfillForSchema(client, "office_dallas", "dry-run");

    expect(result.plan.willUpdate).toHaveLength(1);
    expect(result.appliedMoves).toHaveLength(0);
    expect(queries.some((q) => /^\s*BEGIN/i.test(q))).toBe(false);
    expect(queries.some((q) => /^\s*UPDATE files/i.test(q))).toBe(false);
  });

  it("commit writes folder_path only, guarded by the exact path and taken_at it planned from", async () => {
    const { client, queries } = fakeClient([rows[0]]);
    const result = await runBackfillForSchema(client, "office_dallas", "commit");

    const update = queries.find((q) => /^\s*UPDATE files/i.test(q));
    expect(update).toBeDefined();
    // Metadata-only: r2_key is never in the SET list, because the stored object has no month segment.
    expect(update).toMatch(/SET folder_path = \$1, updated_at = now\(\)/);
    expect(update).not.toMatch(/r2_key/i);
    expect(update).toMatch(/folder_path IS NOT DISTINCT FROM \$3/i);
    expect(update).toMatch(/taken_at = \$4/i);
    expect(update).toMatch(/category = 'photo'/i);
    expect(queries.some((q) => /^\s*BEGIN/i.test(q))).toBe(true);
    expect(queries.some((q) => /^\s*COMMIT/i.test(q))).toBe(true);
    expect(result.appliedMoves.map((m) => m.id)).toEqual(["imported-april"]);
  });

  it("records as applied ONLY the rows the UPDATE actually changed (rowCount>0)", async () => {
    let updateCall = 0;
    const client: QueryClient = {
      async query(text: string) {
        if (/FROM files\b/i.test(text) && /SELECT id/i.test(text)) {
          return { rows: [rows[0], rows[3]], rowCount: 2 };
        }
        if (/^\s*UPDATE files/i.test(text)) {
          updateCall += 1;
          // First UPDATE no-ops (the row was re-filed by a concurrent edit → guard misses); second applies.
          return { rows: [], rowCount: updateCall === 1 ? 0 : 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    };
    const result = await runBackfillForSchema(client, "office_dallas", "commit");

    expect(result.plan.willUpdate).toHaveLength(2);
    expect(result.appliedMoves.map((m) => m.id)).toEqual(["null-path"]);
  });

  it("rolls back and rethrows when an UPDATE fails mid-transaction", async () => {
    const queries: string[] = [];
    const client: QueryClient = {
      async query(text: string) {
        queries.push(text);
        if (/FROM files\b/i.test(text) && /SELECT id/i.test(text)) return { rows: [rows[0]], rowCount: 1 };
        if (/^\s*UPDATE files/i.test(text)) throw new Error("deadlock detected");
        return { rows: [], rowCount: 0 };
      },
    };

    await expect(runBackfillForSchema(client, "office_dallas", "commit")).rejects.toThrow("deadlock detected");
    expect(queries.some((q) => /^\s*ROLLBACK/i.test(q))).toBe(true);
    expect(queries.some((q) => /^\s*COMMIT/i.test(q))).toBe(false);
  });

  it("refuses a schema name that isn't a discovered office schema", async () => {
    const { client } = fakeClient([]);
    await expect(runBackfillForSchema(client, 'public"; DROP TABLE files; --', "dry-run"))
      .rejects.toThrow(/Unsafe schema name/);
  });
});
