// server/tests/scripts/usage-raw-fetch.runtime.test.ts
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activities,
  auditLog,
  dealStageHistory,
  files,
  usageHeartbeat,
  usageSession,
  usageViewEvent,
} from "@trock-crm/shared/schema";
import { fetchRawUsageForDay } from "../../src/modules/usage/raw-fetch.js";
import { tenantSchemaSql } from "../helpers/tenant-schema-from-drizzle.js";

const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const REP = U("0001");
// Minimal valid fills for prod NOT NULL columns the raw-fetch path doesn't read (the Drizzle-derived
// schema enforces them, unlike the old hand-rolled DDL). Kept as local constants — not a shared
// factory — so each INSERT stays inline and readable while avoiding copy-paste across many sites.
const REC = U("0d01"); // audit_log.record_id (NOT NULL)
const ACT_SRC_COLS = "source_entity_type, source_entity_id";
const ACT_SRC_VALS = `'deal', '${U("0de1")}'`;
const FILE_COLS =
  "category, display_name, system_filename, original_filename, mime_type, file_size_bytes, file_extension, r2_key, r2_bucket";
const FILE_VALS = "'photo', 'f.jpg', 'sys.jpg', 'IMG.jpg', 'image/jpeg', 1024, 'jpg', 'r2/k', 'trock-files'";
let db: PGlite;
const client = () => ({ query: (sql: string, params?: unknown[]) => db.query(sql, params as any[]) }) as any;

