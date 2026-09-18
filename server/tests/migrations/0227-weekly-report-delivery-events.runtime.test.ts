// Executes migration 0227 FROM DISK against a real Postgres (PGlite).
//
// 0227 has three halves, which is one more than a tenant column-add usually does:
//
//   1. A DO loop adding `send_delivery_status` / `_status_at` / `_detail`, a CHECK and a partial index to
//      every existing `office_*` schema.
//   2. A `TENANT_SCHEMA_START/END` block doing the same, which the office provisioner replays for an
//      office created after this deploy.
//   3. `public.weekly_report_send_deliveries`, which is NOT per-office — it is what lets an unauthenticated
//      webhook resolve a delivery key to a schema at all.
//
// (1) AND (2) ARE ONLY DISTINGUISHABLE BY RUNNING THEM APART, and this is the file that does it. The DO
// loop matches `office_dallas` like any other office, so a suite that runs the whole migration and asserts
// against Dallas stays green with the tenant block DELETED — and every office provisioned after this
// deploy would then silently get 0226's shape, with the failure landing weeks later on the first bounce
// that office cannot record. So the loop is proved by a SECOND office the tenant block never mentions, and
// the tenant block is proved by replaying it ALONE against a fresh schema.

import { beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { migrationSql } from "../helpers/migration-sql.js";

const MIGRATION = "0227_weekly_report_delivery_events";
const COLUMNS = ["send_delivery_status", "send_delivery_status_at", "send_delivery_detail"] as const;
const CHECK = "weekly_reports_send_delivery_status_check";
const INDEX = "weekly_reports_send_delivery_failed_idx";

let pg: PGlite;

/**
 * Named explicitly rather than matched with `LIKE 'send_delivery%'` — that pattern also catches 0226's
 * `send_delivery_key`, which the seed below creates, so every count here would have been one too high and
 * the "adds all three" assertion would have been passing on the wrong set.
 */
async function columnTypes(schema: string): Promise<Record<string, string>> {
  const result = await pg.query<{ column_name: string; data_type: string }>(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'weekly_reports' AND column_name = ANY($2::text[])`,
    [schema, [...COLUMNS]],
  );
  return Object.fromEntries(result.rows.map((row) => [row.column_name, row.data_type]));
}

async function hasConstraint(schema: string, name: string): Promise<boolean> {
  const result = await pg.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = $1 AND t.relname = 'weekly_reports' AND c.conname = $2`,
    [schema, name],
  );
  return (result.rows[0]?.n ?? 0) > 0;
}

async function hasIndex(schema: string, name: string): Promise<boolean> {
  const result = await pg.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM pg_indexes WHERE schemaname = $1 AND indexname = $2`,
    [schema, name],
  );
  return (result.rows[0]?.n ?? 0) > 0;
}

/** The minimum shape 0227 needs: 0222's weekly_reports, in each named office schema. */
async function seedOffices(schemas: string[]) {
  for (const schema of schemas) {
    await pg.exec(`
      CREATE SCHEMA IF NOT EXISTS ${schema};
      CREATE TABLE ${schema}.weekly_reports (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        weekly_report_project_id uuid,
        week_of date,
        status text,
        is_active boolean NOT NULL DEFAULT true,
        send_delivered_at timestamptz,
        send_delivery_key uuid,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `);
  }
}

/** The block the office provisioner replays, lifted out exactly as the provisioner lifts it. */
function tenantBlock(forSchema = "office_dallas"): string {
  const raw = migrationSql(MIGRATION);
  const block = raw.split("-- TENANT_SCHEMA_START")[1]?.split("-- TENANT_SCHEMA_END")[0];
  expect(block, "TENANT_SCHEMA_START/END markers must be present").toBeTruthy();
  // The provisioner's own substitution: `tenantSql.replace(/office_dallas/g, schemaName)`.
  return block!.replace(/office_dallas/g, forSchema);
}

beforeEach(async () => {
  pg = new PGlite();
});

describe("migration 0227 — the delivery verdict columns", () => {
  it("adds all three columns to EVERY office schema, not just Dallas", async () => {
    await seedOffices(["office_dallas", "office_atlanta"]);
    await pg.exec(migrationSql(MIGRATION));

    for (const schema of ["office_dallas", "office_atlanta"]) {
      const types = await columnTypes(schema);
      expect(Object.keys(types).sort(), schema).toEqual([...COLUMNS].sort());
      expect(types.send_delivery_status).toBe("text");
      expect(types.send_delivery_status_at).toBe("timestamp with time zone");
      expect(types.send_delivery_detail).toBe("jsonb");
      expect(await hasConstraint(schema, CHECK), `${schema} CHECK`).toBe(true);
      expect(await hasIndex(schema, INDEX), `${schema} index`).toBe(true);
    }
  });

  it("has a TENANT_SCHEMA block that stands up the whole shape on its own", async () => {
    // Replayed ALONE against a schema the loop never touched, which is the only way to tell the two halves
    // apart. A newly provisioned office gets this block and nothing else.
    await seedOffices(["office_houston"]);
    expect(await columnTypes("office_houston")).toEqual({});

    await pg.exec(tenantBlock("office_houston"));

    expect(Object.keys(await columnTypes("office_houston")).sort()).toEqual([...COLUMNS].sort());
    expect(await hasConstraint("office_houston", CHECK)).toBe(true);
    expect(await hasIndex("office_houston", INDEX)).toBe(true);
  });

  it("creates the public delivery-key map, which is not per-office", async () => {
    // The row that lets a webhook with no session, no header and no tenant hint find the right schema.
    // Without it the handler would have to fan an arbitrary key across every office on every event.
    await seedOffices(["office_dallas"]);
    await pg.exec(migrationSql(MIGRATION));

    const columns = await pg.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'weekly_report_send_deliveries'
        ORDER BY ordinal_position`,
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      "delivery_key",
      "weekly_report_id",
      "tenant_id",
      "office_slug",
      "created_at",
    ]);
    expect(columns.rows.every((row) => row.is_nullable === "NO")).toBe(true);
  });

  it("keys the map on the delivery key, so a retry cannot double-register", async () => {
    // A retry replays the SAME key by design — that is what stops it becoming a second client email — so
    // the second insert is the ordinary case and must be a no-op rather than a 23505 that aborts a send.
    await seedOffices(["office_dallas"]);
    await pg.exec(migrationSql(MIGRATION));

    const key = "9f2a1c44-3f6b-4a2f-9d55-6e7c8b9a0d12";
    const insert = `INSERT INTO public.weekly_report_send_deliveries
        (delivery_key, weekly_report_id, tenant_id, office_slug)
        VALUES ('${key}', gen_random_uuid(), gen_random_uuid(), 'dallas')
        ON CONFLICT (delivery_key) DO NOTHING`;
    await pg.exec(insert);
    await pg.exec(insert);

    const count = await pg.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM public.weekly_report_send_deliveries`,
    );
    expect(count.rows[0]?.n).toBe(1);
  });

  it("REFUSES a verdict outside the vocabulary", async () => {
    // The CHECK, executed rather than asserted from the file text. The webhook maps a provider event type
    // to one of five words and drops anything else, so a value outside the set can only arrive from a
    // hand-written UPDATE — which is exactly what this stops.
    await seedOffices(["office_dallas"]);
    await pg.exec(migrationSql(MIGRATION));

    await expect(
      pg.exec(`INSERT INTO office_dallas.weekly_reports (send_delivery_status) VALUES ('probably_fine')`),
    ).rejects.toThrow(/weekly_reports_send_delivery_status_check/);

    for (const status of ["delayed", "delivered", "complained", "failed", "bounced"]) {
      await expect(
        pg.exec(`INSERT INTO office_dallas.weekly_reports (send_delivery_status) VALUES ('${status}')`),
      ).resolves.toBeDefined();
    }
    await expect(
      pg.exec(`INSERT INTO office_dallas.weekly_reports (send_delivery_status) VALUES (NULL)`),
    ).resolves.toBeDefined();
  });

  it("leaves every existing row NULL, which reads as `unknown` and not as `delivered`", async () => {
    // The safe direction and the reason the column is nullable. Every send made before this deploy carries
    // no delivery tag, so no webhook will ever speak for it — back-filling `delivered` would assert
    // delivery for exactly the reports nothing can evidence.
    await seedOffices(["office_dallas"]);
    await pg.exec(
      `INSERT INTO office_dallas.weekly_reports (status, send_delivered_at) VALUES ('sent', now())`,
    );
    await pg.exec(migrationSql(MIGRATION));

    const rows = await pg.query<{ status: string | null }>(
      `SELECT send_delivery_status AS status FROM office_dallas.weekly_reports`,
    );
    expect(rows.rows[0]?.status).toBeNull();
  });

  it("is idempotent — re-running changes nothing and does not error", async () => {
    // Including the CHECK, which has no `ADD CONSTRAINT IF NOT EXISTS`: the DO loop covers office_dallas
    // too, so without its pg_constraint guard the TENANT block below it would fail on the FIRST run.
    await seedOffices(["office_dallas", "office_atlanta"]);
    await pg.exec(migrationSql(MIGRATION));
    await expect(pg.exec(migrationSql(MIGRATION))).resolves.toBeDefined();

    const constraints = await pg.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM pg_constraint WHERE conname = $1`,
      [CHECK],
    );
    expect(constraints.rows[0]?.n).toBe(2);
    expect(Object.keys(await columnTypes("office_dallas")).length).toBe(3);
  });

  it("skips an office schema that has no weekly_reports table", async () => {
    // Weekly reports arrived in 0222, so a schema created before it — or a partially provisioned one —
    // legitimately has no such table. Without the to_regclass guard the ALTER aborts the migration and
    // takes every later one on the deploy with it.
    await seedOffices(["office_dallas"]);
    await pg.exec(`CREATE SCHEMA office_empty;`);

    await expect(pg.exec(migrationSql(MIGRATION))).resolves.toBeDefined();
    expect(Object.keys(await columnTypes("office_dallas")).length).toBe(3);
  });

  it("indexes only the sends that did NOT reach the client", async () => {
    // Partial, so it stays tiny — in a healthy office it is empty. Asserted by executing the predicate
    // rather than by reading the file: a WHERE clause that silently matched every row would still be
    // "an index called weekly_reports_send_delivery_failed_idx".
    await seedOffices(["office_dallas"]);
    await pg.exec(migrationSql(MIGRATION));

    const definition = await pg.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = 'office_dallas' AND indexname = $1`,
      [INDEX],
    );
    const indexdef = definition.rows[0]?.indexdef ?? "";
    expect(indexdef).toMatch(/is_active/);
    expect(indexdef).toMatch(/'sent'/);
    expect(indexdef).toMatch(/bounced/);
    expect(indexdef).toMatch(/failed/);

    // And the row set it describes: a bounced report is NOT in 0226's undelivered index, because it was
    // accepted and therefore carries a delivery stamp. The two are disjoint by construction, which is why
    // this one has to exist at all.
    await pg.exec(`
      INSERT INTO office_dallas.weekly_reports (status, send_delivered_at, send_delivery_status)
      VALUES ('sent', now(), 'bounced'), ('sent', now(), 'delivered'), ('sent', NULL, NULL);
    `);
    const counts = await pg.query<{ bounced: number; undelivered: number }>(
      `SELECT
         COUNT(*) FILTER (WHERE is_active AND status = 'sent' AND send_delivery_status IN ('bounced','failed'))::int AS bounced,
         COUNT(*) FILTER (WHERE is_active AND status = 'sent' AND send_delivered_at IS NULL)::int AS undelivered
       FROM office_dallas.weekly_reports`,
    );
    expect(counts.rows[0]).toEqual({ bounced: 1, undelivered: 1 });
  });
});
