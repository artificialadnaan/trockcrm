import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/db.js", () => ({
  db: {} as any,
  pool: {} as any,
}));

// Walks a drizzle SQL object (queryChunks / Param / Column / Table) into a flat
// string so we can assert on the columns + literal SQL a builder emits, without a
// live database. Mirrors the helper proven in deals-created-filter.test.ts.
function extractSqlText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  if (Array.isArray((value as { queryChunks?: unknown[] }).queryChunks)) {
    return (value as { queryChunks: unknown[] }).queryChunks.map(extractSqlText).join("");
  }
  if ("value" in (value as Record<string, unknown>)) {
    const chunkValue = (value as { value: unknown }).value;
    if (Array.isArray(chunkValue)) return chunkValue.map(extractSqlText).join("");
    if (typeof chunkValue === "string") return chunkValue;
  }
  if ("name" in (value as Record<string, unknown>) && typeof (value as { name?: unknown }).name === "string") {
    return (value as { name: string }).name;
  }
  return "";
}

function createTenantDbCapturingWhere() {
  const capturedWheres: unknown[] = [];

  const dataChain: any = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockImplementation((condition: unknown) => {
      capturedWheres.push(condition);
      return dataChain;
    }),
    leftJoin: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    offset: vi.fn().mockResolvedValue([]),
  };

  dataChain.then = vi.fn((resolve: any) => resolve([{ count: 0 }]));

  return {
    db: { select: vi.fn().mockReturnValue(dataChain) } as any,
    capturedWheres,
  };
}

describe("buildDealSearchCondition — unified deal search field set", () => {
  it("preserves every legacy deals-list search field (superset, no regression)", async () => {
    const { buildDealSearchCondition } = await import("../src/modules/search/unified-search.js");
    const sql = extractSqlText(buildDealSearchCondition("acme"));

    // The pre-unified deals-list search matched: name, deal_number, description,
    // property_address, and company.name via an EXISTS join (deals.company_id).
    // Every one must remain so no id the old bar found is lost.
    expect(sql).toContain("name");
    expect(sql).toContain("deal_number");
    expect(sql).toContain("description");
    expect(sql).toContain("property_address");
    expect(sql).toContain("company_id"); // company-name EXISTS join key
  });

  it("adds the intended new fields: project_number, city/state, customer, contact, owner", async () => {
    const { buildDealSearchCondition } = await import("../src/modules/search/unified-search.js");
    const sql = extractSqlText(buildDealSearchCondition("acme"));

    expect(sql).toContain("project_number");
    expect(sql).toContain("property_city");
    expect(sql).toContain("property_state");
    expect(sql).toContain("bid_board_customer_name");
    // primary contact name (EXISTS on deals.primary_contact_id)
    expect(sql).toContain("primary_contact_id");
    expect(sql).toContain("first_name");
    expect(sql).toContain("last_name");
    // owner display name (EXISTS on deals.assigned_rep_id -> public.users)
    expect(sql).toContain("assigned_rep_id");
    expect(sql).toContain("display_name");
  });

  it("uses escaped ILIKE substring matching (not full-text, not prefix)", async () => {
    const { buildDealSearchCondition } = await import("../src/modules/search/unified-search.js");
    const sql = extractSqlText(buildDealSearchCondition("acme"));

    expect(sql).toMatch(/ilike/i);
    expect(sql).toContain("ESCAPE");
    // substring wrap: %term% with literal-% escaping applied to the term itself
    expect(sql).toContain("%acme%");
  });

  it("escapes LIKE metacharacters in the user term", async () => {
    const { buildDealSearchCondition } = await import("../src/modules/search/unified-search.js");
    const sql = extractSqlText(buildDealSearchCondition("50%_x"));
    // % and _ in the user input must be escaped so they match literally.
    expect(sql).toContain("50\\%\\_x");
  });

  it("does not gate on deal lifecycle, so won/lost/on-hold remain findable", async () => {
    const { buildDealSearchCondition } = await import("../src/modules/search/unified-search.js");
    const sql = extractSqlText(buildDealSearchCondition("acme"));

    // The search predicate is purely field-matching; the caller's isActive filter
    // (unchanged) decides lifecycle visibility. The builder itself must not exclude
    // terminal deals.
    expect(sql).not.toContain("is_active");
    expect(sql).not.toContain("on_hold");
  });
});

describe("getDeals — routes filters.search through the unified deal builder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emits the expanded field set (project_number, customer, owner) for a search", async () => {
    const { db, capturedWheres } = createTenantDbCapturingWhere();
    const { getDeals } = await import("../src/modules/deals/service.js");

    await getDeals(db, { search: "acme", limit: 25 }, "director", "director-1");

    const sql = capturedWheres.map(extractSqlText).join("\n");
    // These three appear ONLY in the new unified builder, never in the old inline
    // OR-block, so their presence proves getDeals is wired to it.
    expect(sql).toContain("project_number");
    expect(sql).toContain("bid_board_customer_name");
    expect(sql).toContain("display_name");
  });

  it("does not search when the term is shorter than 2 characters", async () => {
    const { db, capturedWheres } = createTenantDbCapturingWhere();
    const { getDeals } = await import("../src/modules/deals/service.js");

    await getDeals(db, { search: "a", limit: 25 }, "director", "director-1");

    const sql = capturedWheres.map(extractSqlText).join("\n");
    expect(sql).not.toContain("bid_board_customer_name");
  });
});
