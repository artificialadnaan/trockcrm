import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";

/**
 * Apply the REAL migration against seeded office schemas.
 *
 * `.sql` is invisible to typecheck and to every other test in the suite, and this file is exactly the
 * kind that fails quietly: the index expression is duplicated from match-service.ts by hand, and
 * Postgres only uses an expression index on a SYNTACTIC match. A migration that parses but builds a
 * slightly different expression produces no error anywhere — it just never gets used, and the endpoint
 * stays on a sequential scan that nothing reports.
 *
 * The nested quoting is the other reason. Writing the embedded DDL with doubled quotes instead of
 * dollar-quoting is easy to get wrong (the empty-string literal alone needs four), and a wrong version
 * still parses.
 */
const MIGRATION = readFileSync(
  new URL("../../../../migrations/0201_properties_match_indexes.sql", import.meta.url),
  "utf8",
);

/** The exact predicate match-service.ts sends. If this drifts, the index stops being used. */
const QUERY_EXPRESSION =
  "btrim(regexp_replace(translate(lower(coalesce(address, '')), 'áàâäãåÁÀÂÄÃÅéèêëÉÈÊËíìîïÍÌÎÏóòôöõÓÒÔÖÕúùûüÚÙÛÜñÑçÇýÿÝ', 'aaaaaaaaaaaaeeeeeeeeiiiiiiiioooooooooouuuuuuuunnccyyy'), '[^a-z0-9]+', ' ', 'g'))";

const OFFICES = ["office_dallas", "office_atlanta"];

let pg: PGlite;

async function indexDef(schema: string, index: string): Promise<string | null> {
  const res = await pg.query(
    `SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = $2`,
    [schema, index],
  );
  return (res.rows[0] as { indexdef?: string } | undefined)?.indexdef ?? null;
}

beforeAll(async () => {
  pg = new PGlite();
  for (const office of OFFICES) {
    await pg.exec(`
      CREATE SCHEMA ${office};
      CREATE TABLE ${office}.properties (
        id uuid PRIMARY KEY,
        address text,
        lat numeric(10,7),
        lng numeric(10,7)
      );
    `);
  }
  // A schema WITHOUT the table, to prove the to_regclass guard skips rather than throws — a
  // half-provisioned office must not break every other office's migration.
  await pg.exec(`CREATE SCHEMA office_empty;`);
  await pg.exec(MIGRATION);
});

afterAll(async () => {
  await pg?.close?.();
});

describe("0201 properties match indexes", () => {
  it("creates both indexes in every office schema that has the table", async () => {
    for (const office of OFFICES) {
      expect(await indexDef(office, "properties_normalized_address_idx")).not.toBeNull();
      expect(await indexDef(office, "properties_lat_lng_idx")).not.toBeNull();
    }
  });

  it("skips a schema with no properties table instead of failing the whole migration", async () => {
    expect(await indexDef("office_empty", "properties_normalized_address_idx")).toBeNull();
  });

  it("indexes the SAME expression the query sends", async () => {
    // The real point of this file. Postgres matches an expression index syntactically, so a migration
    // that parses but normalises differently leaves the endpoint on a sequential scan silently.
    const def = await indexDef("office_dallas", "properties_normalized_address_idx");
    // Case-insensitive and cast-insensitive: pg_indexes echoes the expression with keywords
    // upper-cased (COALESCE) and an explicit ::text on the literal. Neither changes what the planner
    // matches — only the literal STRUCTURE has to agree with the query.
    const strip = (s: string) => s.replace(/\s+/g, " ").replace(/::text/g, "").toLowerCase();
    expect(strip(def ?? "")).toContain(strip(QUERY_EXPRESSION));
  });

  it("uses text_pattern_ops, without which the LIKE prefix predicate cannot use the index", async () => {
    const def = await indexDef("office_dallas", "properties_normalized_address_idx");
    expect(def).toContain("text_pattern_ops");
  });

  it("keeps the coordinate index partial, since almost every row has no coordinates", async () => {
    const def = await indexDef("office_dallas", "properties_lat_lng_idx");
    // BOTH columns. Asserting only lat would pass with `lng IS NOT NULL` deleted, letting the paired
    // predicate regress silently — the index would then cover rows the query can never use.
    expect(def).toMatch(/WHERE .*lat IS NOT NULL/i);
    expect(def).toMatch(/lng IS NOT NULL/i);
  });

  it("is idempotent — re-running the migration is a no-op", async () => {
    // Migrations re-run on every deploy against schemas that already have the indexes.
    await expect(pg.exec(MIGRATION)).resolves.toBeDefined();
    expect(await indexDef("office_dallas", "properties_normalized_address_idx")).not.toBeNull();
  });

  it("ships a tenant-provisioner block for schemas created later", async () => {
    // Without the marker block a NEW office gets no indexes at all, and the regression is invisible
    // until that office is large enough to be slow.
    expect(MIGRATION).toContain("-- TENANT_SCHEMA_START");
    expect(MIGRATION).toContain("-- TENANT_SCHEMA_END");
    const block = MIGRATION.slice(
      MIGRATION.indexOf("-- TENANT_SCHEMA_START"),
      MIGRATION.indexOf("-- TENANT_SCHEMA_END"),
    );
    expect(block).toContain("properties_normalized_address_idx");
    expect(block).toContain("properties_lat_lng_idx");
    // The provisioner swaps this literal for the new schema name.
    expect(block).toContain("office_dallas.properties");
  });
});
