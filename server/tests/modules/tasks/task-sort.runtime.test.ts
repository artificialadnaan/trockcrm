import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { tasks } from "@trock-crm/shared/schema";
import { getTasks, getTaskCounts, isTaskSection } from "../../../src/modules/tasks/service.js";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";

/**
 * REAL-SQL (PGlite) proof for the Tasks per-bucket server-side sort (follow-up #769).
 *
 * Each bucket sorts its FULL set in the database via buildTaskSortOrder (sortBy/sortDir), not an
 * in-memory re-sort of a page. These tests run getTasks against a real planner to prove:
 *   - every sort key orders correctly, NULLS LAST, with a stable id tiebreak;
 *   - the new `this_week` / `later` sections are membership-identical to the union the page used
 *     to assemble client-side (upcoming-split + the separate scheduled fetch), so only ORDER
 *     changes — counts still reconcile;
 *   - getTaskCounts.completedThisWeek is a full-set server aggregate (decoupled from the sortable,
 *     limited Completed bucket) so the summary card cannot drift when that bucket is re-sorted.
 *
 * tasks is created from the real Drizzle definition (prod-accurate types/enums); users and deals are
 * minimal islands carrying only the columns getTasks reads (assignee-name subquery + the deals join).
 */
const uid = (n: string) => `00000000-0000-0000-0000-${n.padStart(12, "0")}`;

const T = {
  // this_week bucket (open, due within (today, today+7])
  w1: uid("1"), // due +1, high,   Bravo,   created 3d ago
  w2: uid("2"), // due +2, urgent, Alpha,   created 2d ago
  w3: uid("3"), // due +3, low,    Charlie, created 1d ago
  w4: uid("4"), // due +2, normal, Alpha,   created 5d ago  (ties w2 on due_date)
  // later bucket (open far-future / undated, plus scheduled)
  l1: uid("5"), // due +10 (far future), normal, Alpha,  pending
  l2: uid("6"), // due NULL + scheduled_for NULL (fully undated), high, Bravo, pending
  s1: uid("7"), // scheduled status, due NULL, scheduled_for +20d (latest), Alpha
  s2: uid("10"), // scheduled status, due NULL, scheduled_for +2d (soonest of all later rows), Alpha
  // other buckets
  o1: uid("8"), // overdue (due -2), pending
  d1: uid("9"), // today (due today), pending
  // completed/dismissed (for the count)
  c1: uid("11"), // completed, resolved 1d ago  -> counts this week
  c2: uid("12"), // completed, resolved 10d ago -> all-time only
  c3: uid("13"), // dismissed, resolved 2d ago  -> counts this week
};

const U_ALPHA = uid("a1");
const U_BRAVO = uid("b2");
const U_CHARLIE = uid("c3");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;

