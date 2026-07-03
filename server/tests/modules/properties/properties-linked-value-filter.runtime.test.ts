import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

/**
 * REAL-SQL runtime coverage (PGlite in-memory Postgres) for the Properties Linked Value FOLD —
 * the min/max range filter + the Linked Value sort, both of which must operate over the FULL filtered
 * set BEFORE the 250-row window (limit), not over the page. Mocking the Drizzle chain can't prove that
 * (the subquery LEFT JOIN + LIMIT pushdown is exactly what we're testing), so this boots an actual
 * Postgres, seeds 300 properties, and runs the REAL `listProperties`.
 *
 * Key fixtures (all under ONE company, default order = name ASC, so "Prop 300" is at position 300 — i.e.
 * OUTSIDE a default-order 250-row window):
 *   - Prop 300: one deal forecast_revenue = 5,000,000  → linked value 5,000,000 (the far-down HIGH one)
 *   - Prop 150: one deal awarded_amount   =   250,000  → 250,000 (type office, city "Searchville")
 *   - Prop 040: two deals (forecast 100k + awarded 200k) → 300,000 (reconciliation: SUM across deals)
 *   - Prop 010: one deal bid_estimate     =    50,000  → 50,000
 *   - Prop 020: one ON-HOLD deal forecast = 999,999    → 0 (on-hold zeroed by the resolver)
 *   - Prop 030: one deal, all values 0                 → 0
 *   - every other property: no deals                   → 0
 */

const T = "office_test";
const COMPANY = "00000000-0000-0000-0000-0000000000c1";
const TOTAL = 300;
const WINDOW = 250;

const pid = (i: number) => `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`;
const propName = (i: number) => `Prop ${String(i).padStart(3, "0")}`;

let pg: PGlite;
let tdb: never;

beforeAll(async () => {
  pg = new PGlite();
  // Only the columns listProperties touches; enums modelled as text (the service casts ::text / compares
  // eq), money columns numeric. The service never INSERTs, so omitted NOT NULL columns don't matter.
  await pg.exec(`
    CREATE SCHEMA ${T};
    CREATE TABLE ${T}.companies (
      id uuid PRIMARY KEY,
      name varchar(500) NOT NULL,
      is_active boolean NOT NULL DEFAULT true
    );
    CREATE TABLE ${T}.properties (
      id uuid PRIMARY KEY,
      company_id uuid NOT NULL,
      name varchar(500) NOT NULL,
      address text, city varchar(255), state varchar(2), zip varchar(10),
      type text,
      build_year integer, unit_count integer, floors integer, roof_area integer,
      notes text,
      last_activity_at timestamptz,
      procore_id text, companycam_id text,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE ${T}.deals (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sales_source_user_id uuid,
      company_id uuid,
      property_id uuid,
      source_lead_id uuid,
      forecast_revenue numeric(14,2),
      awarded_amount numeric(14,2),
      bid_board_total_sales numeric(14,2),
      bid_estimate numeric(14,2),
      dd_estimate numeric(14,2),
      on_hold boolean NOT NULL DEFAULT false, expected_close_date date,
      stage_id uuid, bid_board_stage_slug text,
      last_activity_at timestamptz,
      is_active boolean NOT NULL DEFAULT true
    );
    CREATE TABLE ${T}.pipeline_stage_config (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      slug text NOT NULL
    );
    CREATE TABLE ${T}.leads (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      property_id uuid,
      last_activity_at timestamptz,
      is_active boolean NOT NULL DEFAULT true
    );
    CREATE TABLE ${T}.files (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      deal_id uuid,
      lead_id uuid,
      category text,
      is_active boolean NOT NULL DEFAULT true
    );
    SET search_path TO ${T}, public;
  `);

  await pg.exec(`INSERT INTO ${T}.companies (id, name) VALUES ('${COMPANY}', 'Folded Co');`);

  // 300 properties; Prop 150 = office/Searchville, Prop 040 = retail, the rest type NULL.
  const propValues: string[] = [];
  for (let i = 1; i <= TOTAL; i++) {
    const type = i === 150 ? "'office'" : i === 40 ? "'retail'" : "NULL";
    const city = i === 150 ? "'Searchville'" : "NULL";
    propValues.push(`('${pid(i)}', '${COMPANY}', '${propName(i)}', ${type}, ${city})`);
  }
  await pg.exec(
    `INSERT INTO ${T}.properties (id, company_id, name, type, city) VALUES ${propValues.join(",")};`
  );

  await pg.exec(`
    INSERT INTO ${T}.deals (property_id, company_id, forecast_revenue, awarded_amount, bid_estimate, on_hold, is_active) VALUES
      ('${pid(300)}', '${COMPANY}', 5000000, NULL, NULL, false, true),
      ('${pid(150)}', '${COMPANY}', NULL, 250000, NULL, false, true),
      ('${pid(40)}',  '${COMPANY}', 100000, NULL, NULL, false, true),
      ('${pid(40)}',  '${COMPANY}', NULL, 200000, NULL, false, true),
      ('${pid(10)}',  '${COMPANY}', NULL, NULL, 50000, false, true),
      ('${pid(20)}',  '${COMPANY}', 999999, NULL, NULL, true,  true),
      ('${pid(30)}',  '${COMPANY}', 0, 0, 0, false, true);
  `);

  tdb = drizzle(pg) as never;
});

