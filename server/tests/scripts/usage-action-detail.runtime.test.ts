import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activities,
  auditLog,
  contacts,
  dealStageHistory,
  deals,
  emails,
  files,
  leads,
  pipelineStageConfig,
  tasks,
} from "@trock-crm/shared/schema";
import { readActionDetail } from "../../src/modules/usage/read-service.js";
import { tenantSchemaSql } from "../helpers/tenant-schema-from-drizzle.js";

const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const REP = U("0001");
const ADMIN = U("00ad");
const DEAL1 = U("0de1");
const LEAD1 = U("01ea");
const TASK1 = U("07a1");
const TASK_ORPHAN = U("07a9"); // audited but no live row (deleted) -> graceful fallback
const CONTACT1 = U("0c01");
const EMAIL1 = U("0e11");
const STG_OPP = U("0500"); // from stage
const STG_EST = U("0501"); // to stage (move 1)
const STG_WON = U("0502"); // to stage (move 2, no from)

let db: PGlite;
const client = () => ({ query: (sql: string, params?: unknown[]) => db.query(sql, params as any[]) }) as any;

beforeAll(async () => {
  db = new PGlite();
  // Schema is generated from the REAL Drizzle table definitions (#677) — activities.type is the full
  // 13-value activity_type enum and audit_log.action is the real audit_action enum, BY CONSTRUCTION,
  // not a hand-picked subset that can drift from prod. FKs/indexes are omitted (types are the point).
  await db.exec(
    tenantSchemaSql("office_dallas", [
      deals,
      leads,
      dealStageHistory,
      auditLog,
      tasks,
      contacts,
      emails,
      activities,
      files,
    ]),
  );
  await db.exec(tenantSchemaSql("public", [pipelineStageConfig]));
  // Inserts now satisfy the real NOT NULL columns (deal_number/stage_id, the lead/email/file required
  // sets, activities.source_entity_*) — i.e. prod-valid rows. Columns the read path doesn't touch are
  // filled with minimal valid values; the label-resolution columns (name/title/subject) are unchanged.
  await db.exec(`
    INSERT INTO office_dallas.deals (id, deal_number, name, stage_id) VALUES ('${DEAL1}', 'D-1', 'Tides on Duneville', '${STG_OPP}');
    INSERT INTO office_dallas.leads (id, company_id, property_id, name, stage_id, assigned_rep_id, office_code, office)
      VALUES ('${LEAD1}', '${U("0c0a")}', '${U("0b0a")}', 'Muir Lake', '${STG_OPP}', '${REP}', 'dallas', 'dfw');
    -- live entities whose create-audit rows resolve a real label by record_id (no snapshot stored)
    INSERT INTO office_dallas.tasks (id, title, type, assigned_to, deal_id) VALUES ('${TASK1}', 'Follow up with Hayward', 'manual', '${REP}', '${DEAL1}');
    INSERT INTO office_dallas.contacts (id, first_name, last_name, category) VALUES ('${CONTACT1}', 'Jessica', 'Stanley', 'client');
    INSERT INTO office_dallas.emails (id, subject, graph_message_id, direction, from_address, to_addresses, user_id, sent_at)
      VALUES ('${EMAIL1}', 'RE: window sealant', 'gmsg-1', 'inbound', 'a@b.com', ARRAY['c@d.com'], '${REP}', '${"2026-06-01T14:00:00Z"}');
    INSERT INTO public.pipeline_stage_config (id, name, slug, display_order) VALUES
      ('${STG_OPP}', 'Opportunity', 'opportunity', 1), ('${STG_EST}', 'Estimate', 'estimate', 2), ('${STG_WON}', 'Won', 'won', 3);
  `);
  // All at 2026-06-01 14:00Z (= 09:00 America/Chicago on 06-01).
  const t = "2026-06-01T14:00:00Z";
  // Stage moves are sourced from deal_stage_history (one row per change). The two audit stage rows
  // below (stage_id + stageId for the SAME change) must NOT also count — that was the double-count.
  // Move 1 has a from-stage (Opportunity -> Estimate); move 2 is an initial entry (NULL from -> Won).
  await db.exec(`
    INSERT INTO office_dallas.deal_stage_history (deal_id, from_stage_id, to_stage_id, changed_by, created_at) VALUES
      ('${DEAL1}', '${STG_OPP}', '${STG_EST}', '${REP}', '${t}'),
      ('${DEAL1}', NULL, '${STG_WON}', '${REP}', '${t}');
  `);
  await db.exec(`
    INSERT INTO office_dallas.audit_log (table_name, record_id, action, changed_by, impersonator_id, changes, entity_name_snapshot, created_at) VALUES
      -- creates (deal + lead inserts, labels via join / snapshot)
      ('deals', '${DEAL1}', 'insert', '${REP}', NULL, NULL, NULL, '${t}'),
      ('leads', '${LEAD1}', 'insert', '${REP}', NULL, NULL, NULL, '${t}'),
      -- create rows whose audit carries NO name snapshot -> resolved by joining the live entity
      ('tasks', '${TASK1}', 'insert', '${REP}', NULL, NULL, NULL, '${t}'),
      ('contacts', '${CONTACT1}', 'insert', '${REP}', NULL, NULL, NULL, '${t}'),
      ('emails', '${EMAIL1}', 'insert', '${REP}', NULL, NULL, NULL, '${t}'),
      -- a task create whose live row is gone (deleted) -> graceful fallback to the type ('tasks')
      ('tasks', '${TASK_ORPHAN}', 'insert', '${REP}', NULL, NULL, NULL, '${t}'),
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
    INSERT INTO office_dallas.activities (id, type, source_entity_type, source_entity_id, responsible_user_id, performed_by_user_id, deal_id, lead_id, subject, occurred_at, created_at) VALUES
      -- A: performed_by REP (credited even though the audit row for this activity has no REP-only signal) -> counts
      ('${U("0ac1")}', 'call', 'deal', '${DEAL1}', '${ADMIN}', '${REP}', '${DEAL1}', NULL, 'Logged call', '${t}', '${t}'),
      -- B: performed_by NULL, responsible REP (COALESCE crediting) -> counts. NULL subject + no
      -- deal/lead, so the label falls through to a.type::text — exercises the enum cast in COALESCE.
      ('${U("0ac2")}', 'note', 'deal', '${DEAL1}', '${REP}', NULL, NULL, NULL, NULL, '${t}', '${t}'),
      -- C: performed_by ADMIN -> wrong user, excluded
      ('${U("0ac3")}', 'call', 'deal', '${DEAL1}', '${ADMIN}', '${ADMIN}', '${DEAL1}', NULL, 'Admin call', '${t}', '${t}'),
      -- D: occurred_at out of range (dated by occurred_at, NOT created_at) -> excluded
      ('${U("0ac4")}', 'note', 'deal', '${DEAL1}', '${REP}', '${REP}', NULL, NULL, 'Backdated', '2026-06-03T14:00:00Z', '${t}')
  `);
  // Uploads from the files table — credited by uploaded_by, dated by created_at.
  await db.exec(`
    INSERT INTO office_dallas.files (id, category, display_name, system_filename, original_filename, mime_type, file_size_bytes, file_extension, r2_key, r2_bucket, deal_id, lead_id, uploaded_by, created_at) VALUES
      ('${U("0f11")}', 'photo', 'photo.jpg', 'sys_0001.jpg', 'IMG_0001.jpg', 'image/jpeg', 1024, 'jpg', 'r2/0001', 'trock-files', '${DEAL1}', NULL, '${REP}', '${t}'),
      -- wrong user -> excluded
      ('${U("0f12")}', 'photo', 'admin.jpg', 'sys_0002.jpg', 'IMG_0002.jpg', 'image/jpeg', 1024, 'jpg', 'r2/0002', 'trock-files', '${DEAL1}', NULL, '${ADMIN}', '${t}')
  `);
});

