import { describe, expect, it, vi } from "vitest";
// Types are safe to import statically; the VALUES come through the awaited import below so the pg mock
// is installed before the module builds its client.
import type { PhotoFileRow, QueryClient } from "./backfill-photo-folder-buckets.js";
// The real constants the guard has to protect, imported rather than restated as string literals: if a
// module renames its folder convention, this suite must fail rather than keep testing the old spelling.
import {
  GLASSES_WALKTHROUGH_FOLDER_PATH,
  GLASSES_WALKTHROUGH_SUBCATEGORY,
} from "../server/src/modules/walkthrough-capture/glasses-walkthrough-service.js";

const pgMocks = vi.hoisted(() => ({ query: vi.fn(), connect: vi.fn(), end: vi.fn() }));

// main() constructs its own pg.Client, so the office-accounting assertions at the bottom need a fake one.
// The planner/runner suites above are pure and unaffected by this.
vi.mock("pg", () => ({
  default: {
    Client: class {
      connect = pgMocks.connect;
      end = pgMocks.end;
      query = pgMocks.query;
    },
  },
}));

const {
  buildBackfillPlan,
  followsPresignConvention,
  main,
  parseBackfillArgs,
  runBackfillForSchema,
} = await import("./backfill-photo-folder-buckets.js");

// Pure planner + runner coverage. The planner answers two questions in order, and BOTH must be a clear
// yes before a row is written: "is this row's stored path the presign convention's own shape?" and only
// then "does its month disagree with the row's taken_at?".

const rows: PhotoFileRow[] = [
  // 1. THE BUG: an ordinary presign-flow photo taken in April, presigned (and filed) in September.
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
  // 4. CompanyCam import (companycam/service.ts:445). It writes Photos/CompanyCam/<captured_at month> AND
  //    taken_at = captured_at, so it has the convention's shape but derives to its own current path.
  {
    id: "companycam",
    subcategory: "CompanyCam",
    folderPath: "Photos/CompanyCam/2026-04",
    takenAt: new Date("2026-04-11T09:00:00.000Z"),
  },
  // 5. Glasses walkthrough still — category='photo' with taken_at set, so it MATCHES this backfill's
  //    WHERE clause, but its folder is a deliberate flat grouping. Must never be dragged into a bucket.
  {
    id: "glasses-walkthrough",
    subcategory: GLASSES_WALKTHROUGH_SUBCATEGORY,
    folderPath: GLASSES_WALKTHROUGH_FOLDER_PATH,
    takenAt: new Date("2026-04-02T14:00:00.000Z"),
  },
  // 6. A bucketed path under a FOREIGN prefix — proves the guard compares the whole prefix, not merely
  //    "does it end in YYYY-MM". A future module that buckets its own folder is protected by this.
  {
    id: "foreign-bucket",
    subcategory: "Site Visits",
    folderPath: `${GLASSES_WALKTHROUGH_FOLDER_PATH}/2026-04`,
    takenAt: new Date("2026-07-01T00:00:00.000Z"),
  },
  // 7. taken_at arriving as a driver string rather than a Date.
  {
    id: "string-date",
    subcategory: "Site Visits",
    folderPath: "Photos/Site Visits/2026-09",
    takenAt: "2026-03-15T12:00:00.000Z",
  },
  // 8. Unusable taken_at — no correct bucket exists to guess, and buildFolderPath would throw on it.
  {
    id: "garbage-date",
    subcategory: "Site Visits",
    folderPath: "Photos/Site Visits/2026-09",
    takenAt: "not-a-date",
  },
  // 9. Legacy row with no folder_path at all. NULL is not the convention's shape, so it is not this
  //    script's to invent one for.
  {
    id: "null-path",
    subcategory: "Progress",
    folderPath: null,
    takenAt: new Date("2025-11-30T23:00:00.000Z"),
  },
];

const byId = (id: string) => rows.find((row) => row.id === id)!;

describe("presign-convention shape guard", () => {
  it("leaves the glasses-walkthrough grouping alone — it has no month bucket to rewrite", () => {
    expect(followsPresignConvention(GLASSES_WALKTHROUGH_FOLDER_PATH, GLASSES_WALKTHROUGH_SUBCATEGORY))
      .toBe(false);
  });

  it("rejects a bucketed path whose prefix isn't the one this row's category/subcategory derives", () => {
    expect(followsPresignConvention(`${GLASSES_WALKTHROUGH_FOLDER_PATH}/2026-04`, "Site Visits")).toBe(false);
    // Right prefix for a DIFFERENT subcategory is still the wrong prefix for this row.
    expect(followsPresignConvention("Photos/Site Visits/2026-04", "Progress")).toBe(false);
    expect(followsPresignConvention(null, "Site Visits")).toBe(false);
    expect(followsPresignConvention("Photos/Site Visits", "Site Visits")).toBe(false);
  });

  it("accepts exactly what the presign path produces, with and without a subcategory", () => {
    expect(followsPresignConvention("Photos/Site Visits/2026-04", "Site Visits")).toBe(true);
    expect(followsPresignConvention("Photos/CompanyCam/2026-04", "CompanyCam")).toBe(true);
    expect(followsPresignConvention("Photos/2026-04", null)).toBe(true);
  });
});

