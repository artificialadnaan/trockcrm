import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readActionDetail } from "../../src/modules/usage/read-service.js";

const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const REP = U("0001");
const ADMIN = U("00ad");
const DEAL1 = U("0de1");
const LEAD1 = U("01ea");

let db: PGlite;
const client = () => ({ query: (sql: string, params?: unknown[]) => db.query(sql, params as any[]) }) as any;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE SCHEMA office_dallas;
    CREATE TABLE office_dallas.deals (id uuid primary key, name text);
    CREATE TABLE office_dallas.leads (id uuid primary key, name text);
    CREATE TABLE office_dallas.audit_log (
      id bigserial primary key,
      table_name text, record_id uuid, action text,
      changed_by uuid, impersonator_id uuid,
      entity_type text, entity_name_snapshot text,
      changes jsonb, created_at timestamptz
    );
  `);
  await db.exec(`
    INSERT INTO office_dallas.deals (id, name) VALUES ('${DEAL1}', 'Tides on Duneville');
    INSERT INTO office_dallas.leads (id, name) VALUES ('${LEAD1}', 'Muir Lake');
  `);
  // All at 2026-06-01 14:00Z (= 09:00 America/Chicago on 06-01).
  const t = "2026-06-01T14:00:00Z";
  await db.exec(`
    INSERT INTO office_dallas.audit_log (table_name, record_id, action, changed_by, impersonator_id, changes, entity_name_snapshot, created_at) VALUES
      -- creates (deal + lead inserts, labels via join / snapshot)
      ('deals', '${DEAL1}', 'insert', '${REP}', NULL, NULL, NULL, '${t}'),
      ('leads', '${LEAD1}', 'insert', '${REP}', NULL, NULL, NULL, '${t}'),
      -- edit (deal update, non-stage)
      ('deals', '${DEAL1}', 'update', '${REP}', NULL, '{"awarded_amount":{"old":"1","new":"2"}}'::jsonb, NULL, '${t}'),
      -- stage moves (snake + camel)
      ('deals', '${DEAL1}', 'update', '${REP}', NULL, '{"stage_id":{"old":"a","new":"b"}}'::jsonb, NULL, '${t}'),
      ('deals', '${DEAL1}', 'update', '${REP}', NULL, '{"stageId":{"from":"A","to":"B"}}'::jsonb, NULL, '${t}'),
      -- note (activity insert) + EXCLUDED activity update
      ('activities', '${U("0ac1")}', 'insert', '${REP}', NULL, NULL, 'Logged call', '${t}'),
      ('activities', '${U("0ac1")}', 'update', '${REP}', NULL, '{"notes":{"old":"x","new":"y"}}'::jsonb, 'Logged call', '${t}'),
      -- upload (file insert) + EXCLUDED file update
      ('files', '${U("0f11")}', 'insert', '${REP}', NULL, NULL, 'photo.jpg', '${t}'),
      ('files', '${U("0f11")}', 'update', '${REP}', NULL, '{"display_name":{"old":"a","new":"b"}}'::jsonb, 'photo.jpg', '${t}'),
      -- EXCLUDED: impersonated deal insert (admin acting as rep)
      ('deals', '${U("0de2")}', 'insert', '${REP}', '${ADMIN}', NULL, NULL, '${t}')
  `);
});

afterAll(async () => { await db?.close(); });

describe("readActionDetail", () => {
  it("breakdown matches the aggregate semantics: impersonated + activity/file updates excluded", async () => {
    const detail = await readActionDetail(client(), "office_dallas", REP, "2026-06-01", "2026-06-02");
    expect(detail.breakdown).toEqual({
      create: 2, // deal insert + lead insert (impersonated deal insert excluded)
      edit: 1, // deal update (non-stage)
      stage_move: 2, // stage_id + stageId
      upload: 1, // file INSERT only (file update excluded)
      note: 1, // activity INSERT only (activity update excluded)
    });
    // 7 real actions; impersonated + the two metadata updates are gone.
    expect(detail.items).toHaveLength(7);
    expect(detail.truncated).toBe(false);
  });

  it("labels deals via the join fallback (trigger rows have no snapshot)", async () => {
    const detail = await readActionDetail(client(), "office_dallas", REP, "2026-06-01", "2026-06-02");
    expect(detail.items.some((i) => i.label === "Tides on Duneville")).toBe(true);
    expect(detail.items.some((i) => i.label === "Logged call")).toBe(true);
  });

  it("returns nothing for a period with no audit rows", async () => {
    const detail = await readActionDetail(client(), "office_dallas", REP, "2026-06-05", "2026-06-06");
    expect(detail.items).toHaveLength(0);
    expect(detail.breakdown).toEqual({ create: 0, edit: 0, stage_move: 0, upload: 0, note: 0 });
  });
});
