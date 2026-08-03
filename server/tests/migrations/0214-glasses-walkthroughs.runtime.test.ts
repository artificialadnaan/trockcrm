// Executes Migration 0214 FROM DISK against a real Postgres (PGlite).
//
// 0214 adds the per-office `glasses_walkthroughs` table — the CRM's own record that a glasses walk exists
// against a deal and which TROCK Scope walkthrough it became. Four things are checked here that no
// fixture-level test can reach:
//   1. The FILE carries BOTH required blocks — the `DO $tenant$` loop over office_% schemas AND the
//      `-- TENANT_SCHEMA_START/END` section the office provisioner clones for a NEW tenant. A migration
//      with only one is a latent bug: either today's offices or every future one silently misses the table,
//      and the second shape is the worse one — a 42P01 on a deal page in an office nobody can reproduce in.
//   2. Running it TWICE is a no-op (idempotent / replayable), which the migration runner relies on.
//   3. The (deal_id, walk_id) index is genuinely UNIQUE. That index IS the re-ingest idempotency mechanism
//      — mobile retries a completion whose response timed out, and a recovered walk is re-filed from a
//      directory scan — so a non-unique one would let one physical walk grow a panel entry per retry while
//      every unit test above it still passed.
//   4. …and is scoped to the PAIR, so the SAME walk_id filed against a SECOND deal is accepted. That is the
//      supported mis-tagged-walk correction flow; unique on walk_id alone it would be refused forever.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";

const MIGRATION_PATH = join(__dirname, "../../../migrations/0214_glasses_walkthroughs.sql");
const MIGRATION_SQL = readFileSync(MIGRATION_PATH, "utf-8");

const START_MARKER = "-- TENANT_SCHEMA_START";
const END_MARKER = "-- TENANT_SCHEMA_END";

/** The office provisioner's own extraction, mirrored: the block between the markers with the
 *  office_dallas placeholder rewritten to the target schema. (server/src/modules/office/service.ts) */
function tenantBlockFor(schema: string): string {
  const startIdx = MIGRATION_SQL.indexOf(START_MARKER);
  const endIdx = MIGRATION_SQL.indexOf(END_MARKER);
  return MIGRATION_SQL.substring(startIdx + START_MARKER.length, endIdx)
    .trim()
    .replaceAll("office_dallas", schema);
}

const DEAL_A = "00000000-0000-4000-8000-0000000000d1";
const DEAL_B = "00000000-0000-4000-8000-0000000000d2";
const USER = "00000000-0000-4000-8000-0000000000a1";

/** Only what 0214's two FKs need: `%I.deals` in the tenant schema and the shared `public.users`. */
async function seedPrerequisites(pg: PGlite, schemas: string[]) {
  await pg.exec(`CREATE TABLE IF NOT EXISTS public.users (id uuid PRIMARY KEY);`);
  await pg.query(`INSERT INTO public.users (id) VALUES ($1) ON CONFLICT DO NOTHING`, [USER]);
  for (const schema of schemas) {
    await pg.exec(`
      CREATE SCHEMA IF NOT EXISTS ${schema};
      CREATE TABLE IF NOT EXISTS ${schema}.deals (id uuid PRIMARY KEY);
    `);
    await pg.query(`INSERT INTO ${schema}.deals (id) VALUES ($1), ($2) ON CONFLICT DO NOTHING`, [
      DEAL_A,
      DEAL_B,
    ]);
  }
}

async function insertWalk(
  pg: PGlite,
  schema: string,
  args: { dealId: string; walkId: string; scopeWalkthroughId?: string | null },
) {
  return pg.query(
    `INSERT INTO ${schema}.glasses_walkthroughs
       (deal_id, walk_id, scope_walkthrough_id, captured_at, captured_by_user_id)
     VALUES ($1, $2, $3, '2026-08-02T22:21:47.702Z', $4)
     RETURNING id, scope_walkthrough_id, created_at, updated_at`,
    [args.dealId, args.walkId, args.scopeWalkthroughId ?? null, USER],
  );
}