describe("photo folder-bucket backfill planner", () => {
  it("re-files only presign-convention photos whose bucket disagrees with their capture date", () => {
    const plan = buildBackfillPlan(rows);

    expect(plan.willUpdate.map((m) => m.id)).toEqual([
      "imported-april",
      "no-subcategory",
      "string-date",
    ]);
    expect(Object.fromEntries(plan.willUpdate.map((m) => [m.id, m.to]))).toEqual({
      "imported-april": "Photos/Site Visits/2026-04",
      "no-subcategory": "Photos/2026-01",
      "string-date": "Photos/Site Visits/2026-03",
    });
    // same-month + companycam (both already correct) + garbage-date (unusable).
    expect(plan.skipped).toBe(3);
    // glasses-walkthrough + foreign-bucket + null-path — not this script's paths to touch.
    expect(plan.customPath).toBe(3);
  });

  it("never plans a move for a glasses-walkthrough still", () => {
    const plan = buildBackfillPlan([byId("glasses-walkthrough")]);
    expect(plan.willUpdate).toHaveLength(0);
    expect(plan.customPath).toBe(1);
    expect(plan.skipped).toBe(0);
  });

  it("plans ZERO rows for a CompanyCam import — its folder month already IS its captured_at month", () => {
    const plan = buildBackfillPlan([byId("companycam")]);
    expect(plan.willUpdate).toHaveLength(0);
    // Explicitly a no-op by DERIVATION, not by exclusion: it passes the shape guard and is then found equal.
    expect(followsPresignConvention(byId("companycam").folderPath, byId("companycam").subcategory)).toBe(true);
    expect(plan.skipped).toBe(1);
    expect(plan.customPath).toBe(0);
  });

  it("rewrites an ordinary presign-flow photo whose taken_at month differs from its upload month", () => {
    const plan = buildBackfillPlan([byId("imported-april")]);
    expect(plan.willUpdate).toEqual([{
      id: "imported-april",
      from: "Photos/Site Visits/2026-09",
      to: "Photos/Site Visits/2026-04",
      takenAt: new Date("2026-04-07T15:30:00.000Z"),
    }]);
    expect(plan.byTarget["Photos/Site Visits/2026-04"]).toBe(1);
  });

  it("is idempotent — replanning its own output finds nothing to do", () => {
    const moved = buildBackfillPlan(rows).willUpdate;
    const afterRun: PhotoFileRow[] = moved.map((move) => ({ ...byId(move.id), folderPath: move.to }));
    expect(buildBackfillPlan(afterRun).willUpdate).toHaveLength(0);
  });

  it("defaults to dry-run and rejects contradictory mode flags", () => {
    expect(parseBackfillArgs(["node", "script"]).mode).toBe("dry-run");
    expect(parseBackfillArgs(["node", "script", "--commit"]).mode).toBe("commit");
    expect(() => parseBackfillArgs(["node", "script", "--commit", "--dry-run"])).toThrow();
  });
});

