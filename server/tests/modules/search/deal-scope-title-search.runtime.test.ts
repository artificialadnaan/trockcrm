// A deal is findable by its SCOPE TITLE, against real SQL.
//
// scope_title is frequently the only place a deal's actual work is written in title form. A
// change-order child is stored as "<Parent> — Change Order 1" and its notes may be blank, so its title
// ("Panel Relocation") is the only phrase that identifies it — and that is exactly the phrase a user
// types into the deals search. Leaving the column out of the predicate means the accounting title is
// readable, exportable, and unfindable.
//
// buildDealSearchCondition is the shared predicate behind the deals list, the stage-page drill-down
// header, and unified search, so proving it here covers all three: they are the same SQL by
// construction (the aliased-table parameter exists precisely so they cannot drift).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { deals } from "@trock-crm/shared/schema";
import { alias } from "drizzle-orm/pg-core";
import {
  DEAL_SEARCH_FIELDS,
  buildDealSearchCondition,
} from "../../../src/modules/search/unified-search.js";

const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const STAGE = U("57a1");
const D = {
  titled: U("d001"), // scope title only — name and description say nothing about the work
  co: U("d002"), // a change-order child: generic name, no description, real title
  described: U("d003"), // description only, no title (the pre-0218 shape)
  unrelated: U("d004"),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`SET TimeZone='UTC';`);
  await pg.exec(`
    CREATE TABLE companies (id uuid PRIMARY KEY, name text);
    CREATE TABLE contacts (id uuid PRIMARY KEY, first_name text, last_name text);
    CREATE TABLE users (id uuid PRIMARY KEY, display_name text);
    CREATE TABLE deals (
      id uuid PRIMARY KEY, name text, deal_number text, project_number text,
      scope_title varchar(120), description text,
      property_address text, property_city text, property_state text, bid_board_customer_name text,
      company_id uuid, primary_contact_id uuid, assigned_rep_id uuid,
      stage_id uuid, is_active boolean NOT NULL DEFAULT true
    );
    INSERT INTO deals (id, name, scope_title, description, stage_id) VALUES
      ('${D.titled}', 'Tides at Highland Meadows', 'Balcony Repair', NULL, '${STAGE}'),
      ('${D.co}', 'Tides at Highland Meadows — Change Order 1', 'Panel Relocation', NULL, '${STAGE}'),
      ('${D.described}', 'Maple at Med Center', NULL, '50 stucco hole patches', '${STAGE}'),
      ('${D.unrelated}', 'Warehouse and Factory', 'Exterior Renovation', NULL, '${STAGE}');
  `);
  tdb = drizzle(pg);
}, 30000);

afterAll(async () => {
  await pg?.close?.();
});

async function search(term: string, dealsTable?: Parameters<typeof buildDealSearchCondition>[1]) {
  const rows = await tdb
    .select({ id: deals.id })
    .from(deals)
    .where(buildDealSearchCondition(term, dealsTable));
  return (rows as Array<{ id: string }>).map((r) => r.id).sort();
}

describe("buildDealSearchCondition — scope_title is searchable", () => {
  it("finds a deal by a scope title that appears nowhere in its name or description", async () => {
    expect(await search("Balcony Repair")).toEqual([D.titled]);
  });

  it("finds a CHANGE-ORDER child by its own title — the case with no other handle on it", async () => {
    // The child's name is the parent's plus a suffix and its description is null, so before this the
    // only way to reach it was to already know the parent.
    expect(await search("Panel Relocation")).toEqual([D.co]);
  });

  it("is case-insensitive and matches on a substring, like every other searched field", async () => {
    expect(await search("balcony")).toEqual([D.titled]);
    expect(await search("RELOCATION")).toEqual([D.co]);
  });

  it("still matches description-only deals — the new field widens the predicate, it does not replace one", async () => {
    expect(await search("stucco")).toEqual([D.described]);
  });

  it("does not widen a search into unrelated deals", async () => {
    expect(await search("Plumbing Renovations")).toEqual([]);
  });

  it("escapes LIKE metacharacters in the term rather than treating them as wildcards", async () => {
    // '%' must match a literal percent sign, not everything — otherwise one stray character in a title
    // search silently returns the whole pipeline.
    expect(await search("%")).toEqual([]);
    expect(await search("_")).toEqual([]);
  });

  it("applies to an ALIASED deals table too, so the drill-down header search matches the list", async () => {
    const d = alias(deals, "d");
    const rows = await tdb.select({ id: d.id }).from(d).where(buildDealSearchCondition("Balcony Repair", d));
    expect((rows as Array<{ id: string }>).map((r) => r.id)).toEqual([D.titled]);
  });

  it("declares scope_title in DEAL_SEARCH_FIELDS, which is what documents the predicate", async () => {
    // The list and the predicate are two hands of the same contract; a field searched but undeclared
    // (or declared but unsearched) is how the two drift.
    expect(DEAL_SEARCH_FIELDS).toContain("deals.scope_title");
    for (const field of DEAL_SEARCH_FIELDS.filter((f) => f.startsWith("deals."))) {
      const column = field.slice("deals.".length);
      const hit = await tdb.execute(
        // Every declared deals.* field must exist on the table the predicate runs against.
        `SELECT 1 FROM information_schema.columns
          WHERE table_name = 'deals' AND column_name = '${column}'`,
      );
      const rows = Array.isArray(hit) ? hit : (hit as { rows?: unknown[] }).rows ?? [];
      expect(rows.length, `DEAL_SEARCH_FIELDS names a missing column: ${field}`).toBe(1);
    }
  });
});