function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`SET TimeZone='UTC';`);
  await pg.exec(tenantSchemaSql("public", [tasks]));
  // Office-timezone "today" matches the service's own CT bucketing (both use this conversion).
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });

  await pg.exec(`
    CREATE TABLE users (id uuid PRIMARY KEY, display_name text);
    CREATE TABLE deals (id uuid PRIMARY KEY, name text, deal_number text, project_number text);

    INSERT INTO users (id, display_name) VALUES
      ('${U_ALPHA}','Alpha'), ('${U_BRAVO}','Bravo'), ('${U_CHARLIE}','Charlie');

    INSERT INTO tasks (id, title, type, priority, status, assigned_to, due_date, scheduled_for, completed_at, created_at) VALUES
      ('${T.w1}','W1','manual','high',  'pending','${U_BRAVO}',  '${addDays(today, 1)}', NULL, NULL, NOW() - INTERVAL '3 days'),
      ('${T.w2}','W2','manual','urgent','pending','${U_ALPHA}',  '${addDays(today, 2)}', NULL, NULL, NOW() - INTERVAL '2 days'),
      ('${T.w3}','W3','manual','low',   'pending','${U_CHARLIE}','${addDays(today, 3)}', NULL, NULL, NOW() - INTERVAL '1 days'),
      ('${T.w4}','W4','manual','normal','pending','${U_ALPHA}',  '${addDays(today, 2)}', NULL, NULL, NOW() - INTERVAL '5 days'),
      ('${T.l1}','L1','manual','normal','pending','${U_ALPHA}',  '${addDays(today, 10)}',NULL, NULL, NOW() - INTERVAL '4 days'),
      ('${T.l2}','L2','manual','high',  'pending','${U_BRAVO}',  NULL,                   NULL, NULL, NOW() - INTERVAL '4 days'),
      ('${T.s1}','S1','manual','normal','scheduled','${U_ALPHA}',NULL, NOW() + INTERVAL '20 days', NULL, NOW() - INTERVAL '4 days'),
      ('${T.s2}','S2','manual','normal','scheduled','${U_ALPHA}',NULL, NOW() + INTERVAL '2 days',  NULL, NOW() - INTERVAL '4 days'),
      ('${T.o1}','O1','manual','normal','pending','${U_ALPHA}',  '${addDays(today, -2)}',NULL, NULL, NOW() - INTERVAL '4 days'),
      ('${T.d1}','D1','manual','normal','pending','${U_ALPHA}',  '${today}',             NULL, NULL, NOW() - INTERVAL '4 days'),
      ('${T.c1}','C1','manual','normal','completed','${U_ALPHA}',NULL, NULL, NOW() - INTERVAL '1 days',  NOW() - INTERVAL '8 days'),
      ('${T.c2}','C2','manual','normal','completed','${U_ALPHA}',NULL, NULL, NOW() - INTERVAL '10 days', NOW() - INTERVAL '12 days'),
      ('${T.c3}','C3','manual','normal','dismissed','${U_ALPHA}',NULL, NULL, NOW() - INTERVAL '2 days',  NOW() - INTERVAL '9 days');
  `);
  tdb = drizzle(pg);
}, 30000); // PGlite cold-start can exceed the default 10s under parallel runtime suites

afterAll(async () => {
  await pg?.close?.();
});

const ids = (result: { tasks: Array<{ id: string }> }) => result.tasks.map((t) => t.id);

describe("tasks per-bucket sort — server-side ordering over the full bucket", () => {
  it("due_date asc orders soonest-first with a stable id tiebreak", async () => {
    const result = await getTasks(tdb, { section: "this_week", sortBy: "due_date", sortDir: "asc" }, "director", "dir");
    // w1(+1), then w2 & w4 both (+2) broken by id asc (w2 < w4), then w3(+3)
    expect(ids(result)).toEqual([T.w1, T.w2, T.w4, T.w3]);
  });

  it("priority desc surfaces the most urgent first", async () => {
    const result = await getTasks(tdb, { section: "this_week", sortBy: "priority", sortDir: "desc" }, "director", "dir");
    expect(ids(result)).toEqual([T.w2, T.w1, T.w4, T.w3]); // urgent, high, normal, low
  });

  it("assignee asc sorts alphabetically with id tiebreak among equals", async () => {
    const result = await getTasks(tdb, { section: "this_week", sortBy: "assignee", sortDir: "asc" }, "director", "dir");
    // Alpha (w2, w4 by id), Bravo (w1), Charlie (w3)
    expect(ids(result)).toEqual([T.w2, T.w4, T.w1, T.w3]);
  });

  it("created_at desc orders newest-first", async () => {
    const result = await getTasks(tdb, { section: "this_week", sortBy: "created_at", sortDir: "desc" }, "director", "dir");
    expect(ids(result)).toEqual([T.w3, T.w2, T.w1, T.w4]); // 1d, 2d, 3d, 5d ago
  });

  it("Later default sorts by effective date (due_date ?? scheduled_for), interleaving scheduled, undated last", async () => {
    const result = await getTasks(tdb, { section: "later", sortBy: "due_date", sortDir: "asc" }, "director", "dir");
    // effective: s2 (+2d sched) < l1 (+10d due) < s1 (+20d sched) < l2 (no due/sched → NULLS LAST)
    expect(ids(result)).toEqual([T.s2, T.l1, T.s1, T.l2]);
  });

  it("Later effective-date desc keeps the fully-undated row last (NULLS LAST)", async () => {
    const result = await getTasks(tdb, { section: "later", sortBy: "due_date", sortDir: "desc" }, "director", "dir");
    expect(ids(result)).toEqual([T.s1, T.l1, T.s2, T.l2]);
  });

  it("a row limit on Later keeps the soonest SCHEDULED task (interleaved by date, not truncated under dated rows)", async () => {
    // The bug: with due_date NULLS LAST, >limit dated rows would push every scheduled task off the
    // page. Sorting by effective date keeps the soonest scheduled task even under a tight limit.
    const result = await getTasks(tdb, { section: "later", sortBy: "due_date", sortDir: "asc", limit: 1 }, "director", "dir");
    expect(ids(result)).toEqual([T.s2]); // s2 is a scheduled task and the soonest by effective date
  });

  it("completed_at desc orders the Completed bucket most-recently-resolved first", async () => {
    const result = await getTasks(tdb, { section: "completed", sortBy: "completed_at", sortDir: "desc" }, "director", "dir");
    expect(ids(result)).toEqual([T.c1, T.c3, T.c2]); // c1 (1d), c3 (2d), c2 (10d)
  });
});

