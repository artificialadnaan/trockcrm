// REAL-SQL proof that the OTHER assignment writer maintains `tasks.assigned_at`.
//
// `assigned_at` is only worth anything if EVERY path that moves `assigned_to` stamps it. The login
// modal reads it to decide whether an acknowledgement still answers the current assignment, so a
// transfer that leaves the stamp behind is silently invisible: the merge target keeps whatever they
// acknowledged during some earlier assignment, and if they happen to be the task's creator the row also
// reads as one they wrote for themselves. Either way, work that has just landed on them says nothing.
//
// updateTask is the path everybody thinks of. This is the one nobody does — a script, run by hand
// during user reconciliation, that transfers every open record from a departing user to a survivor.
// EXECUTED rather than grepped: asserting the SQL text contains "assigned_at" would pass against a
// statement that never runs, or one whose WHERE clause matches nothing.
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";

const { reassignOwnerRecords } = await import("../../../scripts/reconcileUsers.js");

const LEAVER = "11111111-1111-1111-1111-111111111111";
const SURVIVOR = "22222222-2222-2222-2222-222222222222";
/** Years back, so "the stamp moved to now()" cannot pass by coincidence. */
const SEEDED_AT = "2019-06-07 08:09:10+00";

let pg: PGlite;
const asClient = () => pg as unknown as Parameters<typeof reassignOwnerRecords>[0];

beforeEach(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE public.offices (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slug text NOT NULL, is_active boolean NOT NULL DEFAULT true);
    INSERT INTO public.offices (slug) VALUES ('dallas');

    CREATE SCHEMA office_dallas;
    CREATE TABLE office_dallas.deals (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), deal_number text,
      assigned_rep_id uuid, is_active boolean NOT NULL DEFAULT true,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE office_dallas.leads (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text,
      assigned_rep_id uuid, is_active boolean NOT NULL DEFAULT true,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE office_dallas.tasks (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title varchar(500) NOT NULL,
      status varchar(20) NOT NULL DEFAULT 'pending',
      assigned_to uuid,
      created_by uuid,
      last_assigned_by uuid,
      assigned_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    INSERT INTO office_dallas.tasks (title, assigned_to, assigned_at, updated_at)
      VALUES ('inherited work', '${LEAVER}', '${SEEDED_AT}', '${SEEDED_AT}');
    INSERT INTO office_dallas.tasks (title, assigned_to, assigned_at, updated_at)
      VALUES ('somebody else''s work', '${SURVIVOR}', '${SEEDED_AT}', '${SEEDED_AT}');
  `);
});

afterAll(async () => {
  await pg?.close();
});

async function taskRow(title: string) {
  const result = await pg.query<{ assigned_to: string; assigned_at: string }>(
    `SELECT assigned_to, assigned_at::text FROM office_dallas.tasks WHERE title = $1`,
    [title]
  );
  return result.rows[0];
}

describe("user reconciliation stamps the assignment it transfers", () => {
  it("moves assigned_at with assigned_to", async () => {
    await reassignOwnerRecords(asClient(), LEAVER, SURVIVOR, "leaver@trockgc.com", "3", []);

    const row = await taskRow("inherited work");
    expect(row?.assigned_to).toBe(SURVIVOR);
    expect(row?.assigned_at, "the transfer left the assignment dated 2019").not.toContain("2019-06-07");
  });

  // The stamp is not a blanket "touch everything": a row this transfer did not move must keep its
  // assignment date, or every merge would invalidate the acknowledgements of people it never concerned.
  it("leaves a task it did not transfer completely alone", async () => {
    await reassignOwnerRecords(asClient(), LEAVER, SURVIVOR, "leaver@trockgc.com", "3", []);

    const row = await taskRow("somebody else's work");
    expect(row?.assigned_to).toBe(SURVIVOR);
    expect(row?.assigned_at).toContain("2019-06-07");
  });

  it("still records the transfer in the audit rows", async () => {
    const auditRows: unknown[] = [];
    await reassignOwnerRecords(asClient(), LEAVER, SURVIVOR, "leaver@trockgc.com", "3", auditRows as never);

    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({ action: "reassign_task", before: LEAVER, after: SURVIVOR });
  });
});
