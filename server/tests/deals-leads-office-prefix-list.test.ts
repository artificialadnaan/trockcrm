import { describe, expect, it, vi } from "vitest";

vi.mock("../src/db.js", () => ({ db: {} as any, pool: {} as any }));

// Office code is a cosmetic project-number PREFIX, not an access boundary. The active-office SCHEMA
// (search_path) is the only boundary, so the deal/lead LIST reads must NOT additionally filter by
// office_code — otherwise an ATL-prefixed deal/lead created on the Dallas schema would be hidden from
// the Dallas reps who created it. These lock that the office-scope condition no longer references
// office_code (the list shows every record in the active office's schema regardless of prefix).
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

// A fully-resolved DFW office scope — pre-fix this produced an `office_code = 'dfw'` predicate.
const dfwScope = { activeOfficeId: "office-dallas", officeCode: "dfw", officeUserIds: ["user-1", "user-2"] };

describe("office_code is cosmetic — deal/lead list reads are not office-filtered", () => {
  it("buildDealOfficeScopeCondition emits no office_code predicate", async () => {
    const { buildDealOfficeScopeCondition } = await import("../src/modules/deals/service.js");
    const text = extractSqlText(buildDealOfficeScopeCondition("d", dfwScope));
    expect(text).not.toContain("office_code");
  });

  it("buildLeadOfficeScopeCondition emits no office_code predicate", async () => {
    const { buildLeadOfficeScopeCondition } = await import("../src/modules/leads/service.js");
    const text = extractSqlText(buildLeadOfficeScopeCondition("l", dfwScope));
    expect(text).not.toContain("office_code");
  });
});
