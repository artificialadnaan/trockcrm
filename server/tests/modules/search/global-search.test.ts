import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/db.js", () => ({ db: {} as any, pool: {} as any }));

import { WON_STAGE_SLUGS } from "../../../src/modules/shared/pipeline-terminal-stages.js";

const { globalSearch } = await import("../../../src/modules/search/service.js");

// Chainable query-builder stub: every method returns the builder; awaiting resolves to `rows`.
function chainable(rows: unknown[]) {
  const builder: Record<string, unknown> = {};
  for (const method of ["from", "where", "orderBy", "limit", "leftJoin", "innerJoin", "groupBy"]) {
    builder[method] = vi.fn(() => builder);
  }
  (builder as { then: unknown }).then = (resolve: (value: unknown) => unknown) => resolve(rows);
  return builder;
}

const WON_SLUG = WON_STAGE_SLUGS[0];

// Flatten a drizzle SQL/condition object to text so we can assert on the columns a WHERE touches.
function extractSqlText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  if (Array.isArray((value as { queryChunks?: unknown[] }).queryChunks)) {
    return (value as { queryChunks: unknown[] }).queryChunks.map(extractSqlText).join("");
  }
  if ("value" in (value as Record<string, unknown>)) {
    const v = (value as { value: unknown }).value;
    if (Array.isArray(v)) return v.map(extractSqlText).join("");
    if (typeof v === "string") return v;
  }
  if ("name" in (value as Record<string, unknown>) && typeof (value as { name?: unknown }).name === "string") {
    return (value as { name: string }).name;
  }
  return "";
}

// A chainable stub that also records every WHERE condition it receives.
function capturingDb(rowsPerSelect: unknown[][], whereSink: unknown[]) {
  let call = 0;
  return {
    execute: vi.fn().mockResolvedValue({ rows: [] }),
    select: vi.fn(() => {
      const rows = rowsPerSelect[call++] ?? [];
      const builder: Record<string, unknown> = {};
      for (const m of ["from", "orderBy", "limit", "leftJoin", "innerJoin", "groupBy"]) builder[m] = vi.fn(() => builder);
      builder.where = vi.fn((cond: unknown) => {
        whereSink.push(cond);
        return builder;
      });
      (builder as { then: unknown }).then = (resolve: (v: unknown) => unknown) => resolve(rows);
      return builder;
    }),
  };
}

/**
 * Offline composition proof for the unified global search: the per-entity FIELD sets (the
 * superset over the old FTS columns) are proven by the *-search-field-set tests; here we prove
 * globalSearch COMPOSES all five business entities, surfaces the three the old global search
 * missed (company/lead/property), and includes terminal deals FINDABLE + MARKED.
 */
describe("globalSearch — unified composition + additions (single office, rep)", () => {
  it("returns companies, leads and properties as their own result groups, and marks won deals", async () => {
    // Single-office (no director role) -> runs entity searches on the passed tenantDb in order:
    // deals, contacts, files(execute), companies, leads, properties.
    const execute = vi.fn().mockResolvedValue({ rows: [] }); // searchFiles -> none

    const select = vi.fn(() => chainable([]));
    select.mockReturnValueOnce(
      chainable([
        { id: "deal-won", name: "Acme Tower (Won)", dealNumber: "D-9", projectNumber: null, propertyCity: "Dallas", propertyState: "TX", stageSlug: WON_SLUG, onHold: false },
        { id: "deal-active", name: "Acme Plaza", dealNumber: "D-10", projectNumber: null, propertyCity: "Dallas", propertyState: "TX", stageSlug: null, onHold: false },
      ])
    ); // searchDeals
    select.mockReturnValueOnce(chainable([])); // searchContacts
    select.mockReturnValueOnce(chainable([{ id: "co-1", name: "Acme Construction", city: "Dallas", state: "TX" }])); // searchCompanies
    select.mockReturnValueOnce(chainable([{ id: "lead-1", name: "Acme Roof Lead", status: "open" }])); // searchLeads
    select.mockReturnValueOnce(chainable([{ id: "prop-1", name: "Acme HQ", address: "100 Main", city: "Dallas", state: "TX" }])); // searchProperties

    const tenantDb = { execute, select };
    const result = await globalSearch(tenantDb as any, "acme");

    // The three entity types the old global search MISSED are now present:
    expect(result.companies.map((c) => c.entityType)).toEqual(["company"]);
    expect(result.companies[0]?.id).toBe("co-1");
    expect(result.leads.map((l) => l.entityType)).toEqual(["lead"]);
    expect(result.leads[0]?.id).toBe("lead-1");
    expect(result.properties.map((p) => p.entityType)).toEqual(["property"]);
    expect(result.properties[0]?.id).toBe("prop-1");

    // Terminal (won) deals are FINDABLE and MARKED, ordered after active ones (not hidden).
    const won = result.deals.find((d) => d.id === "deal-won");
    const active = result.deals.find((d) => d.id === "deal-active");
    expect(won?.status).toBe("won");
    expect(active?.status).toBe("active");
    expect(result.deals[0]?.id).toBe("deal-active"); // active before terminal

    // Backward-compatible shape: deals/contacts/files groups still exist.
    expect(Array.isArray(result.files)).toBe(true);
    expect(result.total).toBe(result.deals.length + result.companies.length + result.leads.length + result.properties.length);
  });
});

describe("globalSearch — rep visibility is office-level (no per-rep restriction)", () => {
  it("does NOT add a per-rep assigned_rep_id restriction for a rep (office scoping + collaboration access is the boundary)", async () => {
    const wheres: unknown[] = [];
    const db = capturingDb([[], [], [], [], []], wheres); // deals, contacts, companies, leads, properties
    await globalSearch(db as any, "acme", undefined, "rep", "rep-1");
    const whereText = wheres.map(extractSqlText).join(" | ");
    // The rep's id is never threaded into a WHERE filter -- they see their whole office's records
    // (matching the collaborative detail path), bounded by the office-scoped tenantDb.
    expect(whereText).not.toContain("rep-1");
  });
});
