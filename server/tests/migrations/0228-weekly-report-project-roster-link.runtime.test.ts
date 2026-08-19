// Executes migration 0228 FROM DISK against a real Postgres (PGlite).
//
// 0228 points a weekly-report project's PM and superintendent at the FIELD TEAM ROSTER: two new
// `field_responders` FK columns on `weekly_report_projects`, and a backfill that links the setups already
// out there by matching the current login's email to a roster row.
//
// Written twice, as every tenant column-add in this repo is: a DO-loop over the existing `office_*`
// schemas, and a `TENANT_SCHEMA_START/END` block the office provisioner replays for a new office.
//
// WHICH IS WHY THE TWO HALVES ARE PROVED APART. The DO loop matches `office_dallas` like any other office,
// so a suite that runs the whole migration and then asserts against `office_dallas` stays green with the
// TENANT block deleted — and every office provisioned after that deploy would get 0227's shape, no
// responder columns, and a setup form whose picker writes to a column that is not there.
//
//   1. The LOOP is proved by a second office schema, which the tenant block does not mention at all.
//   2. The TENANT BLOCK is proved by replaying it alone, with the loop never executed.
//
// The BACKFILL gets its own attention because its failure mode is silent and wrong rather than loud: it
// decides who may approve a client-facing report, so "guessed a plausible person" is a worse outcome than
// "left it null and let a human pick".

import { beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { migrationSql } from "../helpers/migration-sql.js";

const MIGRATION = "0228_weekly_report_project_roster_link";

let pg: PGlite;

async function columnType(schema: string, column: string): Promise<string | null> {
  const result = await pg.query<{ data_type: string; is_nullable: string }>(
    `SELECT data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'weekly_report_projects' AND column_name = $2`,
    [schema, column],
  );
  const row = result.rows[0];
  return row ? `${row.data_type}/${row.is_nullable}` : null;
}

async function constraintNames(schema: string): Promise<string[]> {
  const result = await pg.query<{ conname: string }>(
    `SELECT c.conname FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = $1 AND t.relname = 'weekly_report_projects' AND c.contype = 'f'
      ORDER BY c.conname`,
    [schema],
  );
  return result.rows.map((row) => row.conname);
}

/**
 * The minimum shape 0228 needs, plus `public.users` — which is NOT per-office and is what the backfill
 * joins the roster to.
 */
async function seedOffices(schemas: string[]) {
  await pg.exec(`
    CREATE TABLE IF NOT EXISTS public.users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email text NOT NULL,
      display_name text
    );
  `);
  for (const schema of schemas) {
    await pg.exec(`
      CREATE SCHEMA IF NOT EXISTS ${schema};
      CREATE TABLE ${schema}.field_responders (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL,
        email text NOT NULL,
        role text NOT NULL,
        is_active boolean NOT NULL DEFAULT true
      );
      CREATE TABLE ${schema}.weekly_report_projects (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        deal_id uuid NOT NULL DEFAULT gen_random_uuid(),
        trock_pm_user_id uuid,
        trock_super_user_id uuid,
        is_active boolean NOT NULL DEFAULT true
      );
    `);
  }
}

/** The block the office provisioner replays, lifted out of the file exactly as the provisioner lifts it. */
function tenantBlock(): string {
  const raw = migrationSql(MIGRATION);
  const block = raw.split("-- TENANT_SCHEMA_START")[1]?.split("-- TENANT_SCHEMA_END")[0];
  expect(block, "TENANT_SCHEMA_START/END markers must be present").toBeTruthy();
  return block!;
}

/** One person who exists BOTH as a login and on the roster — the ordinary case the backfill is for. */
async function seedLinkablePerson(opts: {
  schema: string;
  email: string;
  rosterRole: string;
  rosterActive?: boolean;
}): Promise<{ userId: string; responderId: string }> {
  const user = await pg.query<{ id: string }>(
    `INSERT INTO public.users (email, display_name) VALUES ($1, 'Someone') RETURNING id`,
    [opts.email],
  );
  const responder = await pg.query<{ id: string }>(
    `INSERT INTO ${opts.schema}.field_responders (name, email, role, is_active)
     VALUES ('Someone', $1, $2, $3) RETURNING id`,
    [opts.email, opts.rosterRole, opts.rosterActive ?? true],
  );
  return { userId: user.rows[0]!.id, responderId: responder.rows[0]!.id };
}

async function pmResponderIdOf(schema: string): Promise<string | null> {
  const result = await pg.query<{ id: string | null }>(
    `SELECT trock_pm_responder_id AS id FROM ${schema}.weekly_report_projects LIMIT 1`,
  );
  return result.rows[0]?.id ?? null;
}

beforeEach(async () => {
  pg = new PGlite();
});

describe("migration 0228 — field-team roster link on weekly_report_projects", () => {
  it("adds both columns to EVERY office schema, not just Dallas", async () => {
    await seedOffices(["office_dallas", "office_atlanta"]);
    await pg.exec(migrationSql(MIGRATION));

    for (const schema of ["office_dallas", "office_atlanta"]) {
      expect(await columnType(schema, "trock_pm_responder_id"), schema).toBe("uuid/YES");
      expect(await columnType(schema, "trock_super_responder_id"), schema).toBe("uuid/YES");
      expect(await constraintNames(schema), schema).toEqual([
        "weekly_report_projects_pm_responder_fkey",
        "weekly_report_projects_super_responder_fkey",
      ]);
    }
  });

  it("has a TENANT_SCHEMA block that adds the same columns and keys on its own", async () => {
    // Replayed ALONE, with the loop never run: the only way to tell the two halves apart, and the reason
    // a suite that runs the whole migration cannot.
    await seedOffices(["office_dallas"]);
    expect(await columnType("office_dallas", "trock_pm_responder_id")).toBeNull();

    await pg.exec(tenantBlock());

    expect(await columnType("office_dallas", "trock_pm_responder_id")).toBe("uuid/YES");
    expect(await columnType("office_dallas", "trock_super_responder_id")).toBe("uuid/YES");
    expect(await constraintNames("office_dallas")).toEqual([
      "weekly_report_projects_pm_responder_fkey",
      "weekly_report_projects_super_responder_fkey",
    ]);
  });

  it("skips an office that has no field_responders table instead of aborting the whole migration", async () => {
    // An office lacking 0198 must not take every office after it down with a failed ALTER — the same
    // reason 0226 skips offices without `weekly_reports`.
    await seedOffices(["office_dallas"]);
    await pg.exec(`
      CREATE SCHEMA office_legacy;
      CREATE TABLE office_legacy.weekly_report_projects (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        trock_pm_user_id uuid,
        trock_super_user_id uuid,
        is_active boolean NOT NULL DEFAULT true
      );
    `);

    await expect(pg.exec(migrationSql(MIGRATION))).resolves.toBeDefined();
    expect(await columnType("office_dallas", "trock_pm_responder_id")).toBe("uuid/YES");
    expect(await columnType("office_legacy", "trock_pm_responder_id")).toBeNull();
  });

  describe("the backfill", () => {
    it("links a setup whose PM is on the roster under the matching role", async () => {
      await seedOffices(["office_dallas"]);
      const { userId, responderId } = await seedLinkablePerson({
        schema: "office_dallas",
        email: "asherwood@trockgc.com",
        rosterRole: "project_manager",
      });
      await pg.exec(
        `INSERT INTO office_dallas.weekly_report_projects (trock_pm_user_id) VALUES ('${userId}'::uuid)`,
      );

      await pg.exec(migrationSql(MIGRATION));

      expect(await pmResponderIdOf("office_dallas")).toBe(responderId);
    });

    it("matches case-insensitively, because the two tables store addresses as they were typed", async () => {
      await seedOffices(["office_dallas"]);
      const user = await pg.query<{ id: string }>(
        `INSERT INTO public.users (email, display_name) VALUES ('ASherwood@TrockGC.com', 'Adam') RETURNING id`,
      );
      const responder = await pg.query<{ id: string }>(
        `INSERT INTO office_dallas.field_responders (name, email, role)
         VALUES ('Adam Sherwood', 'asherwood@trockgc.com', 'project_manager') RETURNING id`,
      );
      await pg.exec(
        `INSERT INTO office_dallas.weekly_report_projects (trock_pm_user_id)
         VALUES ('${user.rows[0]!.id}'::uuid)`,
      );

      await pg.exec(migrationSql(MIGRATION));

      expect(await pmResponderIdOf("office_dallas")).toBe(responder.rows[0]!.id);
    });

    it("does NOT put a superintendent into the PM slot", async () => {
      // The direction that hands out approval rights. A roster row is only a match for the slot whose
      // role it actually holds; anything else stays null for a human to decide.
      await seedOffices(["office_dallas"]);
      const { userId } = await seedLinkablePerson({
        schema: "office_dallas",
        email: "ssanchez@trockgc.com",
        rosterRole: "superintendent",
      });
      await pg.exec(
        `INSERT INTO office_dallas.weekly_report_projects (trock_pm_user_id) VALUES ('${userId}'::uuid)`,
      );

      await pg.exec(migrationSql(MIGRATION));

      expect(await pmResponderIdOf("office_dallas")).toBeNull();
    });

    it("does NOT link a deactivated roster row", async () => {
      await seedOffices(["office_dallas"]);
      const { userId } = await seedLinkablePerson({
        schema: "office_dallas",
        email: "gone@trockgc.com",
        rosterRole: "project_manager",
        rosterActive: false,
      });
      await pg.exec(
        `INSERT INTO office_dallas.weekly_report_projects (trock_pm_user_id) VALUES ('${userId}'::uuid)`,
      );

      await pg.exec(migrationSql(MIGRATION));

      expect(await pmResponderIdOf("office_dallas")).toBeNull();
    });

    it("refuses to guess when one address is held by two active roster rows", async () => {
      // Ambiguity here silently decides who may approve a client-facing report. Null and a human is the
      // correct answer; picking either row is not.
      await seedOffices(["office_dallas"]);
      const user = await pg.query<{ id: string }>(
        `INSERT INTO public.users (email, display_name) VALUES ('dup@trockgc.com', 'Dup') RETURNING id`,
      );
      await pg.exec(`
        INSERT INTO office_dallas.field_responders (name, email, role) VALUES
          ('Dup One', 'dup@trockgc.com', 'project_manager'),
          ('Dup Two', 'dup@trockgc.com', 'project_manager');
      `);
      await pg.exec(
        `INSERT INTO office_dallas.weekly_report_projects (trock_pm_user_id)
         VALUES ('${user.rows[0]!.id}'::uuid)`,
      );

      await pg.exec(migrationSql(MIGRATION));

      expect(await pmResponderIdOf("office_dallas")).toBeNull();
    });

    it("leaves an unassigned setup alone rather than inventing a PM for it", async () => {
      await seedOffices(["office_dallas"]);
      await pg.exec(`INSERT INTO office_dallas.field_responders (name, email, role)
                     VALUES ('Adam Sherwood', 'asherwood@trockgc.com', 'project_manager')`);
      await pg.exec(`INSERT INTO office_dallas.weekly_report_projects (trock_pm_user_id) VALUES (NULL)`);

      await pg.exec(migrationSql(MIGRATION));

      expect(await pmResponderIdOf("office_dallas")).toBeNull();
    });
  });

  it("is idempotent — re-running changes nothing and does not error", async () => {
    // ADD CONSTRAINT has no IF NOT EXISTS, so a replay raises 42710 unless it is guarded. The runner
    // tracks migrations by filename, but a replay is a routine thing to need.
    await seedOffices(["office_dallas"]);
    const { userId, responderId } = await seedLinkablePerson({
      schema: "office_dallas",
      email: "asherwood@trockgc.com",
      rosterRole: "project_manager",
    });
    await pg.exec(
      `INSERT INTO office_dallas.weekly_report_projects (trock_pm_user_id) VALUES ('${userId}'::uuid)`,
    );

    await pg.exec(migrationSql(MIGRATION));
    await expect(pg.exec(migrationSql(MIGRATION))).resolves.toBeDefined();

    expect(await pmResponderIdOf("office_dallas")).toBe(responderId);
    expect(await constraintNames("office_dallas")).toEqual([
      "weekly_report_projects_pm_responder_fkey",
      "weekly_report_projects_super_responder_fkey",
    ]);
  });
});
