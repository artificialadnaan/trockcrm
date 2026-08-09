// Executes Migration 0219 FROM DISK against a real Postgres (PGlite).
//
// 0219 adds `public.users.generates_sales`, the flag that decides who appears on the DIRECTOR DASHBOARD.
// Its central claim is a NEGATIVE one — "deploying this changes the dashboard for nobody" — and a claim
// of that shape is worth exactly as much as its proof. So the load-bearing test here is not any single
// backfill outcome but the PARITY test at the bottom: the OLD predicate and the NEW one are both run
// against the same rows, and required to return the same roster.
//
// Proven here against real SQL, none of which a fixture test can reach:
//   1. the column lands NOT NULL DEFAULT true, so any insert path that has not been taught about it
//      still produces a valid row;
//   2. the backfill flips only people who could not appear on the dashboard today anyway;
//   3. role='rep' survives it — the estimators Adnaan wants gone are NOT cleaned up by deploying this,
//      by design, because silently removing people is the behaviour this flag exists to make explicit;
//   4. deal ownership is honoured across EVERY office_% schema, not just the first;
//   5. a half-provisioned tenant is skipped rather than aborting the migration for every other office;
//   6. the re-run guard protects an admin's deliberate edits from a replay; and
//   7. the OLD and NEW roster predicates select the identical set of users.
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
    CREATE TABLE public.user_office_access (
      user_id uuid NOT NULL,
      office_id uuid NOT NULL
    );
    CREATE SCHEMA office_dallas;
    CREATE TABLE office_dallas.deals (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      assigned_rep_id uuid
    );
    CREATE SCHEMA office_atlanta;
    CREATE TABLE office_atlanta.deals (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      assigned_rep_id uuid
    );
  `);
}

async function addUser(
  pg: PGlite,
  name: string,
  role: string,
  officeId: string = DALLAS,
): Promise<string> {
  const result = await pg.query<{ id: string }>(
    `INSERT INTO public.users (display_name, role, office_id) VALUES ($1, $2, $3) RETURNING id`,
    [name, role, officeId],
  );
  return result.rows[0].id;
}

async function ownDeal(pg: PGlite, schema: string, repId: string) {
  await pg.query(`INSERT INTO ${schema}.deals (assigned_rep_id) VALUES ($1)`, [repId]);
}

async function flagsByName(pg: PGlite): Promise<Record<string, boolean>> {
  const result = await pg.query<{ display_name: string; generates_sales: boolean }>(
    `SELECT display_name, generates_sales FROM public.users ORDER BY display_name`,
  );
  return Object.fromEntries(result.rows.map((row) => [row.display_name, row.generates_sales]));
}

/**
 * The roster query the dashboard actually runs, with the predicate under test spliced in. Built as a
 * drizzle template and rendered through PgDialect so the SHIPPED SQL is what executes here — a
 * hand-retyped copy of the predicate would pass forever after the real one changed.
 */
async function rosterWithNewPredicate(pg: PGlite, officeId?: string): Promise<string[]> {
  const query = sql`
    WITH deal_owners AS (
      SELECT DISTINCT d.assigned_rep_id AS rep_id
      FROM office_dallas.deals d
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
 * The predicate as it stood BEFORE 0219, retyped deliberately: it is being deleted, so it is a
 * historical constant that cannot drift. This is the baseline the parity test compares against.
 */
async function rosterWithOldPredicate(pg: PGlite, officeId?: string): Promise<string[]> {
  const repBranch = officeId
    ? `(u.role = 'rep' AND (u.office_id = $1 OR EXISTS (
         SELECT 1 FROM user_office_access uo WHERE uo.user_id = u.id AND uo.office_id = $1
       )))`
    : `(u.role = 'rep')`;
  const result = await pg.query<{ display_name: string }>(
    `WITH deal_owners AS (
       SELECT DISTINCT d.assigned_rep_id AS rep_id
       FROM office_dallas.deals d
       WHERE d.assigned_rep_id IS NOT NULL
     )
     SELECT u.display_name
     FROM public.users u
     LEFT JOIN deal_owners owner_rows ON owner_rows.rep_id = u.id
     WHERE u.is_active = true
       AND COALESCE(u.is_test_data, false) = false
       AND (${repBranch} OR owner_rows.rep_id IS NOT NULL)
     ORDER BY u.display_name`,
    officeId ? [officeId] : [],
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
    // The clutter: an estimator holding role='rep' purely for CRM access. 0219 must NOT remove her —
    // that is a human decision made in the UI, not a side effect of deploying.
    await addUser(pg, "Eve Estimator", "rep");
    // The Daniel Choc case: a director who will carry deals but has none yet, so he is invisible today.
    await addUser(pg, "Dan Director", "director");
    // A director who HAS owned a deal — visible today via the owner branch, must stay visible.
    const owner = await addUser(pg, "Olive Owner", "director");
    await ownDeal(pg, "office_dallas", owner);
    // Neither a rep nor an owner: invisible today, so flipping him false is unobservable.
    await addUser(pg, "Adam Admin", "admin");
    await addUser(pg, "Frank Field", "field_contractor");
    // An Atlanta admin who owns an ATLANTA deal. Proves the backfill loops every schema.
    const atl = await addUser(pg, "Aria Atlanta", "admin", ATLANTA);
    await ownDeal(pg, "office_atlanta", atl);
    // A rep whose only office is Atlanta, with no Dallas deal: role='rep' globally, but the Dallas
    // dashboard must not show him (the D-5 cross-office finding).
    await addUser(pg, "Fred Foreign", "rep", ATLANTA);
  });

  it("adds the column NOT NULL DEFAULT true, so an insert that ignores it still yields a valid row", async () => {
    await pg.exec(MIGRATION_SQL);
    await addUser(pg, "Nina New", "rep");
    const flags = await flagsByName(pg);
    expect(flags["Nina New"]).toBe(true);

    const nullable = await pg.query<{ is_nullable: string; column_default: string }>(
      `SELECT is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'generates_sales'`,
    );
    expect(nullable.rows[0].is_nullable).toBe("NO");
    expect(nullable.rows[0].column_default).toContain("true");
  });

  it("leaves every rep and every deal owner ticked, and unticks only the invisible remainder", async () => {
    await pg.exec(MIGRATION_SQL);
    expect(await flagsByName(pg)).toEqual({
      // Reps stay — INCLUDING the estimator. Deploy must not quietly remove a human from a report.
      "Rita Rep": true,
      "Eve Estimator": true,
      "Fred Foreign": true,
      // Owners stay, whatever their role and whichever office they own in.
      "Olive Owner": true,
      "Aria Atlanta": true,
      // Neither rep nor owner: already absent from every roster, so this is unobservable.
      "Dan Director": false,
      "Adam Admin": false,
      "Frank Field": false,
    });
  });

  it("counts deal ownership in EVERY office schema, not just the first", async () => {
    await pg.exec(MIGRATION_SQL);
    // Aria owns nothing in Dallas; her only deal is in office_atlanta. A single-schema backfill would
    // have unticked her, silently dropping a real deal owner off the Atlanta dashboard.
    expect((await flagsByName(pg))["Aria Atlanta"]).toBe(true);
  });

  it("skips a half-provisioned office schema instead of aborting the migration for every office", async () => {
    await pg.exec(`CREATE SCHEMA office_halfbuilt;`); // no deals table
    await expect(pg.exec(MIGRATION_SQL)).resolves.toBeDefined();
    expect((await flagsByName(pg))["Olive Owner"]).toBe(true);
  });

  it("a replay does not revert an admin's deliberate edits", async () => {
    await pg.exec(MIGRATION_SQL);
    // The intended first use of the toggle: put Dan on the dashboard. And the intended cleanup:
    // take the estimator off it.
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
   * THE TEST THE MIGRATION'S HEADER RESTS ON. Every other assertion here describes a column; this one
   * describes the SCREEN. If it ever fails, the deploy moves somebody on or off the director dashboard
   * without a human having asked for it — which is the one outcome that is never acceptable, whatever
   * the flag says.
   */
  it("selects the IDENTICAL roster to the predicate it replaces, immediately after the backfill", async () => {
    await pg.exec(MIGRATION_SQL);

    const before = await rosterWithOldPredicate(pg, DALLAS);
    const after = await rosterWithNewPredicate(pg, DALLAS);
    expect(after).toEqual(before);

    // NOT VACUOUS: the roster is a real, partial subset — some users in, some out. "They agree" proves
    // nothing if both sides return everybody or nobody.
    expect(before).toEqual(["Eve Estimator", "Olive Owner", "Rita Rep"]);
    expect(before.length).toBeLessThan(Object.keys(await flagsByName(pg)).length);
  });

  it("keeps the office boundary the old predicate enforced — a foreign-office rep stays out", async () => {
    await pg.exec(MIGRATION_SQL);
    // Fred is role='rep' and generates_sales=true, so ONLY the membership half of the predicate keeps
    // him off the Dallas dashboard. `users` is global; without that half every office's reps merge.
    expect(await rosterWithNewPredicate(pg, DALLAS)).not.toContain("Fred Foreign");

    // ...and a user_office_access grant is what legitimately lets a shared rep back in.
    await pg.query(
      `INSERT INTO public.user_office_access (user_id, office_id)
       SELECT id, $1 FROM public.users WHERE display_name = 'Fred Foreign'`,
      [DALLAS],
    );
    expect(await rosterWithNewPredicate(pg, DALLAS)).toContain("Fred Foreign");
  });

  it("puts a ticked director on the dashboard without waiting for his first deal", async () => {
    await pg.exec(MIGRATION_SQL);
    expect(await rosterWithNewPredicate(pg, DALLAS)).not.toContain("Dan Director");

    await pg.exec(`UPDATE public.users SET generates_sales = true WHERE display_name = 'Dan Director'`);

    // The whole point of P0 #1: he is tracked from day one. Under the old predicate this was
    // unreachable — no amount of configuration could show a director with no deals.
    expect(await rosterWithNewPredicate(pg, DALLAS)).toContain("Dan Director");
    expect(await rosterWithOldPredicate(pg, DALLAS)).not.toContain("Dan Director");
  });

  it("removes an unticked estimator from the roster", async () => {
    await pg.exec(MIGRATION_SQL);
    expect(await rosterWithNewPredicate(pg, DALLAS)).toContain("Eve Estimator");

    await pg.exec(`UPDATE public.users SET generates_sales = false WHERE display_name = 'Eve Estimator'`);

    expect(await rosterWithNewPredicate(pg, DALLAS)).not.toContain("Eve Estimator");
    // Rita is untouched: unticking is per-person, not a role-wide rule.
    expect(await rosterWithNewPredicate(pg, DALLAS)).toContain("Rita Rep");
  });

  it("unticking a deal OWNER removes them too — the owner branch is no longer an override", async () => {
    await pg.exec(MIGRATION_SQL);
    await pg.exec(`UPDATE public.users SET generates_sales = false WHERE display_name = 'Olive Owner'`);

    // Deliberate: under the old predicate a single historical deal pinned someone to the dashboard
    // forever, with no way to remove them. That was the other half of the messy room.
    expect(await rosterWithNewPredicate(pg, DALLAS)).not.toContain("Olive Owner");
    expect(await rosterWithOldPredicate(pg, DALLAS)).toContain("Olive Owner");
  });
});