describe("migration 0214 — glasses_walkthroughs", () => {
  let pg: PGlite;

  beforeEach(async () => {
    pg = new PGlite();
  });

  afterEach(async () => {
    await pg.close();
  });

  it("carries BOTH the DO-loop over office_% schemas and a TENANT_SCHEMA block for new tenants", () => {
    expect(MIGRATION_SQL).toContain("DO $tenant$");
    expect(MIGRATION_SQL).toContain("LIKE 'office\\_%'");
    expect(MIGRATION_SQL).toContain(START_MARKER);
    expect(MIGRATION_SQL).toContain(END_MARKER);

    // Parity, not merely presence: a block that creates the table but forgets the unique index would leave
    // every newly provisioned office without the one constraint the ingest's idempotency depends on.
    const block = tenantBlockFor("office_dallas");
    expect(block).toContain("CREATE TABLE IF NOT EXISTS office_dallas.glasses_walkthroughs");
    expect(block).toContain("REFERENCES office_dallas.deals(id) ON DELETE CASCADE");
    expect(block).toContain("REFERENCES public.users(id) ON DELETE SET NULL");
    expect(block).toContain("glasses_walkthroughs_deal_walk_uidx");
    expect(block).toContain("ON office_dallas.glasses_walkthroughs (deal_id, walk_id)");
  });

  it("creates the table in an EXISTING office schema, and is replayable", async () => {
    await seedPrerequisites(pg, ["office_dallas"]);
    await pg.exec(MIGRATION_SQL);
    // Twice: the migration runner replays a file whose recording failed, and a second run must be a no-op
    // rather than a 42P07.
    await pg.exec(MIGRATION_SQL);

    const { rows } = await pg.query<{ column_name: string; is_nullable: string; data_type: string }>(
      `SELECT column_name, is_nullable, data_type
         FROM information_schema.columns
        WHERE table_schema = 'office_dallas' AND table_name = 'glasses_walkthroughs'
        ORDER BY column_name`,
    );
    expect(rows.map((r) => r.column_name)).toEqual([
      "captured_at",
      "captured_by_user_id",
      "created_at",
      "deal_id",
      "id",
      "scope_walkthrough_id",
      "updated_at",
      "walk_id",
    ]);
    // scope_walkthrough_id MUST be nullable: it is null for the entire window between a walk being filed
    // and its forward confirming a remote walkthrough, which is exactly the "processing" state the deal
    // page renders. A NOT NULL here would make the ingest insert impossible.
    expect(rows.find((r) => r.column_name === "scope_walkthrough_id")?.is_nullable).toBe("YES");
    expect(rows.find((r) => r.column_name === "captured_by_user_id")?.is_nullable).toBe("YES");
    expect(rows.find((r) => r.column_name === "deal_id")?.is_nullable).toBe("NO");
    expect(rows.find((r) => r.column_name === "walk_id")?.is_nullable).toBe("NO");
    expect(rows.find((r) => r.column_name === "captured_at")?.is_nullable).toBe("NO");
  });

  it("skips an office schema that has no deals table, instead of failing the whole migration", async () => {
    // A half-provisioned schema must not take the migration down for every OTHER office in the install —
    // the DO-loop's `to_regclass ... IS NULL THEN CONTINUE` guard, which every tenant migration here
    // carries.
    await seedPrerequisites(pg, ["office_dallas"]);
    await pg.exec(`CREATE SCHEMA office_halfbuilt;`);

    await expect(pg.exec(MIGRATION_SQL)).resolves.toBeDefined();
    const { rows } = await pg.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.tables
        WHERE table_schema = 'office_halfbuilt' AND table_name = 'glasses_walkthroughs'`,
    );
    expect(rows[0]!.n).toBe(0);
  });

  it("REFUSES a second row for the same (deal_id, walk_id) — the re-ingest idempotency mechanism", async () => {
    await seedPrerequisites(pg, ["office_dallas"]);
    await pg.exec(MIGRATION_SQL);

    await insertWalk(pg, "office_dallas", { dealId: DEAL_A, walkId: "walk-msc4vvy4-m7r30urh" });
    await expect(
      insertWalk(pg, "office_dallas", { dealId: DEAL_A, walkId: "walk-msc4vvy4-m7r30urh" }),
    ).rejects.toThrow(/glasses_walkthroughs_deal_walk_uidx|duplicate key/i);
  });

  it("ACCEPTS the same walk_id against a SECOND deal — the mis-tagged-walk correction flow", async () => {
    await seedPrerequisites(pg, ["office_dallas"]);
    await pg.exec(MIGRATION_SQL);

    await insertWalk(pg, "office_dallas", { dealId: DEAL_A, walkId: "walk-msc4vvy4-m7r30urh" });
    const second = await insertWalk(pg, "office_dallas", {
      dealId: DEAL_B,
      walkId: "walk-msc4vvy4-m7r30urh",
    });
    expect(second.rows).toHaveLength(1);
  });

  it("clears a walk's rows when its DEAL is deleted, and merely unlinks the capturing user", async () => {
    await seedPrerequisites(pg, ["office_dallas"]);
    await pg.exec(MIGRATION_SQL);
    await insertWalk(pg, "office_dallas", { dealId: DEAL_A, walkId: "walk-1" });

    // captured_by_user_id is PROVENANCE: removing the user must neither delete the walk's link to a scope
    // extraction somebody paid for nor be blocked by it.
    await pg.query(`DELETE FROM public.users WHERE id = $1`, [USER]);
    const afterUserDelete = await pg.query<{ captured_by_user_id: string | null; n: number }>(
      `SELECT captured_by_user_id, count(*) OVER ()::int AS n FROM office_dallas.glasses_walkthroughs`,
    );
    expect(afterUserDelete.rows).toHaveLength(1);
    expect(afterUserDelete.rows[0]!.captured_by_user_id).toBeNull();

    // The deal is the opposite: this row is a LINK and is meaningless without it.
    await pg.query(`DELETE FROM office_dallas.deals WHERE id = $1`, [DEAL_A]);
    const afterDealDelete = await pg.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM office_dallas.glasses_walkthroughs`,
    );
    expect(afterDealDelete.rows[0]!.n).toBe(0);
  });

  it("gives a NEWLY PROVISIONED office the same table and the same unique index", async () => {
    // The provisioner never runs the DO-loop — it lifts the TENANT_SCHEMA block and rewrites the schema
    // name. This is the half that silently rots when someone edits only the loop.
    await seedPrerequisites(pg, ["office_newoffice"]);
    await pg.exec(tenantBlockFor("office_newoffice"));

    await insertWalk(pg, "office_newoffice", { dealId: DEAL_A, walkId: "walk-1" });
    await expect(
      insertWalk(pg, "office_newoffice", { dealId: DEAL_A, walkId: "walk-1" }),
    ).rejects.toThrow(/glasses_walkthroughs_deal_walk_uidx|duplicate key/i);
    const second = await insertWalk(pg, "office_newoffice", { dealId: DEAL_B, walkId: "walk-1" });
    expect(second.rows).toHaveLength(1);
  });
});
