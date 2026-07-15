import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";

const MIGRATION = readFileSync(
  new URL("../../../../migrations/0185_field_scorecard_edit_uploads.sql", import.meta.url),
  "utf8",
);
const OFFICES = ["office_dallas", "office_atlanta"];

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  for (const office of OFFICES) {
    await pg.exec(`
      CREATE SCHEMA ${office};
      CREATE TABLE ${office}.deals (id uuid PRIMARY KEY);
      CREATE TABLE ${office}.files (id uuid PRIMARY KEY);
      CREATE TABLE ${office}.field_scorecards (id uuid PRIMARY KEY);
    `);
  }
  await pg.exec(MIGRATION);
});

afterAll(async () => {
  await pg?.close?.();
});

describe("0185 field scorecard edit upload registry", () => {
  it("creates the durable registry in every office and is idempotent", async () => {
    for (const office of OFFICES) {
      const result = await pg.query(`SELECT to_regclass('${office}.field_scorecard_edit_uploads') AS table_name`);
      expect((result.rows[0] as { table_name: string | null }).table_name).toBe(`${office}.field_scorecard_edit_uploads`);
    }
    await expect(pg.exec(MIGRATION)).resolves.toBeDefined();
  });

  it("enforces globally unique client ids and terminal state values", async () => {
    const deal = "11111111-1111-1111-1111-111111111111";
    const card = "22222222-2222-2222-2222-222222222222";
    const user = "33333333-3333-3333-3333-333333333333";
    await pg.exec(`
      INSERT INTO office_dallas.deals (id) VALUES ('${deal}');
      INSERT INTO office_dallas.field_scorecards (id) VALUES ('${card}');
      INSERT INTO office_dallas.field_scorecard_edit_uploads
        (scorecard_id, deal_id, client_upload_id, uploaded_by, state)
      VALUES ('${card}', '${deal}', 'client-1', '${user}', 'authorized');
    `);
    await expect(pg.exec(`
      INSERT INTO office_dallas.field_scorecard_edit_uploads
        (scorecard_id, deal_id, client_upload_id, uploaded_by, state)
      VALUES ('${card}', '${deal}', 'client-1', '${user}', 'confirmed')
    `)).rejects.toThrow();
    await expect(pg.exec(`
      INSERT INTO office_dallas.field_scorecard_edit_uploads
        (scorecard_id, deal_id, client_upload_id, uploaded_by, state)
      VALUES ('${card}', '${deal}', 'client-2', '${user}', 'unknown')
    `)).rejects.toThrow();
  });

  it("cascades scorecard deletion and preserves the registry row when a file is hard-deleted", async () => {
    const deal = "aaaaaaaa-1111-1111-1111-111111111111";
    const card = "aaaaaaaa-2222-2222-2222-222222222222";
    const file = "aaaaaaaa-3333-3333-3333-333333333333";
    const user = "aaaaaaaa-4444-4444-4444-444444444444";
    await pg.exec(`
      INSERT INTO office_dallas.deals (id) VALUES ('${deal}');
      INSERT INTO office_dallas.files (id) VALUES ('${file}');
      INSERT INTO office_dallas.field_scorecards (id) VALUES ('${card}');
      INSERT INTO office_dallas.field_scorecard_edit_uploads
        (scorecard_id, deal_id, client_upload_id, uploaded_by, file_id, state)
      VALUES ('${card}', '${deal}', 'client-fk', '${user}', '${file}', 'confirmed');
      DELETE FROM office_dallas.files WHERE id = '${file}';
    `);
    const afterFileDelete = await pg.query(`
      SELECT file_id FROM office_dallas.field_scorecard_edit_uploads WHERE client_upload_id = 'client-fk'
    `);
    expect((afterFileDelete.rows[0] as { file_id: string | null }).file_id).toBeNull();

    await pg.exec(`DELETE FROM office_dallas.field_scorecards WHERE id = '${card}'`);
    const afterCardDelete = await pg.query(`
      SELECT count(*)::int AS count FROM office_dallas.field_scorecard_edit_uploads WHERE client_upload_id = 'client-fk'
    `);
    expect((afterCardDelete.rows[0] as { count: number }).count).toBe(0);
  });
});
