import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/db.js", () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    then: vi.fn((resolve: (rows: unknown[]) => unknown) => resolve([])),
  },
}));

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

describe("lead search SQL helpers", () => {
  it("matches lead, company, property, and primary-contact fields for list queries", async () => {
    const { buildLeadSearchCondition } = await import("../../../src/modules/leads/service.js");

    const sql = buildLeadSearchCondition("roof");
    const queryText = extractSqlText(sql).toLowerCase();

    expect(queryText).toContain("name ilike");
    expect(queryText).toContain("source ilike");
    expect(queryText).toContain("source_detail ilike");
    expect(queryText).toContain("description ilike");
    expect(queryText).toContain("id = company_id");
    expect(queryText).toContain("id = property_id");
    expect(queryText).toContain("address ilike");
    expect(queryText).toContain("city ilike");
    expect(queryText).toContain("state ilike");
    expect(queryText).toContain("id = primary_contact_id");
    expect(queryText).toContain("first_name ilike");
    expect(queryText).toContain("last_name ilike");
    expect(queryText).toContain("concat(first_name, ' ', last_name) ilike");
    // PR2 additions (superset, no regression): owner display name + the converted deal's
    // deal_number/project_number (deals.source_lead_id = leads.id).
    expect(queryText).toContain("display_name ilike");
    expect(queryText).toContain("source_lead_id");
    expect(queryText).toContain("deal_number ilike");
    expect(queryText).toContain("project_number ilike");
  });

  it("matches lead, company, property, and primary-contact fields for board queries", async () => {
    const { buildAliasedLeadSearchCondition } = await import("../../../src/modules/leads/service.js");

    const sql = buildAliasedLeadSearchCondition("l", "roof");
    const queryText = extractSqlText(sql).toLowerCase();

    expect(queryText).toContain("l.name ilike");
    expect(queryText).toContain("l.source ilike");
    expect(queryText).toContain("l.source_detail ilike");
    expect(queryText).toContain("l.description ilike");
    expect(queryText).toContain("c.name ilike");
    expect(queryText).toContain("p.name ilike");
    expect(queryText).toContain("p.address ilike");
    expect(queryText).toContain("p.city ilike");
    expect(queryText).toContain("p.state ilike");
    expect(queryText).toContain("first_name ilike");
    expect(queryText).toContain("last_name ilike");
    expect(queryText).toContain("primary_contact_id");
    expect(queryText).toContain("concat(first_name, ' ', last_name) ilike");
    // PR2 additions (superset, no regression): owner display name + converted-deal number,
    // matched independently of the board query's own joins via EXISTS on the lead alias.
    expect(queryText).toContain("display_name ilike");
    expect(queryText).toContain("l.assigned_rep_id");
    expect(queryText).toContain("source_lead_id");
    expect(queryText).toContain("deal_number ilike");
    expect(queryText).toContain("project_number ilike");
  });
});