/** Fake client: the SELECT returns fixtures, everything else (SET/count/BEGIN/UPDATE) succeeds. */
function fakeClient(selectRows: PhotoFileRow[]) {
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
    const { client, queries } = fakeClient([byId("imported-april")]);
    const result = await runBackfillForSchema(client, "office_dallas", "dry-run");

    expect(result.plan.willUpdate).toHaveLength(1);
    expect(result.appliedMoves).toHaveLength(0);
    expect(queries.some((q) => /^\s*BEGIN/i.test(q))).toBe(false);
    expect(queries.some((q) => /^\s*UPDATE files/i.test(q))).toBe(false);
  });

  it("commit writes folder_path only, guarded by the exact path and taken_at it planned from", async () => {
    const { client, queries } = fakeClient([byId("imported-april")]);
    const result = await runBackfillForSchema(client, "office_dallas", "commit");

    const update = queries.find((q) => /^\s*UPDATE files/i.test(q));
    expect(update).toBeDefined();
    // Metadata-only: r2_key is never in the SET list, because the stored object has no month segment.
    expect(update).toMatch(/SET folder_path = \$1, updated_at = now\(\)/);
    expect(update).not.toMatch(/r2_key/i);
    // Re-asserting the exact pre-change path is also the write-time re-check of the shape guard.
    expect(update).toMatch(/folder_path = \$3/i);
    expect(update).toMatch(/taken_at = \$4/i);
    expect(update).toMatch(/category = 'photo'/i);
    expect(queries.some((q) => /^\s*BEGIN/i.test(q))).toBe(true);
    expect(queries.some((q) => /^\s*COMMIT/i.test(q))).toBe(true);
    expect(result.appliedMoves.map((m) => m.id)).toEqual(["imported-april"]);
  });

  it("never issues an UPDATE for an office whose photos all sit on custom paths", async () => {
    const { client, queries } = fakeClient([byId("glasses-walkthrough"), byId("null-path")]);
    const result = await runBackfillForSchema(client, "office_dallas", "commit");

    expect(result.plan.willUpdate).toHaveLength(0);
    expect(result.appliedMoves).toHaveLength(0);
    expect(queries.some((q) => /^\s*UPDATE files/i.test(q))).toBe(false);
    expect(queries.some((q) => /^\s*BEGIN/i.test(q))).toBe(false);
  });

  it("records as applied ONLY the rows the UPDATE actually changed (rowCount>0)", async () => {
    let updateCall = 0;
    const client: QueryClient = {
      async query(text: string) {
        if (/FROM files\b/i.test(text) && /SELECT id/i.test(text)) {
          return { rows: [byId("imported-april"), byId("no-subcategory")], rowCount: 2 };
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
    expect(result.appliedMoves.map((m) => m.id)).toEqual(["no-subcategory"]);
  });

  it("rolls back and rethrows when an UPDATE fails mid-transaction", async () => {
    const queries: string[] = [];
    const client: QueryClient = {
      async query(text: string) {
        queries.push(text);
        if (/FROM files\b/i.test(text) && /SELECT id/i.test(text)) {
          return { rows: [byId("imported-april")], rowCount: 1 };
        }
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

describe("office accounting across the whole run", () => {
  /**
   * Two compatible offices; office_broken throws once the run reaches its rows. A half-run that reports
   * success is the failure mode here — nobody re-runs a green backfill — so the run must both refuse to
   * count the broken office as processed and exit non-zero.
   */
  function programClient(failFor: string | null) {
    const logs: string[] = [];
    let currentSchema = "";
    pgMocks.connect.mockReset().mockResolvedValue(undefined);
    pgMocks.end.mockReset().mockResolvedValue(undefined);
    pgMocks.query.mockReset().mockImplementation(async (text: string) => {
      if (/pg_namespace/i.test(text)) {
        return { rows: [{ nspname: "office_dallas" }, { nspname: "office_broken" }], rowCount: 2 };
      }
      if (/information_schema\.columns/i.test(text)) {
        // Both offices are schema-COMPATIBLE — this test is about runtime failure, not drift.
        return {
          rows: [
            "id", "category", "subcategory", "folder_path", "taken_at", "is_active", "updated_at",
          ].map((column_name) => ({ column_name })),
          rowCount: 7,
        };
      }
      const setSchema = /SET search_path TO "([^"]+)"/.exec(text);
      if (setSchema) {
        currentSchema = setSchema[1];
        return { rows: [], rowCount: 0 };
      }
      if (currentSchema === failFor) throw new Error("relation \"files\" is being rebuilt");
      if (/count\(\*\)/i.test(text)) return { rows: [{ count: 1 }], rowCount: 1 };
      if (/SELECT id/i.test(text)) return { rows: [byId("imported-april")], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    return logs;
  }

  it("excludes a failed office from the processed count and exits non-zero", async () => {
    programClient("office_broken");
    process.env.DATABASE_URL = "postgres://user@localhost:5432/db";
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await expect(main(["node", "script"])).rejects.toThrow(/office_broken/);
      const summary = log.mock.calls.map((c) => String(c[0])).find((line) => /would update/.test(line));
      // 1 of 2 — the office that threw is not claimed as covered.
      expect(summary).toMatch(/across 1 of 2 office\(s\)/);
      expect(error.mock.calls.map((c) => String(c[0])).some((line) => /office_broken === FAILED/.test(line)))
        .toBe(true);
      // The client is closed even on the failure path.
      expect(pgMocks.end).toHaveBeenCalled();
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  it("reports every office and resolves when none fail", async () => {
    programClient(null);
    process.env.DATABASE_URL = "postgres://user@localhost:5432/db";
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      await expect(main(["node", "script"])).resolves.toBeUndefined();
      const summary = log.mock.calls.map((c) => String(c[0])).find((line) => /would update/.test(line));
      expect(summary).toMatch(/across 2 of 2 office\(s\)/);
    } finally {
      log.mockRestore();
    }
  });
});
