import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Regression: migration 0171 must NOT abort on a drifted/legacy tenant whose `deals` table never got the
 * `companycam_project_id` column (e.g. office_pwauditoffice — it missed migration 0007). The original 0171
 * pre-flight + backfill read that column across every office_* schema and halted the whole deploy with
 * error 42703. The fix guards both with an information_schema column-existence check; the join table is
 * still created for the drifted tenant (just no dedupe/backfill).
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationPath = resolve(__dirname, "../../../../migrations/0171_deal_companycam_projects.sql");
const migrationSql = existsSync(migrationPath) ? readFileSync(migrationPath, "utf8") : "";

let pg: PGlite;
const one = async (sql: string) => (await pg.query(sql)).rows[0] as Record<string, unknown>;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE SCHEMA office_dallas;
    CREATE SCHEMA office_normal;
    CREATE SCHEMA office_pwauditoffice; -- drifted: deals has NO companycam_project_id
    CREATE TABLE office_dallas.deals (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), companycam_project_id varchar(50));
    CREATE TABLE office_normal.deals (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), companycam_project_id varchar(50));
    CREATE TABLE office_pwauditoffice.deals (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
    INSERT INTO office_normal.deals (companycam_project_id) VALUES ('cc-100'), (NULL);
  `);
}, 30000);

afterAll(async () => {
  await pg?.close?.();
});

describe("migration 0171 — drifted tenant (deals without companycam_project_id)", () => {
  it("runs without 42703, backfills only where the column exists, and is idempotent", async () => {
    expect(migrationSql).not.toBe(""); // guard against a path regression silently passing

    // Must not throw on office_pwauditoffice (the column it lacks).
    await expect(pg.exec(migrationSql)).resolves.toBeDefined();

    // Join table created in EVERY tenant (incl. the drifted one).
    expect((await one(`SELECT to_regclass('office_dallas.deal_companycam_projects')::text r`)).r).toBe("office_dallas.deal_companycam_projects");
    expect((await one(`SELECT to_regclass('office_pwauditoffice.deal_companycam_projects')::text r`)).r).toBe("office_pwauditoffice.deal_companycam_projects");

    // Backfill only where the scalar column exists: the non-null link in office_normal, nothing in the drifted office.
    expect((await one(`SELECT count(*)::int c FROM office_normal.deal_companycam_projects`)).c).toBe(1);
    expect((await one(`SELECT count(*)::int c FROM office_pwauditoffice.deal_companycam_projects`)).c).toBe(0);

    // Idempotent replay — no error, no double-insert.
    await expect(pg.exec(migrationSql)).resolves.toBeDefined();
    expect((await one(`SELECT count(*)::int c FROM office_normal.deal_companycam_projects`)).c).toBe(1);
  });
});
