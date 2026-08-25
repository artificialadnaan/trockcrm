// REAL-SQL (PGlite) proof for the automated-vs-manual task filter.
//
// The feature is a filter, not a deletion: nothing is hidden by default, and every automated task stays
// exactly where it was. What these tests hold down is that the filter and the numbers next to it agree.
//
// The count reconciliation is the point of the suite. The tab labels carry counts from /tasks/counts
// while the rows come from five separately-paginated bucket queries, so the two can disagree without
// anything looking broken. getTaskCounts' existing date buckets scope to
// status IN ('pending','in_progress','waiting_on','blocked') and thereby EXCLUDE 'scheduled' -- which
// the list's Later bucket explicitly includes. A scheduled task therefore appears in the list and in no
// count. The per-source totals here are built from one shared open-work predicate instead, and the
// reconciliation test below sums the actual bucket queries to prove the two sides match.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { tasks } from "@trock-crm/shared/schema";
import {
  getTasks,
  getTaskById,
  getTaskCounts,
  getProjectTasks,
  createTask,
  isTaskSource,
  OPEN_WORK_STATUSES,
} from "../../../src/modules/tasks/service.js";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";

const uid = (n: string) => `00000000-0000-0000-0000-${n.padStart(12, "0")}`;

const T = {
  manualOverdue: uid("1"),
  manualToday: uid("2"),
  autoOverdue: uid("3"),
  autoToday: uid("4"),
  autoLater: uid("5"),
  // status 'scheduled': in the Later bucket, and the row the old count predicate dropped on the floor.
  autoScheduled: uid("6"),
  manualCompleted: uid("7"),
  // seeded demo row -- must not appear in any list, projection or count
  manualTestData: uid("8"),
} as const;

const USER = uid("a1");
const DEAL = uid("d1");

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
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });

  await pg.exec(`
    CREATE TABLE users (id uuid PRIMARY KEY, display_name text);
    CREATE TABLE deals (
      id uuid PRIMARY KEY, name text, is_change_order boolean NOT NULL DEFAULT false,
      deal_number text, project_number text, is_active boolean NOT NULL DEFAULT true,
      assigned_rep_id uuid, procore_project_id text
    );

    INSERT INTO users (id, display_name) VALUES ('${USER}','Alpha');
    INSERT INTO deals (id, name, procore_project_id, assigned_rep_id) VALUES ('${DEAL}','Roof job','pc-1','${USER}');

    INSERT INTO tasks (id, title, type, priority, status, assigned_to, deal_id, source, due_date, scheduled_for, completed_at, is_test_data) VALUES
      ('${T.manualOverdue}', 'M overdue','manual','normal','pending',  '${USER}','${DEAL}','manual',    '${addDays(today, -2)}', NULL, NULL, false),
      ('${T.manualToday}',   'M today',  'manual','normal','pending',  '${USER}','${DEAL}','manual',    '${today}',              NULL, NULL, false),
      ('${T.autoOverdue}',   'A overdue','system','normal','pending',  '${USER}','${DEAL}','automated', '${addDays(today, -3)}', NULL, NULL, false),
      ('${T.autoToday}',     'A today',  'system','normal','pending',  '${USER}','${DEAL}','automated', '${today}',              NULL, NULL, false),
      ('${T.autoLater}',     'A later',  'system','normal','pending',  '${USER}','${DEAL}','automated', '${addDays(today, 30)}', NULL, NULL, false),
      ('${T.autoScheduled}', 'A sched',  'system','normal','scheduled','${USER}','${DEAL}','automated', NULL, NOW() + INTERVAL '9 days', NULL, false),
      ('${T.manualCompleted}','M done',  'manual','normal','completed','${USER}','${DEAL}','manual',    NULL, NULL, NOW() - INTERVAL '1 days', false),
      ('${T.manualTestData}','M demo',   'manual','normal','pending',  '${USER}','${DEAL}','manual',    '${today}',              NULL, NULL, true);
  `);
  tdb = drizzle(pg);
}, 30000);

