import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Runtime test for migration 0144: advancing into the Estimating boundary must require
// expectedCloseDate. The stage-gate logic is generic (already enforces any required_fields), so the
// NEW behavior is the seed -- this proves the migration appends "expectedCloseDate" to exactly the
// estimating-boundary stages, additively (does not replace existing entries), idempotently, and
// leaves other stages untouched. Boots in-memory Postgres (PGlite) and execs the REAL migration file.

const MIGRATION = fileURLToPath(
  new URL("../../../../migrations/0144_require_expected_close_date_on_estimating.sql", import.meta.url)
);

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE public.pipeline_stage_config (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      slug text NOT NULL,
      required_fields jsonb NOT NULL DEFAULT '[]'
    );
    INSERT INTO public.pipeline_stage_config (slug, required_fields) VALUES
      ('estimating', '[]'),
      ('service_estimating', '["propertyAddress"]'),
      ('estimate_in_progress', '[]'),
      ('estimate_sent_to_client', '[]');
  `);
});
afterAll(async () => {
  await db?.close();
});

async function requiredFields(slug: string): Promise<string[]> {
  const r = await db.query<{ required_fields: string[] }>(
    "SELECT required_fields FROM public.pipeline_stage_config WHERE slug = $1",
    [slug]
  );
  return r.rows[0].required_fields;
}

describe("0144 require expected_close_date on the Estimating boundary", () => {
  it("appends expectedCloseDate to the estimating stages, additively + idempotently, sparing others", async () => {
    const sql = readFileSync(MIGRATION, "utf8");
    await db.exec(sql);

    // gates the ACTIVE standard-route estimating stage (slug "estimating", per migration 0064)
    expect(await requiredFields("estimating")).toContain("expectedCloseDate");
    // additive: existing required field is preserved, not replaced
    expect(await requiredFields("service_estimating")).toEqual(
      expect.arrayContaining(["propertyAddress", "expectedCloseDate"])
    );
    // the legacy "estimate_in_progress" (inactive/unreachable since 0064) is deliberately NOT gated
    expect(await requiredFields("estimate_in_progress")).toEqual([]);
    // a downstream Proposal-Sent stage is deliberately NOT gated -- it is mirror-entered (gate-bypassed),
    // so the projection caveat covers it instead. Proves the gate targets estimating, not proposal-sent.
    expect(await requiredFields("estimate_sent_to_client")).toEqual([]);

    // idempotent: re-running the migration does not duplicate the entry
    await db.exec(sql);
    expect((await requiredFields("estimating")).filter((f) => f === "expectedCloseDate")).toHaveLength(1);
    expect((await requiredFields("service_estimating")).filter((f) => f === "expectedCloseDate")).toHaveLength(1);
  });
});
