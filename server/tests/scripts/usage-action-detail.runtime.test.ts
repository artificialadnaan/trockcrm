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
    CREATE TABLE office_dallas.deal_stage_history (
      id uuid primary key default gen_random_uuid(),
      deal_id uuid, to_stage_id uuid, changed_by uuid, created_at timestamptz
    );
    CREATE TABLE office_dallas.audit_log (
      id bigserial primary key,
      table_name text, record_id uuid, action text,
      changed_by uuid, impersonator_id uuid,
      entity_type text, entity_name_snapshot text,
      changes jsonb, created_at timestamptz
    );
    -- Notes/uploads are sourced from these tables (NOT audit_log), with the aggregate's crediting +
    -- dating, so the detail reconciles with the leaderboard breakdown. activities.type is a real ENUM
    -- here (as in prod) — a text column would hide the "COALESCE types ... cannot be matched" bug.
    CREATE TYPE office_dallas.activity_type AS ENUM ('call', 'note', 'email', 'meeting');
    CREATE TABLE office_dallas.activities (
      id uuid primary key, type office_dallas.activity_type,
      responsible_user_id uuid, performed_by_user_id uuid,
      deal_id uuid, lead_id uuid, subject text,
      occurred_at timestamptz, created_at timestamptz
    );
    CREATE TABLE office_dallas.files (
      id uuid primary key, display_name text, original_filename text,
      deal_id uuid, lead_id uuid, uploaded_by uuid, created_at timestamptz
    );
  `);
  await db.exec(`
    INSERT INTO office_dallas.deals (id, name) VALUES ('${DEAL1}', 'Tides on Duneville');
    INSERT INTO office_dallas.leads (id, name) VALUES ('${LEAD1}', 'Muir Lake');
  `);
  // All at 2026-06-01 14:00Z (= 09:00 America/Chicago on 06-01).
  const t = "2026-06-01T14:00:00Z";
  // Stage moves are sourced from deal_stage_history (one row per change). The two audit stage rows
  // below (stage_id + stageId for the SAME change) must NOT also count — that was the double-count.
  await db.exec(`
    INSERT INTO office_dallas.deal_stage_history (deal_id, to_stage_id, changed_by, created_at) VALUES
      ('${DEAL1}', '${U("0501")}', '${REP}', '${t}'),
      ('${DEAL1}', '${U("0502")}', '${REP}', '${t}');
  `);
  await db.exec(`
    INSERT INTO office_dallas.audit_log (table_name, record_id, action, changed_by, impersonator_id, changes, entity_name_snapshot, created_at) VALUES
      -- creates (deal + lead inserts, labels via join / snapshot)
      ('deals', '${DEAL1}', 'insert', '${REP}', NULL, NULL, NULL, '${t}'),
      ('leads', '${LEAD1}', 'insert', '${REP}', NULL, NULL, NULL, '${t}'),
      -- edit (deal update, non-stage)
      ('deals', '${DEAL1}', 'update', '${REP}', NULL, '{"awarded_amount":{"old":"1","new":"2"}}'::jsonb, NULL, '${t}'),
      -- stage moves (snake + camel) — audit rows that must NOT count (sourced from stage history)
      ('deals', '${DEAL1}', 'update', '${REP}', NULL, '{"stage_id":{"old":"a","new":"b"}}'::jsonb, NULL, '${t}'),
      ('deals', '${DEAL1}', 'update', '${REP}', NULL, '{"stageId":{"from":"A","to":"B"}}'::jsonb, NULL, '${t}'),
      -- audit rows touching the activity/file — these must NOT feed notes/uploads anymore
      ('activities', '${U("0ac1")}', 'insert', '${REP}', NULL, NULL, 'audit-note', '${t}'),
      ('files', '${U("0f11")}', 'update', '${REP}', NULL, '{"display_name":{"old":"a","new":"b"}}'::jsonb, 'audit-file', '${t}'),
      -- EXCLUDED: impersonated deal insert (admin acting as rep)
      ('deals', '${U("0de2")}', 'insert', '${REP}', '${ADMIN}', NULL, NULL, '${t}')
  `);
  // Notes from the activities table — aggregate crediting (COALESCE performed_by/responsible) + dating
  // (COALESCE occurred_at/created_at). Two count for REP; the wrong-user and out-of-range ones do not.
  await db.exec(`
    INSERT INTO office_dallas.activities (id, type, responsible_user_id, performed_by_user_id, deal_id, lead_id, subject, occurred_at, created_at) VALUES
      -- A: performed_by REP (credited even though the audit row for this activity has no REP-only signal) -> counts
      ('${U("0ac1")}', 'call', '${ADMIN}', '${REP}', '${DEAL1}', NULL, 'Logged call', '${t}', '${t}'),
      -- B: performed_by NULL, responsible REP (COALESCE crediting) -> counts. NULL subject + no
      -- deal/lead, so the label falls through to a.type::text — exercises the enum cast in COALESCE.
      ('${U("0ac2")}', 'note', '${REP}', NULL, NULL, NULL, NULL, '${t}', '${t}'),
      -- C: performed_by ADMIN -> wrong user, excluded
      ('${U("0ac3")}', 'call', '${ADMIN}', '${ADMIN}', '${DEAL1}', NULL, 'Admin call', '${t}', '${t}'),
      -- D: occurred_at out of range (dated by occurred_at, NOT created_at) -> excluded
      ('${U("0ac4")}', 'note', '${REP}', '${REP}', NULL, NULL, 'Backdated', '2026-06-03T14:00:00Z', '${t}')
  `);
  // Uploads from the files table — credited by uploaded_by, dated by created_at.
  await db.exec(`
    INSERT INTO office_dallas.files (id, display_name, original_filename, deal_id, lead_id, uploaded_by, created_at) VALUES
      ('${U("0f11")}', 'photo.jpg', 'IMG_0001.jpg', '${DEAL1}', NULL, '${REP}', '${t}'),
      -- wrong user -> excluded
      ('${U("0f12")}', 'admin.jpg', 'IMG_0002.jpg', '${DEAL1}', NULL, '${ADMIN}', '${t}')
  `);
});

afterAll(async () => { await db?.close(); });

describe("readActionDetail", () => {
  it("breakdown reconciles with the aggregate: each bucket from the aggregate's source table", async () => {
    const detail = await readActionDetail(client(), "office_dallas", REP, "2026-06-01", "2026-06-02");
    expect(detail.breakdown).toEqual({
      create: 2, // deal insert + lead insert (impersonated deal insert excluded)
      edit: 1, // deal update (non-stage)
      stage_move: 2, // from deal_stage_history (NOT the 2 audit stage rows — no double-count)
      upload: 1, // files table, uploaded_by REP (ADMIN's file excluded)
      note: 2, // activities table, COALESCE(performed_by, responsible)=REP (A + B; ADMIN's + backdated excluded)
    });
    // 2 creates + 1 edit + 2 stage + 1 upload + 2 notes = 8.
    expect(detail.items).toHaveLength(8);
    expect(detail.truncated).toBe(false);
  });

  it("sources notes/uploads from activities/files (aggregate crediting + dating), NOT audit rows", async () => {
    const detail = await readActionDetail(client(), "office_dallas", REP, "2026-06-01", "2026-06-02");
    // The note credited by performed_by_user_id (label from subject) appears...
    expect(detail.items.some((i) => i.type === "note" && i.label === "Logged call")).toBe(true);
    // ...and the COALESCE-credited note with no subject/deal/lead falls through to the enum type,
    // cast to text — i.e. the query plans against a real enum (the regression that 500'd prod).
    expect(detail.items.some((i) => i.type === "note" && i.label === "note")).toBe(true);
    // ...the upload comes from files.display_name (not the audit 'audit-file' snapshot)...
    expect(detail.items.some((i) => i.type === "upload" && i.label === "photo.jpg")).toBe(true);
    // ...and the audit metadata snapshots never leak into the detail.
    expect(detail.items.some((i) => i.label === "audit-note" || i.label === "audit-file")).toBe(false);
  });

  it("labels deals via the join fallback (trigger rows have no snapshot)", async () => {
    const detail = await readActionDetail(client(), "office_dallas", REP, "2026-06-01", "2026-06-02");
    expect(detail.items.some((i) => i.label === "Tides on Duneville")).toBe(true);
  });

  it("returns nothing for a period with no actions", async () => {
    const detail = await readActionDetail(client(), "office_dallas", REP, "2026-06-08", "2026-06-09");
    expect(detail.items).toHaveLength(0);
    expect(detail.breakdown).toEqual({ create: 0, edit: 0, stage_move: 0, upload: 0, note: 0 });
  });
});
