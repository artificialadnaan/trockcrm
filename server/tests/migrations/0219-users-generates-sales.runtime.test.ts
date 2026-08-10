// Executes Migration 0219 FROM DISK against a real Postgres (PGlite).
//
// 0219 adds `public.users.generates_sales`, the flag that decides who appears on the DIRECTOR DASHBOARD.
// Its central claim is a NEGATIVE one — "deploying this changes the dashboard for nobody" — and a claim
// of that shape is worth exactly as much as its proof. So the load-bearing tests here are the PARITY ones
// at the bottom: the OLD predicate and the NEW one are both run against the same rows, in a MULTI-OFFICE
// fixture, and required to return the same roster.
//
// THE DESIGN THE PARITY TESTS FORCED. An earlier draft folded deal ownership into the flag, by scanning
// every office_*.deals and marking owners true. That is wrong when there is more than one office: `users`
// is a GLOBAL table, so "owns a deal in office B" sets one global flag, and if the person is also a member
// of office A they appear on A's roster — which previously turned on A's deals alone. Ownership therefore
// stays where it lives, in the predicate's own tenant-local `owner_rows` branch, un-gated by the flag. The
// classification collapses to role='rep' -> true, everyone else -> false, and the flag only has to answer
// for people who own no deals at all.
//
// That also keeps the Team Commissions footer reconcilable: getCommissionOfficeTotals counts a deal
// whenever a rostered involved user exists and deliberately never reads this flag, so a flag that could
// hide a deal-owning person's row would leave value in the total with no row to explain it.
import { beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { migrationSql } from "../helpers/migration-sql.js";
import { dashboardRosterMembershipSql } from "../../src/modules/dashboard/service.js";

const MIGRATION_SQL = migrationSql("0219_users_generates_sales");
const dialect = new PgDialect();

const DALLAS = "11111111-1111-1111-1111-111111111111";
const ATLANTA = "22222222-2222-2222-2222-222222222222";

/** Only the columns 0219 and the roster predicates read; the real shape lives in the Drizzle schema. */
async function createFixtureSchema(pg: PGlite) {
  await pg.exec(`
    CREATE TABLE public.users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      display_name text NOT NULL,
      role text NOT NULL,
      office_id uuid NOT NULL,
      is_active boolean NOT NULL DEFAULT true,
      is_test_data boolean NOT NULL DEFAULT false
    );
    CREATE TABLE public.user_office_access (user_id uuid NOT NULL, office_id uuid NOT NULL);
    CREATE SCHEMA office_dallas;
    CREATE TABLE office_dallas.deals (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), assigned_rep_id uuid);
    CREATE SCHEMA office_atlanta;
    CREATE TABLE office_atlanta.deals (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), assigned_rep_id uuid);
  `);
}

async function addUser(pg: PGlite, name: string, role: string, officeId: string = DALLAS): Promise<string> {
  const result = await pg.query<{ id: string }>(
    `INSERT INTO public.users (display_name, role, office_id) VALUES ($1, $2, $3) RETURNING id`,
    [name, role, officeId]
  );
  return result.rows[0].id;
}

async function ownDeal(pg: PGlite, schema: string, repId: string) {
  await pg.query(`INSERT INTO ${schema}.deals (assigned_rep_id) VALUES ($1)`, [repId]);
}

async function grantOfficeAccess(pg: PGlite, name: string, officeId: string) {
  await pg.query(
    `INSERT INTO public.user_office_access (user_id, office_id)
     SELECT id, $1 FROM public.users WHERE display_name = $2`,
    [officeId, name]
  );
}

async function flagsByName(pg: PGlite): Promise<Record<string, boolean>> {
  const result = await pg.query<{ display_name: string; generates_sales: boolean }>(
    `SELECT display_name, generates_sales FROM public.users ORDER BY display_name`
  );
  return Object.fromEntries(result.rows.map((row) => [row.display_name, row.generates_sales]));
}

/**
 * The roster query the dashboard actually runs, with the predicate under test spliced in. Built as a
 * drizzle template and rendered through PgDialect so the SHIPPED SQL is what executes here — a
 * hand-retyped copy of the predicate would pass forever after the real one changed.
 *
 * `dealsSchema` is which office's deals form `owner_rows`, i.e. which office's dashboard this is.
 */
async function rosterWithNewPredicate(pg: PGlite, officeId: string, dealsSchema = "office_dallas"): Promise<string[]> {
  const query = sql`
    WITH deal_owners AS (
      SELECT DISTINCT d.assigned_rep_id AS rep_id
      FROM ${sql.raw(dealsSchema)}.deals d
      WHERE d.assigned_rep_id IS NOT NULL
    )
    SELECT u.display_name
    FROM public.users u
    LEFT JOIN deal_owners owner_rows ON owner_rows.rep_id = u.id
    WHERE u.is_active = true
      AND COALESCE(u.is_test_data, false) = false
      AND ${dashboardRosterMembershipSql(officeId)}
    ORDER BY u.display_name
  `;
  const { sql: text, params } = dialect.sqlToQuery(query);
  const result = await pg.query<{ display_name: string }>(text, params as unknown[]);
  return result.rows.map((row) => row.display_name);
}

/**
 * The predicate as it stood BEFORE 0219, retyped deliberately: it is being deleted, so it is a historical
 * constant that cannot drift. This is the baseline the parity tests compare against.
 */
async function rosterWithOldPredicate(pg: PGlite, officeId: string, dealsSchema = "office_dallas"): Promise<string[]> {
  const result = await pg.query<{ display_name: string }>(
    `WITH deal_owners AS (
       SELECT DISTINCT d.assigned_rep_id AS rep_id
       FROM ${dealsSchema}.deals d
       WHERE d.assigned_rep_id IS NOT NULL
     )
     SELECT u.display_name
     FROM public.users u
     LEFT JOIN deal_owners owner_rows ON owner_rows.rep_id = u.id
     WHERE u.is_active = true
       AND COALESCE(u.is_test_data, false) = false
       AND (
         (u.role = 'rep' AND (u.office_id = $1 OR EXISTS (
            SELECT 1 FROM public.user_office_access uo WHERE uo.user_id = u.id AND uo.office_id = $1
         )))
         OR owner_rows.rep_id IS NOT NULL
       )
     ORDER BY u.display_name`,
    [officeId]
  );
  return result.rows.map((row) => row.display_name);
}

describe("migration 0219 — users.generates_sales", () => {
  let pg: PGlite;

  beforeEach(async () => {
    pg = new PGlite();
    await createFixtureSchema(pg);

    // A working rep with no deals yet. Must stay on the dashboard.
    await addUser(pg, "Rita Rep", "rep");
    // The clutter: an estimator holding role='rep' purely for CRM access, and owning nothing. 0219 must
    // NOT remove her — that is a human decision made in the UI, not a side effect of deploying.
    await addUser(pg, "Eve Estimator", "rep");
    // The Daniel Choc case: a director who will carry deals but has none yet, so he is invisible today.
    await addUser(pg, "Dan Director", "director");
    // A director who HAS owned a Dallas deal — visible today via the owner branch, must stay visible.
    const owner = await addUser(pg, "Olive Owner", "director");
    await ownDeal(pg, "office_dallas", owner);
    // Neither a rep nor an owner: invisible today, so flipping them false is unobservable.
    await addUser(pg, "Adam Admin", "admin");
    await addUser(pg, "Frank Field", "field_contractor");
    // A rep whose only office is Atlanta, with no Dallas deal: role='rep' globally, but the Dallas
    // dashboard must not show him (the D-5 cross-office finding).
    await addUser(pg, "Fred Foreign", "rep", ATLANTA);

    // THE MULTI-OFFICE TRAP. A non-rep who owns a deal in ATLANTA and is ALSO a member of Dallas. Under
    // the old predicate he is on Atlanta's roster (owner there) and NOT on Dallas's (non-rep, owns nothing
    // in Dallas). A flag set from "owns a deal anywhere" would have put him on BOTH.
    const crossOffice = await addUser(pg, "Carl CrossOffice", "director", ATLANTA);
    await ownDeal(pg, "office_atlanta", crossOffice);
    await grantOfficeAccess(pg, "Carl CrossOffice", DALLAS);
  });

  it("adds the column NOT NULL DEFAULT true, so an insert that ignores it still yields a valid row", async () => {
    await pg.exec(MIGRATION_SQL);
    await addUser(pg, "Nina New", "rep");
    expect((await flagsByName(pg))["Nina New"]).toBe(true);

    const meta = await pg.query<{ is_nullable: string; column_default: string }>(
      `SELECT is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'generates_sales'`
    );
    expect(meta.rows[0].is_nullable).toBe("NO");
    expect(meta.rows[0].column_default).toContain("true");
  });

  it("classifies on ROLE alone — ownership is the predicate's job, not this column's", async () => {
    await pg.exec(MIGRATION_SQL);
    expect(await flagsByName(pg)).toEqual({
      // Reps stay ticked — INCLUDING the estimator. Deploy must not quietly remove a human from a report.
      "Rita Rep": true,
      "Eve Estimator": true,
      "Fred Foreign": true,
      // Everyone else is false, INCLUDING deal owners. They keep their dashboard row through the
      // un-gated owner branch, per office, which is what makes multi-office parity hold.
      "Olive Owner": false,
      "Carl CrossOffice": false,
      "Dan Director": false,
      "Adam Admin": false,
      "Frank Field": false,
    });
  });

  it("reads no tenant data at all — the classification is a single global UPDATE", async () => {
    // The earlier draft looped every office_%.deals to find owners. Beyond the multi-office bug, that made
    // a global column's value depend on tenant state, so a half-provisioned schema could change it.
    //
    // EXECUTABLE SQL ONLY. The header discusses the office_* schemas at length to explain why it does not
    // touch them, and prose is not a dependency — asserting against the raw file would fail on its own
    // documentation. (0216's POSIX-class guard filters comments for exactly this reason.)
    const executableSql = MIGRATION_SQL.split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    expect(executableSql).not.toContain("office_");
    expect(executableSql).not.toContain("to_regclass");
    expect(executableSql).toContain("WHERE role <> 'rep'");
    // Not vacuous: there IS executable SQL to inspect.
    expect(executableSql).toContain("ALTER TABLE public.users");
  });

  it("a replay is safe even when NO user is left false — the guard keys on the schema, not the data", async () => {
    // The case a data-based guard ("does anyone have false?") gets wrong. An admin may legitimately tick
    // EVERY non-rep on, leaving no false rows at all; a replay would then look like a first run and reset
    // all of them, silently undoing precisely the decisions the guard protects.
    await pg.exec(MIGRATION_SQL);
    await pg.exec(`UPDATE public.users SET generates_sales = true`);

    await pg.exec(MIGRATION_SQL);

    const flags = await flagsByName(pg);
    expect(Object.values(flags).every(Boolean)).toBe(true);
    // ...and specifically the non-reps an admin turned on stay on.
    expect(flags["Adam Admin"]).toBe(true);
    expect(flags["Dan Director"]).toBe(true);
  });

  it("a replay does not revert an admin's deliberate edits", async () => {
    await pg.exec(MIGRATION_SQL);
    // The intended first use of the toggle: put Dan on the dashboard. And the intended cleanup: take the
    // estimator off it.
    await pg.exec(`
      UPDATE public.users SET generates_sales = true  WHERE display_name = 'Dan Director';
      UPDATE public.users SET generates_sales = false WHERE display_name = 'Eve Estimator';
    `);

    await pg.exec(MIGRATION_SQL);

    const flags = await flagsByName(pg);
    expect(flags["Dan Director"]).toBe(true);   // re-classification would have flipped this back to false
    expect(flags["Eve Estimator"]).toBe(false); // ...and this back to true, undoing the whole cleanup
  });

  /**
   * THE TESTS THE MIGRATION'S HEADER RESTS ON. Every other assertion here describes a column; these
   * describe the SCREEN. If either fails, the deploy moves somebody on or off a director dashboard
   * without a human having asked for it — the one outcome that is never acceptable.
   */
  it("shows exactly the TICKED office members, and nobody else", async () => {
    await pg.exec(MIGRATION_SQL);

    // The flag is ABSOLUTE. Strict old/new parity no longer holds and is no longer claimed: the old
    // predicate admitted any deal owner regardless, so Olive (a director who owns a Dallas deal but is
    // not ticked) appeared there and does not here. That difference IS the fix -- an admin who unticks
    // someone expects them gone, and the previous behaviour silently declined for anyone holding a deal.
    const after = await rosterWithNewPredicate(pg, DALLAS);
    expect(after).toEqual(["Eve Estimator", "Rita Rep"]);

    // NOT VACUOUS: a real, partial subset of the fixture.
    expect(after.length).toBeLessThan(Object.keys(await flagsByName(pg)).length);

    // ...and the one the old predicate kept purely for owning a deal is the difference.
    const before = await rosterWithOldPredicate(pg, DALLAS);
    expect(before).toContain("Olive Owner");
    expect(after).not.toContain("Olive Owner");
  });

  it("applies the same rule per office — Atlanta shows its ticked members only", async () => {
    await pg.exec(MIGRATION_SQL);

    // Fred is a ticked Atlanta rep. Carl owns an Atlanta deal but is a non-rep the backfill left
    // unticked, so he is absent here too — consistently, not just in Dallas.
    const after = await rosterWithNewPredicate(pg, ATLANTA, "office_atlanta");
    expect(after).toEqual(["Fred Foreign"]);
  });

  it("does NOT let ownership in one office grant a roster seat in another", async () => {
    // The bug this design avoids. Carl owns in Atlanta and is a MEMBER of Dallas. A global flag set from
    // "owns a deal anywhere" would satisfy the Dallas membership arm and put him on Dallas's dashboard,
    // with no admin action and no Dallas deal — silently, on deploy.
    await pg.exec(MIGRATION_SQL);
    expect(await rosterWithNewPredicate(pg, DALLAS)).not.toContain("Carl CrossOffice");
    expect(await rosterWithOldPredicate(pg, DALLAS)).not.toContain("Carl CrossOffice");
    // Once an admin TICKS him he appears in both offices — and that is right, not a leak: he holds a
    // user_office_access grant for Dallas, so he is a member there, and a ticked member is exactly who
    // the roster is for (the same shape as a director hired to sell who has no deals yet). The point of
    // this test is that OWNERSHIP alone never did that; only a deliberate tick does.
    await pg.exec(`UPDATE public.users SET generates_sales = true WHERE display_name = 'Carl CrossOffice'`);
    expect(await rosterWithNewPredicate(pg, ATLANTA, "office_atlanta")).toContain("Carl CrossOffice");
    expect(await rosterWithNewPredicate(pg, DALLAS)).toContain("Carl CrossOffice");
  });

  it("keeps the office boundary the old predicate enforced — a foreign-office rep stays out", async () => {
    await pg.exec(MIGRATION_SQL);
    // Fred is role='rep' and generates_sales=true, so ONLY the membership half keeps him off the Dallas
    // dashboard. `users` is global; without that half every office's reps merge.
    expect(await rosterWithNewPredicate(pg, DALLAS)).not.toContain("Fred Foreign");

    // ...and a user_office_access grant is what legitimately lets a shared rep back in.
    await grantOfficeAccess(pg, "Fred Foreign", DALLAS);
    expect(await rosterWithNewPredicate(pg, DALLAS)).toContain("Fred Foreign");
  });

  it("puts a ticked director on the dashboard without waiting for his first deal", async () => {
    await pg.exec(MIGRATION_SQL);
    expect(await rosterWithNewPredicate(pg, DALLAS)).not.toContain("Dan Director");

    await pg.exec(`UPDATE public.users SET generates_sales = true WHERE display_name = 'Dan Director'`);

    // The whole point of P0 #1: tracked from day one. Under the old predicate this was unreachable — no
    // configuration could show a director with no deals.
    expect(await rosterWithNewPredicate(pg, DALLAS)).toContain("Dan Director");
    expect(await rosterWithOldPredicate(pg, DALLAS)).not.toContain("Dan Director");
  });

  it("removes an unticked estimator who owns nothing — the actual cleanup", async () => {
    await pg.exec(MIGRATION_SQL);
    expect(await rosterWithNewPredicate(pg, DALLAS)).toContain("Eve Estimator");

    await pg.exec(`UPDATE public.users SET generates_sales = false WHERE display_name = 'Eve Estimator'`);

    expect(await rosterWithNewPredicate(pg, DALLAS)).not.toContain("Eve Estimator");
    // Rita is untouched: unticking is per-person, not a role-wide rule.
    expect(await rosterWithNewPredicate(pg, DALLAS)).toContain("Rita Rep");
  });

  it("REMOVES someone who owns deals — the flag is absolute", async () => {
    await pg.exec(MIGRATION_SQL);
    await pg.exec(`UPDATE public.users SET generates_sales = true  WHERE display_name = 'Olive Owner'`);
    expect(await rosterWithNewPredicate(pg, DALLAS)).toContain("Olive Owner");

    await pg.exec(`UPDATE public.users SET generates_sales = false WHERE display_name = 'Olive Owner'`);

    // An earlier revision kept deal owners regardless, to stop the Team Commissions footer counting value
    // whose row had been hidden. That protection now lives where it belongs — getDirectorRepCommissionRows
    // retains anyone with earned or live-deal evidence on its own — so the performance rosters can honour
    // the toggle. In production the old behaviour meant unticking a director with 3 deals, a rep with 2
    // and an admin with 122 changed nothing at all.
    expect(await rosterWithNewPredicate(pg, DALLAS)).not.toContain("Olive Owner");
  });
});
