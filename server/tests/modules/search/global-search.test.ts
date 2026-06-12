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
  // inArray(col, [...]) emits its values as a bare Array chunk of Params; walk it.
  if (Array.isArray(value)) return value.map(extractSqlText).join("");
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

// A chainable stub that records every WHERE condition (and optionally the ORDER BY terms) it
// receives. One entry is pushed per .select() call, in call order.
function capturingDb(rowsPerSelect: unknown[][], whereSink: unknown[], orderSink?: unknown[][]) {
  let call = 0;
  return {
    execute: vi.fn().mockResolvedValue({ rows: [] }),
    select: vi.fn(() => {
      const rows = rowsPerSelect[call++] ?? [];
      const builder: Record<string, unknown> = {};
      for (const m of ["from", "limit", "leftJoin", "innerJoin", "groupBy"]) builder[m] = vi.fn(() => builder);
      builder.where = vi.fn((cond: unknown) => {
        whereSink.push(cond);
        return builder;
      });
      builder.orderBy = vi.fn((...terms: unknown[]) => {
        orderSink?.push(terms);
        return builder;
      });
      (builder as { then: unknown }).then = (resolve: (v: unknown) => unknown) => resolve(rows);
      return builder;
    }),
  };
}

// Select order inside runEntitySearches (files use .execute, not .select): deals, contacts,
// companies, leads, properties. whereSink[i] / orderSink[i] line up with this order.
const SELECT_ORDER = ["deals", "contacts", "companies", "leads", "properties"] as const;

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
        { id: "deal-won", name: "Acme Tower (Won)", dealNumber: "D-9", projectNumber: null, propertyCity: "Dallas", propertyState: "TX", stageSlug: WON_SLUG, onHold: false, relevance: 2 },
        { id: "deal-active", name: "Acme Plaza", dealNumber: "D-10", projectNumber: null, propertyCity: "Dallas", propertyState: "TX", stageSlug: null, onHold: false, relevance: 1 },
      ])
    ); // searchDeals
    select.mockReturnValueOnce(chainable([])); // searchContacts
    select.mockReturnValueOnce(chainable([{ id: "co-1", name: "Acme Construction", city: "Dallas", state: "TX", relevance: 3 }])); // searchCompanies
    select.mockReturnValueOnce(chainable([{ id: "lead-1", name: "Acme Roof Lead", status: "open", relevance: 2 }])); // searchLeads
    // prop-1 matched only on zip (relevance computed over name/address/city/state/zip in SQL) -> the
    // merge rank must come from that relevance, not a name/address/city-only JS score (would be 0).
    select.mockReturnValueOnce(chainable([{ id: "prop-1", name: "Acme HQ", address: "100 Main", city: "Dallas", state: "TX", relevance: 3 }])); // searchProperties

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

    // The merge rank is the SQL relevance (NOT a narrower JS score), so a property that matched only
    // on zip/state still carries a real rank and can't be merged out as rank 0.
    expect(result.companies[0]?.rank).toBe(3);
    expect(result.leads[0]?.rank).toBe(2);
    expect(result.properties[0]?.rank).toBe(3);
    expect(won?.rank).toBe(2);
    expect(active?.rank).toBe(1);
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

describe("globalSearch — terminal leads stay findable (parity with won AND lost deals)", () => {
  it("includes BOTH converted and disqualified alongside is_active so closing a lead doesn't hide it", async () => {
    const wheres: unknown[] = [];
    const db = capturingDb([[], [], [], [], []], wheres);
    await globalSearch(db as any, "acme");
    const leadWhere = extractSqlText(wheres[SELECT_ORDER.indexOf("leads")]).toLowerCase();
    // Conversion sets is_active=false + status='converted'; disqualifying sets is_active=false +
    // status='disqualified'. Mirroring deals surfacing both won AND lost, the findable filter must
    // allow both terminal states -- otherwise the converted-deal-number match path can never return
    // the lead, and disqualified leads (a viewable record class) vanish from global search.
    expect(leadWhere).toContain("is_active");
    expect(leadWhere).toContain("converted");
    expect(leadWhere).toContain("disqualified");
  });
});

describe("globalSearch — relevance ordering covers every matched own field (no pre-LIMIT drop)", () => {
  it("ranks each entity over the same own columns its builder matches, not just name", async () => {
    const wheres: unknown[] = [];
    const orders: unknown[][] = [];
    const db = capturingDb([[], [], [], [], []], wheres, orders);
    await globalSearch(db as any, "acme");
    const orderText = (entity: (typeof SELECT_ORDER)[number]) =>
      orders[SELECT_ORDER.indexOf(entity)].map(extractSqlText).join(" ").toLowerCase();

    // Deals: location + bid-board customer must be ranked, not just name/number.
    expect(orderText("deals")).toContain("property_city");
    expect(orderText("deals")).toContain("bid_board_customer_name");
    // Contacts (the field Codex flagged): phone + city must be ranked, not just name/email/company,
    // and the derived full-name CONCAT (the "||" string-concat the builder matches) must be ranked
    // too so a two-word full-name query isn't dropped before the limit.
    expect(orderText("contacts")).toContain("phone");
    expect(orderText("contacts")).toContain("city");
    expect(orderText("contacts")).toContain("||");
    // Companies: city + state (builder matches them) must be ranked.
    expect(orderText("companies")).toContain("city");
    expect(orderText("companies")).toContain("state");
    // Leads: source must be ranked, not just name.
    expect(orderText("leads")).toContain("source");
    // Properties: zip + state must be ranked.
    expect(orderText("properties")).toContain("zip");
    expect(orderText("properties")).toContain("state");
  });
});

describe("globalSearch — change-order child deals are flagged for badging", () => {
  it("surfaces isChangeOrder on deal results so PR3 can badge CO children (and never on plain deals)", async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    const select = vi.fn(() => chainable([]));
    select.mockReturnValueOnce(
      chainable([
        { id: "deal-co", name: "Acme Tower — Change Order 1", dealNumber: "D-11", projectNumber: "P-1", propertyCity: "Dallas", propertyState: "TX", stageSlug: WON_SLUG, onHold: false, isChangeOrder: true, relevance: 2 },
        { id: "deal-plain", name: "Acme Plaza", dealNumber: "D-10", projectNumber: null, propertyCity: "Dallas", propertyState: "TX", stageSlug: null, onHold: false, isChangeOrder: false, relevance: 1 },
      ])
    ); // searchDeals
    const result = await globalSearch({ execute, select } as any, "acme");
    expect(result.deals.find((d) => d.id === "deal-co")?.isChangeOrder).toBe(true);
    expect(result.deals.find((d) => d.id === "deal-plain")?.isChangeOrder).toBe(false);
  });

  it("excludes soft-deleted terminal deals (Won + CO children) from the deal search (no deep-link to a deleted deal)", async () => {
    const wheres: unknown[] = [];
    const db = capturingDb([[], [], [], [], []], wheres);
    await globalSearch(db as any, "acme");
    // The deal WHERE excludes ALL inactive terminal rows (broadened from CO-children-only): a soft-deleted
    // Won — CO child or plain — is terminal-staged, so the terminal-findable rule would otherwise keep it
    // searchable + deep-linkable. Renders as NOT (slug IN <terminal> AND is_active = false).
    const dealWhere = extractSqlText(wheres[SELECT_ORDER.indexOf("deals")]).toLowerCase();
    expect(dealWhere).toContain("is_active = false");
  });
});
