// server/tests/scripts/usage-raw-fetch.runtime.test.ts
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchRawUsageForDay } from "../../src/modules/usage/raw-fetch.js";

const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const REP = U("0001");
let db: PGlite;
const client = () => ({ query: (sql: string, params?: unknown[]) => db.query(sql, params as any[]) }) as any;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE SCHEMA office_dallas;
    SET search_path TO office_dallas, public;
    CREATE TABLE office_dallas.usage_session (id uuid primary key default gen_random_uuid(), user_id uuid, started_at timestamptz, last_heartbeat_at timestamptz, ended_at timestamptz, active_seconds int default 0, user_agent text, impersonator_id uuid, created_at timestamptz default now());
    CREATE TABLE office_dallas.usage_heartbeat (id bigserial primary key, session_id uuid, user_id uuid, at timestamptz);
    CREATE TABLE office_dallas.usage_view_event (id bigserial primary key, user_id uuid, session_id uuid, at timestamptz, entity_type text, entity_id uuid, route text, label_snapshot text);
    CREATE TABLE office_dallas.audit_log (id bigserial primary key, table_name text, action text, changed_by uuid, impersonator_id uuid, changes jsonb, created_at timestamptz);
    CREATE TABLE office_dallas.deal_stage_history (id uuid primary key default gen_random_uuid(), deal_id uuid, to_stage_id uuid, changed_by uuid, created_at timestamptz);
    CREATE TABLE office_dallas.activities (id uuid primary key default gen_random_uuid(), type text, responsible_user_id uuid, performed_by_user_id uuid, occurred_at timestamptz, created_at timestamptz);
    CREATE TABLE office_dallas.files (id uuid primary key default gen_random_uuid(), uploaded_by uuid, created_at timestamptz);
  `);
  const s1 = U("00a1");
  await db.exec(`
    INSERT INTO office_dallas.usage_session (id, user_id, impersonator_id) VALUES ('${s1}', '${REP}', NULL);
    INSERT INTO office_dallas.usage_heartbeat (session_id, user_id, at) VALUES ('${s1}', '${REP}', '2026-06-01T14:00:30Z');
    INSERT INTO office_dallas.usage_view_event (user_id, session_id, at, entity_type, route) VALUES ('${REP}', '${s1}', '2026-06-01T14:00:31Z', 'deal', '/deals/x');
    INSERT INTO office_dallas.audit_log (table_name, action, changed_by, impersonator_id, created_at) VALUES ('deals', 'insert', '${REP}', NULL, '2026-06-01T13:00:00Z');
    INSERT INTO office_dallas.deal_stage_history (deal_id, to_stage_id, changed_by, created_at) VALUES ('${U("0dd1")}', '${U("0501")}', '${REP}', '2026-06-01T13:10:00Z');
    INSERT INTO office_dallas.activities (type, responsible_user_id, occurred_at, created_at) VALUES ('note', '${REP}', '2026-06-01T13:20:00Z', '2026-06-01T13:20:00Z');
    INSERT INTO office_dallas.files (uploaded_by, created_at) VALUES ('${REP}', '2026-06-01T13:30:00Z');
  `);
});

afterAll(async () => { await db?.close(); });

describe("fetchRawUsageForDay", () => {
  it("returns all raw rows for the user+day across the six sources", async () => {
    const raw = await fetchRawUsageForDay(client(), "office_dallas", REP, "2026-06-01");
    expect(raw.sessions).toHaveLength(1);
    expect(raw.heartbeats).toHaveLength(1);
    expect(raw.viewEvents).toHaveLength(1);
    expect(raw.auditRows).toHaveLength(1);
    expect(raw.stageMoves).toHaveLength(1);
    expect(raw.activities).toHaveLength(1);
    expect(raw.uploads).toHaveLength(1);
  });

  it("excludes rows from other days", async () => {
    const raw = await fetchRawUsageForDay(client(), "office_dallas", REP, "2026-06-02");
    expect(raw.heartbeats).toHaveLength(0);
    expect(raw.auditRows).toHaveLength(0);
  });

  it("excludes audit_log rows for 'activities' and 'files' tables (double-count guard)", async () => {
    // Simulates what audit_activities/audit_files DB triggers produce: every insert into
    // activities/files also writes a row to audit_log. Without the exclusion, one logged
    // activity would be counted twice (once via the activities bucket, once via auditRows).
    const REP_DC = U("0020");
    await db.exec(`
      -- (a) real activities row
      INSERT INTO office_dallas.activities (type, responsible_user_id, occurred_at, created_at)
        VALUES ('call', '${REP_DC}', '2026-06-05T09:00:00Z', '2026-06-05T09:00:00Z');
      -- (b) real files row
      INSERT INTO office_dallas.files (uploaded_by, created_at)
        VALUES ('${REP_DC}', '2026-06-05T09:05:00Z');
      -- (c) audit_log rows that the triggers would insert (must be excluded)
      INSERT INTO office_dallas.audit_log (table_name, action, changed_by, impersonator_id, created_at)
        VALUES ('activities', 'insert', '${REP_DC}', NULL, '2026-06-05T09:00:00Z');
      INSERT INTO office_dallas.audit_log (table_name, action, changed_by, impersonator_id, created_at)
        VALUES ('files', 'insert', '${REP_DC}', NULL, '2026-06-05T09:05:00Z');
      -- (d) genuine audit_log row for a non-bucket table (must be included)
      INSERT INTO office_dallas.audit_log (table_name, action, changed_by, impersonator_id, created_at)
        VALUES ('deals', 'insert', '${REP_DC}', NULL, '2026-06-05T09:10:00Z');
    `);
    const raw = await fetchRawUsageForDay(client(), "office_dallas", REP_DC, "2026-06-05");
    // Only the 'deals' audit row survives; the activities/files trigger rows are excluded
    expect(raw.auditRows).toHaveLength(1);
    expect(raw.auditRows[0].tableName).toBe("deals");
    // Dedicated buckets still count them once each
    expect(raw.activities).toHaveLength(1);
    expect(raw.uploads).toHaveLength(1);
  });

  it("excludes deal audit UPDATE rows whose changes contain stage_id (counted once via stageMoves, not double-counted as edits)", async () => {
    const REP_SM = U("0030");
    await db.exec(`
      -- (a) deal_stage_history row — counted as a stage move
      INSERT INTO office_dallas.deal_stage_history (deal_id, to_stage_id, changed_by, created_at)
        VALUES ('${U("0dd9")}', '${U("0509")}', '${REP_SM}', '2026-06-07T10:00:00Z');
      -- (b) audit_log UPDATE row for the same stage change (changes includes stage_id) — must be excluded from auditRows
      INSERT INTO office_dallas.audit_log (table_name, action, changed_by, impersonator_id, changes, created_at)
        VALUES ('deals', 'update', '${REP_SM}', NULL, '{"stage_id":{"old":"${U("0501")}","new":"${U("0502")}"}}'::jsonb, '2026-06-07T10:00:00Z');
      -- (c) genuine non-stage deal edit (changes does NOT include stage_id) — must appear in auditRows
      INSERT INTO office_dallas.audit_log (table_name, action, changed_by, impersonator_id, changes, created_at)
        VALUES ('deals', 'update', '${REP_SM}', NULL, '{"awarded_amount":{"old":"1","new":"2"}}'::jsonb, '2026-06-07T10:05:00Z');
    `);
    const raw = await fetchRawUsageForDay(client(), "office_dallas", REP_SM, "2026-06-07");
    // Stage-only deal update excluded from auditRows; genuine edit included
    expect(raw.auditRows).toHaveLength(1);
    expect(raw.auditRows[0].tableName).toBe("deals");
    // Stage move is counted exactly once via stageMoves
    expect(raw.stageMoves).toHaveLength(1);
  });

  it("credits the performer (performed_by_user_id), not the assignee (responsible_user_id)", async () => {
    const REP_ACTOR = U("0010");
    const REP_ASSIGNEE = U("0011");
    await db.exec(
      `INSERT INTO office_dallas.activities (type, responsible_user_id, performed_by_user_id, occurred_at, created_at)
       VALUES ('call', '${REP_ASSIGNEE}', '${REP_ACTOR}', '2026-06-03T10:00:00Z', '2026-06-03T10:00:00Z')`,
    );
    const actorResult = await fetchRawUsageForDay(client(), "office_dallas", REP_ACTOR, "2026-06-03");
    expect(actorResult.activities).toHaveLength(1);
    const assigneeResult = await fetchRawUsageForDay(client(), "office_dallas", REP_ASSIGNEE, "2026-06-03");
    expect(assigneeResult.activities).toHaveLength(0);
  });
});