afterAll(async () => { await db?.close(); });

describe("readActionDetail", () => {
  it("breakdown reconciles with the aggregate: each bucket from the aggregate's source table", async () => {
    const detail = await readActionDetail(client(), "office_dallas", REP, "2026-06-01", "2026-06-02");
    expect(detail.breakdown).toEqual({
      create: 6, // deal + lead + task + contact + email + orphan-task inserts (impersonated excluded)
      edit: 1, // deal update (non-stage)
      stage_move: 2, // from deal_stage_history (NOT the 2 audit stage rows — no double-count)
      upload: 1, // files table, uploaded_by REP (ADMIN's file excluded)
      note: 2, // activities table, COALESCE(performed_by, responsible)=REP (A + B; ADMIN's + backdated excluded)
    });
    // 6 creates + 1 edit + 2 stage + 1 upload + 2 notes = 12.
    expect(detail.items).toHaveLength(12);
    expect(detail.truncated).toBe(false);
  });

  it("resolves a specific per-entity label for each create (not the bare entity type)", async () => {
    const detail = await readActionDetail(client(), "office_dallas", REP, "2026-06-01", "2026-06-02");
    const label = (type: string, l: string) => detail.items.some((i) => i.type === type && i.label === l);
    expect(label("create", "Follow up with Hayward")).toBe(true); // task.title (was "tasks")
    expect(label("create", "Jessica Stanley")).toBe(true); // contacts first+last
    expect(label("create", "RE: window sealant")).toBe(true); // emails.subject
    expect(label("create", "Tides on Duneville")).toBe(true); // deal name still works
    // Deleted task (no live row) gracefully falls back to the type, never a 500 / blank.
    expect(label("create", "tasks")).toBe(true);
  });

  it("labels stage moves with the deal name + from → to transition", async () => {
    const detail = await readActionDetail(client(), "office_dallas", REP, "2026-06-01", "2026-06-02");
    const stages = detail.items.filter((i) => i.type === "stage_move").map((i) => i.label);
    expect(stages).toContain("Tides on Duneville: Opportunity → Estimate"); // both stages
    expect(stages).toContain("Tides on Duneville: Won"); // initial entry (NULL from)
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
