import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";

// Apply the REAL migration file against seeded office schemas so a SQL typo, a bad %I placeholder count,
// or a broken FK target can't slip past the gate (typecheck never touches .sql).
const MIGRATION = readFileSync(
  new URL("../../../../migrations/0172_field_scorecards.sql", import.meta.url),
  "utf8",
);
const OFFICES = ["office_dallas", "office_atlanta"];

let pg: PGlite;

async function tableExists(schema: string, table: string): Promise<boolean> {
  const res = await pg.query(`SELECT to_regclass('${schema}.${table}') IS NOT NULL AS present`);
  return (res.rows[0] as { present: boolean }).present;
}

beforeAll(async () => {
  pg = new PGlite();
  // Each office needs the FK targets the migration references (deals, files).
  for (const office of OFFICES) {
    await pg.exec(`
      CREATE SCHEMA ${office};
      CREATE TABLE ${office}.deals (id uuid PRIMARY KEY, sales_source_user_id uuid);
      CREATE TABLE ${office}.files (id uuid PRIMARY KEY);
    `);
  }
  await pg.exec(MIGRATION);
});

afterAll(async () => {
  await pg?.close?.();
});

describe("0172_field_scorecards migration", () => {
  it("creates all three scorecard tables in every existing office schema", async () => {
    for (const office of OFFICES) {
      expect(await tableExists(office, "field_scorecards")).toBe(true);
      expect(await tableExists(office, "field_scorecard_items")).toBe(true);
      expect(await tableExists(office, "field_scorecard_photos")).toBe(true);
    }
  });

  it("is idempotent — re-running does not error", async () => {
    await expect(pg.exec(MIGRATION)).resolves.toBeDefined();
  });

  it("enforces the client_submission_id unique constraint", async () => {
    const deal = "11111111-1111-1111-1111-111111111111";
    const csid = "22222222-2222-2222-2222-222222222222";
    await pg.exec(`INSERT INTO office_dallas.deals (id) VALUES ('${deal}') ON CONFLICT DO NOTHING`);
    const insert = (id: string) =>
      `INSERT INTO office_dallas.field_scorecards
         (id, client_submission_id, deal_id, week_of, total_score, rating, submitted_by)
       VALUES ('${id}','${csid}','${deal}','2026-06-30', 90, 'elite', '${deal}')`;
    await pg.exec(insert("33333333-3333-3333-3333-333333333333"));
    await expect(pg.exec(insert("44444444-4444-4444-4444-444444444444"))).rejects.toThrow();
  });

  it("cascades item + photo deletes when a scorecard is removed", async () => {
    const deal = "11111111-1111-1111-1111-111111111111";
    const card = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const file = "ffffffff-ffff-ffff-ffff-ffffffffffff";
    await pg.exec(`INSERT INTO office_dallas.deals (id) VALUES ('${deal}') ON CONFLICT DO NOTHING`);
    await pg.exec(`INSERT INTO office_dallas.files (id) VALUES ('${file}') ON CONFLICT DO NOTHING`);
    await pg.exec(`INSERT INTO office_dallas.field_scorecards
      (id, client_submission_id, deal_id, week_of, total_score, rating, submitted_by)
      VALUES ('${card}','99999999-9999-9999-9999-999999999999','${deal}','2026-06-30', 80, 'needs_improvement', '${deal}')`);
    await pg.exec(`INSERT INTO office_dallas.field_scorecard_items (scorecard_id, section_key, points) VALUES ('${card}','schedule',20)`);
    await pg.exec(`INSERT INTO office_dallas.field_scorecard_photos (scorecard_id, section_key, file_id) VALUES ('${card}','schedule','${file}')`);

    await pg.exec(`DELETE FROM office_dallas.field_scorecards WHERE id='${card}'`);
    const items = await pg.query(`SELECT count(*)::int AS n FROM office_dallas.field_scorecard_items WHERE scorecard_id='${card}'`);
    const photos = await pg.query(`SELECT count(*)::int AS n FROM office_dallas.field_scorecard_photos WHERE scorecard_id='${card}'`);
    expect((items.rows[0] as { n: number }).n).toBe(0);
    expect((photos.rows[0] as { n: number }).n).toBe(0);
  });
});