afterAll(async () => {
  await pg?.close?.();
});

const ids = (result: { tasks: Array<{ id: string }> }) => result.tasks.map((t) => t.id).sort();

describe("tasks source filter", () => {
  it("returns only manual rows when source=manual", async () => {
    const result = await getTasks(tdb, { source: "manual" }, "director", "dir");
    expect(ids(result)).toEqual([T.manualOverdue, T.manualToday, T.manualCompleted].sort());
  });

  it("returns only automated rows when source=automated", async () => {
    const result = await getTasks(tdb, { source: "automated" }, "director", "dir");
    expect(ids(result)).toEqual(
      [T.autoOverdue, T.autoToday, T.autoLater, T.autoScheduled].sort()
    );
  });

  // The ask was a filter, not a default view change: omitting the param must keep every existing
  // caller's result set byte-identical to what it was before this column existed.
  it("returns BOTH when source is omitted", async () => {
    const result = await getTasks(tdb, {}, "director", "dir");
    expect(ids(result)).toEqual(
      [
        T.manualOverdue, T.manualToday, T.manualCompleted,
        T.autoOverdue, T.autoToday, T.autoLater, T.autoScheduled,
      ].sort()
    );
  });

  it("combines with a section filter rather than replacing it", async () => {
    const result = await getTasks(tdb, { section: "overdue", source: "automated" }, "director", "dir");
    expect(ids(result)).toEqual([T.autoOverdue]);
  });

  it("allowlists the param — an unknown value is rejected, never passed to SQL", () => {
    expect(isTaskSource("manual")).toBe(true);
    expect(isTaskSource("automated")).toBe(true);
    for (const bad of ["", "MANUAL", "both", "all", "'; DROP TABLE tasks; --", null, undefined, 7]) {
      expect(isTaskSource(bad), String(bad)).toBe(false);
    }
  });
});

describe("tasks source in the projections", () => {
  // THREE projections, not two. getProjectTasks (the Procore project task surface) has the same
  // 27-column shape and is easy to miss precisely because it is not the tasks page.
  it("getTasks returns source", async () => {
    const result = await getTasks(tdb, { section: "overdue" }, "director", "dir");
    const row = result.tasks.find((t: { id: string }) => t.id === T.autoOverdue);
    expect(row?.source).toBe("automated");
  });

  it("getTaskById returns source", async () => {
    const row = await getTaskById(tdb, T.manualToday, "director", "dir");
    expect(row?.source).toBe("manual");
  });

  it("getProjectTasks returns source", async () => {
    const rows = await getProjectTasks(tdb, DEAL, "director", "dir");
    const row = rows.find((t: { id: string }) => t.id === T.autoLater);
    expect(row?.source).toBe("automated");
  });
});