beforeAll(async () => {
  db = new PGlite();
  // Schema from the real Drizzle definitions (#677): audit_log.action / activities.type are the real
  // enums and audit_log.record_id / activities.source_entity_* are NOT NULL, as in prod. FKs/indexes
  // omitted. Inserts below satisfy those required columns with minimal valid values.
  await db.exec(
    tenantSchemaSql("office_dallas", [
      usageSession,
      usageHeartbeat,
      usageViewEvent,
      auditLog,
      dealStageHistory,
      activities,
      files,
    ]),
  );
  await db.exec(`SET search_path TO office_dallas, public;`);
  const s1 = U("00a1");
  await db.exec(`
    INSERT INTO office_dallas.usage_session (id, user_id, impersonator_id) VALUES ('${s1}', '${REP}', NULL);
    INSERT INTO office_dallas.usage_heartbeat (session_id, user_id, at) VALUES ('${s1}', '${REP}', '2026-06-01T14:00:30Z');
    INSERT INTO office_dallas.usage_view_event (user_id, session_id, at, entity_type, route) VALUES ('${REP}', '${s1}', '2026-06-01T14:00:31Z', 'deal', '/deals/x');
    INSERT INTO office_dallas.audit_log (table_name, record_id, action, changed_by, impersonator_id, created_at) VALUES ('deals', '${REC}', 'insert', '${REP}', NULL, '2026-06-01T13:00:00Z');
    INSERT INTO office_dallas.deal_stage_history (deal_id, to_stage_id, changed_by, created_at) VALUES ('${U("0dd1")}', '${U("0501")}', '${REP}', '2026-06-01T13:10:00Z');
    INSERT INTO office_dallas.activities (type, ${ACT_SRC_COLS}, responsible_user_id, occurred_at, created_at) VALUES ('note', ${ACT_SRC_VALS}, '${REP}', '2026-06-01T13:20:00Z', '2026-06-01T13:20:00Z');
    INSERT INTO office_dallas.files (${FILE_COLS}, uploaded_by, created_at) VALUES (${FILE_VALS}, '${REP}', '2026-06-01T13:30:00Z');
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
      INSERT INTO office_dallas.activities (type, ${ACT_SRC_COLS}, responsible_user_id, occurred_at, created_at)
        VALUES ('call', ${ACT_SRC_VALS}, '${REP_DC}', '2026-06-05T09:00:00Z', '2026-06-05T09:00:00Z');
      -- (b) real files row
      INSERT INTO office_dallas.files (${FILE_COLS}, uploaded_by, created_at)
        VALUES (${FILE_VALS}, '${REP_DC}', '2026-06-05T09:05:00Z');
      -- (c) audit_log rows that the triggers would insert (must be excluded)
      INSERT INTO office_dallas.audit_log (table_name, record_id, action, changed_by, impersonator_id, created_at)
        VALUES ('activities', '${REC}', 'insert', '${REP_DC}', NULL, '2026-06-05T09:00:00Z');
      INSERT INTO office_dallas.audit_log (table_name, record_id, action, changed_by, impersonator_id, created_at)
        VALUES ('files', '${REC}', 'insert', '${REP_DC}', NULL, '2026-06-05T09:05:00Z');
      -- (d) genuine audit_log row for a non-bucket table (must be included)
      INSERT INTO office_dallas.audit_log (table_name, record_id, action, changed_by, impersonator_id, created_at)
        VALUES ('deals', '${REC}', 'insert', '${REP_DC}', NULL, '2026-06-05T09:10:00Z');
    `);
    const raw = await fetchRawUsageForDay(client(), "office_dallas", REP_DC, "2026-06-05");
    // Only the 'deals' audit row survives; the activities/files trigger rows are excluded
    expect(raw.auditRows).toHaveLength(1);
    expect(raw.auditRows[0].tableName).toBe("deals");
    // Dedicated buckets still count them once each
    expect(raw.activities).toHaveLength(1);
    expect(raw.uploads).toHaveLength(1);
  });

  it("excludes deal audit UPDATE rows whose changes contain stage_id or stageId (counted once via stageMoves, not double-counted as edits)", async () => {
    const REP_SM = U("0030");
    await db.exec(`
      -- (a) deal_stage_history row — counted as a stage move
      INSERT INTO office_dallas.deal_stage_history (deal_id, to_stage_id, changed_by, created_at)
        VALUES ('${U("0dd9")}', '${U("0509")}', '${REP_SM}', '2026-06-07T10:00:00Z');
      -- (b) trigger-style audit_log row (DB trigger writes snake_case key) — must be excluded
      INSERT INTO office_dallas.audit_log (table_name, record_id, action, changed_by, impersonator_id, changes, created_at)
        VALUES ('deals', '${REC}', 'update', '${REP_SM}', NULL, '{"stage_id":{"old":"${U("0501")}","new":"${U("0502")}"}}'::jsonb, '2026-06-07T10:00:00Z');
      -- (c) explicit logActivity-style audit row (changeDealStage writes camelCase key) — must also be excluded
      INSERT INTO office_dallas.audit_log (table_name, record_id, action, changed_by, impersonator_id, changes, created_at)
        VALUES ('deals', '${REC}', 'update', '${REP_SM}', NULL, '{"stageId":{"from":"A","to":"B"}}'::jsonb, '2026-06-07T10:00:00Z');
      -- (d) genuine non-stage deal edit (changes does NOT include stage_id or stageId) — must appear in auditRows
      INSERT INTO office_dallas.audit_log (table_name, record_id, action, changed_by, impersonator_id, changes, created_at)
        VALUES ('deals', '${REC}', 'update', '${REP_SM}', NULL, '{"awarded_amount":{"old":"1","new":"2"}}'::jsonb, '2026-06-07T10:05:00Z');
    `);
    const raw = await fetchRawUsageForDay(client(), "office_dallas", REP_SM, "2026-06-07");
    // Both stage audit rows (trigger snake_case + explicit camelCase) excluded; only genuine edit remains
    expect(raw.auditRows).toHaveLength(1);
    expect(raw.auditRows[0].tableName).toBe("deals");
    // Stage move is counted exactly once via stageMoves
    expect(raw.stageMoves).toHaveLength(1);
  });

  it("credits the performer (performed_by_user_id), not the assignee (responsible_user_id)", async () => {
    const REP_ACTOR = U("0010");
    const REP_ASSIGNEE = U("0011");
    await db.exec(
      `INSERT INTO office_dallas.activities (type, ${ACT_SRC_COLS}, responsible_user_id, performed_by_user_id, occurred_at, created_at)
       VALUES ('call', ${ACT_SRC_VALS}, '${REP_ASSIGNEE}', '${REP_ACTOR}', '2026-06-03T10:00:00Z', '2026-06-03T10:00:00Z')`,
    );
    const actorResult = await fetchRawUsageForDay(client(), "office_dallas", REP_ACTOR, "2026-06-03");
    expect(actorResult.activities).toHaveLength(1);
    const assigneeResult = await fetchRawUsageForDay(client(), "office_dallas", REP_ASSIGNEE, "2026-06-03");
    expect(assigneeResult.activities).toHaveLength(0);
  });
});
