import { describe, expect, it, vi } from "vitest";
import { getDirectorRepCommissionRows } from "../../../src/modules/dashboard/service.js";

/**
 * The Team Commissions roster drives which rows the table renders. `users` is a single GLOBAL table, so
 * without an office bound a cross-office rep — including one a Bid Board estimator map points at — would be
 * credited for this tenant's deals (owner OR estimator). When an officeId is supplied the roster query must
 * scope to active-office membership (primary office OR a user_office_access grant); when omitted it stays
 * global (back-compat for other callers/tests). No DB: capture the roster SQL and inspect it. An empty
 * roster short-circuits before any per-rep work.
 */
function extractSqlText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const chunks = (value as { queryChunks?: unknown[] }).queryChunks;
  if (Array.isArray(chunks)) return chunks.map(extractSqlText).join("");
  if ("value" in (value as Record<string, unknown>)) {
    const v = (value as { value: unknown }).value;
    if (Array.isArray(v)) return v.map(extractSqlText).join("");
    if (typeof v === "string") return v;
  }
  return "";
}

function mockTenantDb() {
  return { execute: vi.fn().mockResolvedValue({ rows: [] }) } as any;
}

describe("getDirectorRepCommissionRows roster office scope", () => {
  it("scopes the roster to active-office membership when an officeId is supplied", async () => {
    const tdb = mockTenantDb();
    await getDirectorRepCommissionRows(tdb, { from: "2026-01-01", to: "2026-12-31", officeId: "11111111-1111-1111-1111-111111111111" });
    const sql = extractSqlText(tdb.execute.mock.calls[0][0]).toLowerCase();
    expect(sql).toContain("role = 'rep'");
    expect(sql).toContain("user_office_access"); // the membership grant check
    expect(sql).toContain("u.office_id"); // primary-office membership
  });

  it("stays global (no office predicate) when officeId is omitted", async () => {
    const tdb = mockTenantDb();
    await getDirectorRepCommissionRows(tdb, { from: "2026-01-01", to: "2026-12-31" });
    const sql = extractSqlText(tdb.execute.mock.calls[0][0]).toLowerCase();
    expect(sql).toContain("role = 'rep'");
    expect(sql).not.toContain("user_office_access");
  });
});