describe("tasks per-source counts", () => {
  // The denominator: open work only, from ONE predicate shared with the list. 'scheduled' is in it
  // because the Later bucket shows scheduled rows -- excluding it is what made a scheduled task
  // appear in the list and in no count.
  it("counts open work per source, including scheduled rows", async () => {
    const counts = await getTaskCounts(tdb, "director", "dir", null);

    expect(OPEN_WORK_STATUSES).toContain("scheduled");
    expect(counts.bySource.manual).toBe(2); // overdue + today (completed is not open work)
    expect(counts.bySource.automated).toBe(4); // overdue + today + later + SCHEDULED
    expect(counts.bySource.all).toBe(6);
  });

  // The reconciliation this suite exists for: the tab number and the rows under it are two different
  // queries, and a filtered list that disagrees with its own label is the failure people actually hit.
  // Summing the real bucket queries -- not re-deriving the count -- is what makes this a proof.
  it("per-source totals equal the rows the open buckets actually return", async () => {
    for (const source of ["manual", "automated"] as const) {
      const buckets = await Promise.all(
        (["overdue", "today", "this_week", "later"] as const).map((section) =>
          getTasks(tdb, { section, source, limit: 500 }, "director", "dir")
        )
      );
      const listed = new Set(buckets.flatMap((b) => b.tasks.map((t: { id: string }) => t.id)));
      const counts = await getTaskCounts(tdb, "director", "dir", null);

      expect(listed.size, `${source}: buckets vs count`).toBe(counts.bySource[source]);
    }
  });

  it("keeps the existing date-bucket counts working", async () => {
    const counts = await getTaskCounts(tdb, "director", "dir", null);
    expect(counts.overdue).toBe(2);
    expect(counts.today).toBe(2);
  });

  // The summary cards and the buckets under them are two different queries against the same filter.
  // With the source reaching only the buckets, picking Manual left an Overdue card counting automated
  // work sitting directly above an Overdue bucket that had filtered it out -- the card, its drill and
  // its aggregate must move together.
  it("scopes the date-bucket counts to the selected source", async () => {
    const manual = await getTaskCounts(tdb, "director", "dir", null, "manual");
    expect(manual.overdue).toBe(1);
    expect(manual.today).toBe(1);

    const automated = await getTaskCounts(tdb, "director", "dir", null, "automated");
    expect(automated.overdue).toBe(1);
    expect(automated.today).toBe(1);
  });

  // ...and the cards must equal the rows the matching bucket actually returns, not merely differ.
  it("each scoped card equals the rows its bucket returns", async () => {
    for (const source of ["manual", "automated"] as const) {
      const counts = await getTaskCounts(tdb, "director", "dir", null, source);
      for (const section of ["overdue", "today"] as const) {
        const bucket = await getTasks(tdb, { section, source, limit: 500 }, "director", "dir");
        expect(bucket.tasks.length, `${source}/${section}`).toBe(counts[section]);
      }
    }
  });

  // The tab labels are the one thing that must NOT be scoped: All/Manual/Automated each need their own
  // number regardless of which tab is selected, or selecting Manual would zero the Automated label.
  it("leaves the per-source tab totals unscoped", async () => {
    const unscoped = await getTaskCounts(tdb, "director", "dir", null);
    const scoped = await getTaskCounts(tdb, "director", "dir", null, "manual");

    expect(scoped.bySource).toEqual(unscoped.bySource);
    expect(scoped.bySource.automated).toBe(4);
  });
});

describe("seeded demo tasks stay out of the real numbers", () => {
  // The demo row is due today and assigned to a real user, so every surface below would otherwise
  // show it. Applied to the counts as well as the lists, or the two would disagree by exactly one row.
  it("is excluded from getTasks", async () => {
    const result = await getTasks(tdb, {}, "director", "dir");
    expect(result.tasks.map((t: { id: string }) => t.id)).not.toContain(T.manualTestData);
  });

  it("is excluded from getTaskById", async () => {
    expect(await getTaskById(tdb, T.manualTestData, "director", "dir")).toBeNull();
  });

  it("is excluded from getProjectTasks", async () => {
    const rows = await getProjectTasks(tdb, DEAL, "director", "dir");
    expect(rows.map((t: { id: string }) => t.id)).not.toContain(T.manualTestData);
  });

  it("is excluded from the counts, so lists and counts agree", async () => {
    const counts = await getTaskCounts(tdb, "director", "dir", null);
    // 2 real manual open rows; the demo row is a third manual row due today and must not be counted.
    expect(counts.bySource.manual).toBe(2);
    expect(counts.today).toBe(2);
  });
});

describe("createTask records who made the task", () => {
  // Set INSIDE createTask, never at a route. Its three callers are all a person filling in a form --
  // the tasks page, the Procore project task form, and accepting an AI suggestion -- and routing the
  // decision at one route would send the other two to the DEFAULT and into the wrong tab.
  it("writes 'manual' for a task a person created", async () => {
    const created = await createTask(tdb, {
      title: "Called the client",
      type: "manual",
      assignedTo: USER,
      createdBy: USER,
    });

    expect(created.source).toBe("manual");
    const reread = await getTaskById(tdb, created.id, "director", "dir");
    expect(reread?.source).toBe("manual");
  });
});
