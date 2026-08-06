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
              // `.where(...).for("update")` — the promote also LOCKS the joined extraction, so a
              // quantity-clearing PATCH cannot commit between this read and the line item it creates.
              where: vi.fn((condition: unknown) => {
                captured = condition;
                return { for: vi.fn().mockResolvedValue([]) };
              }),
            })),
          })),
        })),
      })),
    } as any;

    // The gate is now OPT-IN: the wide read that feeds duplicate-group derivation must NOT apply it
    // (filtering a duplicate there makes its sibling look unique). Promotion asks for it on the narrow,
    // locked read — which is the call this test is about.
    await loadApprovedRecommendationsForRun(tenantDb, "deal-1", "run-1", undefined, {
      requirePriceableQuantity: true,
    });

    const sqlText = extractSqlText(captured);
    expect(sqlText).toContain("quantity");
    expect(sqlText).toContain("is not null");
    // Nonpositive is refused with null, for the same reason the worker refuses it:
    // `applyMarketRateAdjustment` cannot price it either.
    expect(sqlText).toContain("> 0");
    // NaN is refused explicitly: Postgres orders numeric NaN ABOVE finite values, so `NaN > 0` is TRUE
    // and the positive test alone would have admitted it into a client estimate.
    expect(sqlText).toContain("NaN");
    // …and a MANUAL row is exempt, because it promotes its own quantity and its extraction match is
    // only an active-artifact anchor.
    expect(sqlText).toContain("manual");
  });

  it("EXEMPTS an override, which promotes its own quantity rather than the extraction's", async () => {
    // `resolvePromotionLineValues` does `case "override": quantity = row.overrideQuantity ?? quantity`,
    // so for these rows the anchor extraction's quantity is not the number that reaches the estimate.
    // Gating on it dropped a complete override as `recommendation_unavailable` — and an override row's
    // `sourceType` is ordinarily `'extracted'`, so it never reached the manual exemption above.
    //
    // The exemption is NOT unconditional: the override's own quantity is held to the same standard,
    // NaN included, or this widening would reintroduce the null-priced-as-one-unit bug the PR removes.
    let captured: unknown;
    const tenantDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          innerJoin: vi.fn(() => ({
            innerJoin: vi.fn(() => ({
              where: vi.fn((condition: unknown) => {
                captured = condition;
                return { for: vi.fn().mockResolvedValue([]) };
              }),
            })),
          })),
        })),
      })),
    } as any;

    // The gate is now OPT-IN: the wide read that feeds duplicate-group derivation must NOT apply it
    // (filtering a duplicate there makes its sibling look unique). Promotion asks for it on the narrow,
    // locked read — which is the call this test is about.
    await loadApprovedRecommendationsForRun(tenantDb, "deal-1", "run-1", undefined, {
      requirePriceableQuantity: true,
    });

    const sqlText = extractSqlText(captured);
    expect(sqlText).toContain("override_quantity");
    expect(sqlText).toContain("selected_source_type");
    // The override's own quantity gets the full triple, not just a presence check — otherwise an
    // override carrying NaN or 0 would promote where an extraction carrying the same would not.
    const overrideClause = sqlText.slice(sqlText.indexOf("selected_source_type"));
    expect(overrideClause).toContain("is not null");
    expect(overrideClause).toContain("> 0");
    expect(overrideClause).toContain("NaN");
  });

  it("does NOT let a healthy extraction rescue an INVALID override quantity", async () => {
    // The alternatives must be mutually exclusive. An override carrying 0, a negative or NaN fails its
    // own alternative — but if the extraction alternative were unconditional, a healthy extraction
    // would admit the row, and `resolvePromotionLineValues` would then promote the INVALID override
    // value, because it prefers a non-null `overrideQuantity` over the fallback. A bad number in a
    // client estimate, on a row the workbench simultaneously called unpromotable.
    let captured: unknown;
    const tenantDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          innerJoin: vi.fn(() => ({
            innerJoin: vi.fn(() => ({
              where: vi.fn((condition: unknown) => {
                captured = condition;
                return { for: vi.fn().mockResolvedValue([]) };
              }),
            })),
          })),
        })),
      })),
    } as any;

    await loadApprovedRecommendationsForRun(tenantDb, "deal-1", "run-1", undefined, {
      requirePriceableQuantity: true,
    });

    const sqlText = extractSqlText(captured);
    // The extraction alternative is GUARDED: it applies only to rows that are not an override, or
    // whose override carries no quantity of its own (the price-only case, which genuinely falls back).
    expect(sqlText).toContain("is distinct from");
    const extractionClause = sqlText.slice(sqlText.lastIndexOf("is distinct from"));
    expect(extractionClause).toContain("is null");
  });

  it("omits the gate entirely when it is not requested, so duplicate derivation sees every row", async () => {
    // Applying the gate to the wide read is a CORRECTNESS bug, not a scoping one: a filtered-out
    // duplicate makes its valid sibling look unique, so the sibling promotes even when the filtered row
    // already holds a promoted line item. The wide read must return the whole approved/overridden set.
    let captured: unknown;
    const tenantDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          innerJoin: vi.fn(() => ({
            innerJoin: vi.fn(() => ({
              where: vi.fn((condition: unknown) => {
                captured = condition;
                return { for: vi.fn().mockResolvedValue([]) };
              }),
            })),
          })),
        })),
      })),
    } as any;

    await loadApprovedRecommendationsForRun(tenantDb, "deal-1", "run-1");

    const sqlText = extractSqlText(captured);
    expect(sqlText).toContain("status");
    expect(sqlText).not.toContain("NaN");
    expect(sqlText).not.toContain("override_quantity");
  });
});
