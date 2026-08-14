// Proves the Drizzle-derived test schema is prod-accurate where the hand-rolled DDL was not (#677).
// The meta-tests at the bottom are the point of the PR: the #674 enum mismatch that shipped past a
// green gate is now caught, because the test schema carries the REAL enum (not a hand-picked subset
// or a `text` column).
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ACTIVITY_TYPES, AUDIT_ACTIONS, NOTIFICATION_TYPES } from "@trock-crm/shared/types";
import { activities, auditLog, files, leads, notifications, pipelineStageConfig, usageDaily } from "@trock-crm/shared/schema";
import { tenantSchemaSql } from "./tenant-schema-from-drizzle.js";

const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const REP = U("0001");

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(tenantSchemaSql("office_dallas", [activities, auditLog, usageDaily]));
}, 60_000); // hook headroom for the Drizzle-derived schema build under parallel CI contention (Codex #715)
afterAll(async () => {
  await db?.close();
});

describe("tenantSchemaSql — schema fidelity from Drizzle", () => {
  it("emits the activity_type enum in public with EVERY real ACTIVITY_TYPES value (not a hand-picked subset)", async () => {
    // Created in `public` to match prod's namespace (audit_action/activity_type live in public, not
    // the tenant schema) — verified via the n.nspname = 'public' join.
    const { rows } = await db.query<{ enumlabel: string }>(
      `SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
       JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE t.typname = 'activity_type' AND n.nspname = 'public' ORDER BY e.enumsortorder`,
    );
    expect(rows.map((r) => r.enumlabel)).toEqual([...ACTIVITY_TYPES]);
  });

  it("emits the audit_action enum in public from AUDIT_ACTIONS", async () => {
    const { rows } = await db.query<{ enumlabel: string }>(
      `SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
       JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE t.typname = 'audit_action' AND n.nspname = 'public' ORDER BY e.enumsortorder`,
    );
    expect(rows.map((r) => r.enumlabel)).toEqual([...AUDIT_ACTIONS]);
  });

  it("emits notification_type from EVERY shared NOTIFICATION_TYPES value", async () => {
    const ndb = new PGlite();
    try {
      await ndb.exec(tenantSchemaSql("office_dallas", [notifications]));
      const { rows } = await ndb.query<{ enumlabel: string }>(
        "SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid " +
          "JOIN pg_namespace n ON n.oid = t.typnamespace " +
          "WHERE t.typname = 'notification_type' AND n.nspname = 'public' ORDER BY e.enumsortorder",
      );
      expect(rows.map((r) => r.enumlabel)).toEqual([...NOTIFICATION_TYPES]);

      await expect(
        ndb.exec(
          "INSERT INTO office_dallas.notifications (id, user_id, type, title) " +
            "VALUES ('" + U("0a11") + "', '" + REP + "', 'won_metric_decrease', 'Won metric reduced')",
        ),
      ).resolves.toBeDefined();
    } finally {
      await ndb.close();
    }
  }, 60_000);

  it("places a tenant-scoped enum (lead_office) in the tenant schema, not public (Codex/CodeRabbit #715)", async () => {
    // Prod-verified: lead_office lives per office_* schema, while audit_action lives in public. The
    // helper must NOT collapse both into one shared public type. Build the leads table (uses
    // lead_office) in a fresh DB and confirm lead_office landed in office_dallas, audit_action in public.
    const ldb = new PGlite();
    try {
      await ldb.exec(tenantSchemaSql("office_dallas", [leads, auditLog]));
      const ns = async (typname: string) =>
        (
          await ldb.query<{ nspname: string }>(
            `SELECT n.nspname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE t.typname = $1`,
            [typname],
          )
        ).rows.map((r) => r.nspname);
      expect(await ns("lead_office")).toEqual(["office_dallas"]);
      expect(await ns("audit_action")).toEqual(["public"]);
    } finally {
      await ldb.close();
    }
  }, 60_000);

  it("round-trips array-typed column defaults: jsonb-array and text[] (renderDefault edge cases, #715)", async () => {
    // jsonb columns whose Drizzle default is a JS array must serialize as a JSON literal, NOT a PG
    // array literal — the exact bug that surfaced building this helper. pipeline_stage_config has both
    // an empty jsonb-array default (required_fields) and an array-of-objects one (stale_escalation_tiers).
    const pdb = new PGlite();
    try {
      await pdb.exec(tenantSchemaSql("public", [pipelineStageConfig]));
      await pdb.exec(
        `INSERT INTO public.pipeline_stage_config (id, name, slug, display_order)
         VALUES (gen_random_uuid(), 'Opportunity', 'opportunity', 1)`,
      );
      const { rows } = await pdb.query<{ required_fields: unknown; stale_escalation_tiers: unknown }>(
        `SELECT required_fields, stale_escalation_tiers FROM public.pipeline_stage_config`,
      );
      expect(rows[0].required_fields).toEqual([]); // jsonb default []
      expect(rows[0].stale_escalation_tiers).toEqual([
        { days: 30, severity: "warning" },
        { days: 60, severity: "escalation" },
        { days: 90, severity: "critical" },
      ]); // jsonb array-of-objects default
    } finally {
      await pdb.close();
    }

    // text[] default must serialize as a PG array literal '{}', NOT JSON '[]'.
    const fdb = new PGlite();
    try {
      await fdb.exec(tenantSchemaSql("office_dallas", [files]));
      await fdb.exec(
        `INSERT INTO office_dallas.files
         (id, category, display_name, system_filename, original_filename, mime_type, file_size_bytes, file_extension, r2_key, r2_bucket, uploaded_by)
         VALUES (gen_random_uuid(), 'photo', 'p.jpg', 's.jpg', 'IMG.jpg', 'image/jpeg', 1, 'jpg', 'k', 'b', '${REP}')`,
      );
      const { rows } = await fdb.query<{ tags: unknown }>(`SELECT tags FROM office_dallas.files`);
      expect(rows[0].tags).toEqual([]); // text[] default []
    } finally {
      await fdb.close();
    }
  }, 60_000);

  it("reproduces NOT NULL constraints (audit_log.record_id is NOT NULL, as in prod)", async () => {
    await expect(
      db.exec(`INSERT INTO office_dallas.audit_log (table_name, action) VALUES ('deals', 'insert')`),
    ).rejects.toThrow(/null value in column "record_id"/i);
  });

  it("reproduces composite primary keys (usage_daily on user_id + date)", async () => {
    const breakdown = `'{}'::jsonb`;
    await db.exec(
      `INSERT INTO office_dallas.usage_daily (user_id, date, breakdown) VALUES ('${REP}', '2026-06-01', ${breakdown})`,
    );
    await expect(
      db.exec(
        `INSERT INTO office_dallas.usage_daily (user_id, date, breakdown) VALUES ('${REP}', '2026-06-01', ${breakdown})`,
      ),
    ).rejects.toThrow(/duplicate key|unique/i);
  });
});

describe("META: the #674 bug class is now caught at the gate", () => {
  it("the real audit_action enum REJECTS a value the hand-rolled `text` column accepted", async () => {
    // Under the old hand-rolled `action text` schema this INSERT succeeded and the bug shipped.
    await expect(
      db.exec(
        `INSERT INTO office_dallas.audit_log (table_name, record_id, action) VALUES ('deals', '${U("0de1")}', 'not_a_real_action')`,
      ),
    ).rejects.toThrow(/invalid input value for enum/i);
  });

  it("activities.type accepts ALL 13 real ACTIVITY_TYPES (the 4-value hand-rolled enum would reject 9)", async () => {
    for (const type of ACTIVITY_TYPES) {
      await db.exec(
        `INSERT INTO office_dallas.activities (type, responsible_user_id, source_entity_type, source_entity_id)
         VALUES ('${type}', '${REP}', 'deal', '${U("0de1")}')`,
      );
    }
    const { rows } = await db.query<{ n: number }>(
      `SELECT count(DISTINCT type)::int AS n FROM office_dallas.activities`,
    );
    expect(rows[0].n).toBe(ACTIVITY_TYPES.length);
  });
});
