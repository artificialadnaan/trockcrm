import { describe, expect, it, vi } from "vitest";
import { loadApprovedRecommendationsForRun } from "../../../src/modules/estimating/draft-estimate-service.js";

/**
 * The predicate text of a drizzle condition tree. Same shape as the helper in
 * server/tests/deals-contract-signed-filter.test.ts: query chunks interleave string fragments with
 * column references, and the column objects are circular, so the tree cannot simply be stringified.
 */
function extractSqlText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  if (Array.isArray(value)) return value.map(extractSqlText).join(" ");
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

describe("promoting approved recommendations into an estimate", () => {
  it("REFUSES a recommendation whose extraction no longer has a priceable quantity", async () => {
    // An approval is a statement about a RECOMMENDATION, and a recommendation outlives the quantity it
    // was computed from. Clearing a quantity leaves the approved row untouched, and nothing between the
    // edit and the estimate looked at the extraction again — so a price derived from a number somebody
    // explicitly deleted could be promoted, arriving indistinguishable from any other approved line.
    //
    // Asserted on the WHERE clause rather than against a database because this suite has no DB: what
    // matters is that the query refuses to select such a row at all.
    let captured: unknown;
    const tenantDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          innerJoin: vi.fn(() => ({
            innerJoin: vi.fn(() => ({
              where: vi.fn((condition: unknown) => {
                captured = condition;
                return Promise.resolve([]);
              }),
            })),
          })),
        })),
      })),
    } as any;

    await loadApprovedRecommendationsForRun(tenantDb, "deal-1", "run-1");

    const sqlText = extractSqlText(captured);
    expect(sqlText).toContain("quantity");
    expect(sqlText).toContain("is not null");
    // Nonpositive is refused with null, for the same reason the worker refuses it:
    // `applyMarketRateAdjustment` cannot price it either.
    expect(sqlText).toContain("> 0");
  });
});