afterAll(async () => {
  await pg?.close?.();
});

async function listProperties(filters: Record<string, unknown>) {
  const { listProperties: real } = await import("../../../src/modules/properties/service.js");
  return real(tdb, filters as never);
}

const byName = (rows: Array<{ name: string }>) => rows.map((r) => r.name);
const valueOf = (rows: Array<{ name: string; linkedValue?: string }>, name: string) =>
  rows.find((r) => r.name === name)?.linkedValue;

describe("listProperties — Linked Value fold (full-set sort + filter)", () => {
  it("SORT linked_value DESC surfaces the far-down high-value property to the top of the window", async () => {
    // It is NOT in the default-order 250-window (it sits at position 300 by name)…
    const def = await listProperties({ limit: WINDOW });
    expect(def.properties).toHaveLength(WINDOW);
    expect(byName(def.properties)).not.toContain("Prop 300");

    // …but sorting by linked value DESC over the FULL set before LIMIT pulls it to position 1.
    const sorted = await listProperties({ sortBy: "linked_value", sortDir: "desc", limit: WINDOW });
    expect(sorted.properties[0]?.name).toBe("Prop 300");
    expect(sorted.properties[0]?.linkedValue).toBe("5000000.00");
    // Descending money order: 5M, 300k, 250k, 50k, then the $0 tail.
    expect(byName(sorted.properties).slice(0, 4)).toEqual(["Prop 300", "Prop 040", "Prop 150", "Prop 010"]);
  });

  it("SORT linked_value ASC sinks the $0 properties to the top (nulls/zeros last in DESC, first in ASC)", async () => {
    const asc = await listProperties({ sortBy: "linked_value", sortDir: "asc", limit: WINDOW });
    // First rows are $0 properties; the id tiebreak keeps it deterministic.
    expect(asc.properties[0]?.linkedValue).toBe("0");
    // The high-value ones are at the tail of the full set (so beyond the 250 window here).
    expect(byName(asc.properties)).not.toContain("Prop 300");
  });

  it("FILTER minLinkedValue includes a match that lives OUTSIDE the default 250-window (full-set WHERE)", async () => {
    const res = await listProperties({ minLinkedValue: 1_000_000, limit: WINDOW });
    expect(byName(res.properties)).toEqual(["Prop 300"]); // only the 5M property clears 1M
    expect(res.total).toBe(1); // total reflects the FILTERED full set, not the window
  });

  it("FILTER min/max range returns the closed interval and excludes the out-of-range high/low", async () => {
    const res = await listProperties({ minLinkedValue: 100_000, maxLinkedValue: 300_000, limit: WINDOW });
    const names = byName(res.properties).sort();
    expect(names).toEqual(["Prop 040", "Prop 150"]); // 300k and 250k; excludes 5M (>max) and 50k (<min)
    expect(res.total).toBe(2);
  });

  it("FILTER AND-composes with the Type filter and search", async () => {
    // min 100k matches Prop 040 (retail) + Prop 150 (office); +type office narrows to 150; +search confirms.
    const typed = await listProperties({ minLinkedValue: 100_000, type: "office", limit: WINDOW });
    expect(byName(typed.properties)).toEqual(["Prop 150"]);

    const searched = await listProperties({ minLinkedValue: 100_000, search: "Searchville", limit: WINDOW });
    expect(byName(searched.properties)).toEqual(["Prop 150"]);

    const all3 = await listProperties({
      minLinkedValue: 100_000,
      maxLinkedValue: 300_000,
      type: "office",
      search: "Searchville",
      limit: WINDOW,
    });
    expect(byName(all3.properties)).toEqual(["Prop 150"]);
  });

  it("RECONCILES the folded value to the resolver: SUM across deals, on-hold zeroed, $0 floor", async () => {
    const res = await listProperties({ sortBy: "linked_value", sortDir: "desc", limit: WINDOW });
    expect(valueOf(res.properties, "Prop 040")).toBe("300000.00"); // 100k forecast + 200k awarded, summed in SQL
    expect(valueOf(res.properties, "Prop 150")).toBe("250000.00"); // awarded when no forecast
    expect(valueOf(res.properties, "Prop 010")).toBe("50000.00"); // bid_estimate fallback
    expect(valueOf(res.properties, "Prop 020")).toBe("0"); // ON-HOLD deal contributes 0
    expect(valueOf(res.properties, "Prop 030")).toBe("0"); // all-zero deal → 0
    expect(valueOf(res.properties, "Prop 100")).toBe("0"); // no deals → 0
  });

  it("min=0 is honoured as a real bound (>= 0 keeps every property)", async () => {
    const res = await listProperties({ minLinkedValue: 0, limit: WINDOW });
    expect(res.total).toBe(TOTAL);
  });
});