describe("tasks section membership — sort changes ORDER only, never WHICH tasks (reconcile by construction)", () => {
  it("this_week = exactly the open tasks due within (today, today+7]", async () => {
    const result = await getTasks(tdb, { section: "this_week", sortBy: "due_date", sortDir: "asc" }, "director", "dir");
    expect(ids(result).sort()).toEqual([T.w1, T.w2, T.w3, T.w4].sort());
  });

  it("later = far-future/undated open work UNION scheduled (the old client-assembled union)", async () => {
    const result = await getTasks(tdb, { section: "later", sortBy: "due_date", sortDir: "asc" }, "director", "dir");
    expect(ids(result).sort()).toEqual([T.l1, T.l2, T.s1, T.s2].sort()); // includes scheduled tasks; excludes this_week
  });

  it("overdue and today buckets are unchanged by the restructure", async () => {
    const overdue = await getTasks(tdb, { section: "overdue", sortBy: "due_date", sortDir: "asc" }, "director", "dir");
    const today = await getTasks(tdb, { section: "today", sortBy: "due_date", sortDir: "asc" }, "director", "dir");
    expect(ids(overdue)).toEqual([T.o1]);
    expect(ids(today)).toEqual([T.d1]);
  });

  it("the four active buckets partition all open work with no overlap or loss", async () => {
    const sections = ["overdue", "today", "this_week", "later"] as const;
    const collected: string[] = [];
    for (const section of sections) {
      const r = await getTasks(tdb, { section, sortBy: "due_date", sortDir: "asc" }, "director", "dir");
      collected.push(...ids(r));
    }
    // No id appears twice across the active buckets…
    expect(new Set(collected).size).toBe(collected.length);
    // …and every open/scheduled task is covered exactly once (w1-4, l1-2, s1-2, o1, d1 = 10).
    expect(collected.sort()).toEqual(
      [T.w1, T.w2, T.w3, T.w4, T.l1, T.l2, T.s1, T.s2, T.o1, T.d1].sort()
    );
  });
});

describe("isTaskSection — section query-param allowlist", () => {
  it("accepts the known sections and rejects unknown / wrong-type values", () => {
    for (const s of ["overdue", "today", "this_week", "later", "upcoming", "completed"]) {
      expect(isTaskSection(s)).toBe(true);
    }
    for (const s of ["", "garbage", "LATER", "Later", undefined, null, 5, {}]) {
      expect(isTaskSection(s)).toBe(false);
    }
  });
});

describe("getTaskCounts.completedThisWeek — sort-independent summary-card source", () => {
  it("counts completed+dismissed resolved within the last 7 days (full set, not page-limited)", async () => {
    const counts = await getTaskCounts(tdb, "director", "dir", null);
    expect(counts.completedThisWeek).toBe(2); // c1 (completed 1d) + c3 (dismissed 2d); c2 (10d) excluded
    expect(counts.completed).toBe(2); // all-time completed = c1 + c2 (status='completed'); c3 is dismissed
  });
});
