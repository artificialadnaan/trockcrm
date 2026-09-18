// =============================================================================
// Bid Board sync — an audit row is an EDIT, not a heartbeat.
//
// office_dallas.audit_log reached 22.7M rows / 18 GB. Of the 256,663 rows written in one 24-hour
// window, 126,439 came from these two writers and essentially none of them recorded a change:
//
//   bid_board_mirror        63,226   16 fields listed, ~14 of them identical from/to
//   stage_metadata_refresh  63,213   three unchanged stage fields + {from: null, to: "now"}
//
// Two shapes made unchanged values look like edits, and both are comparison bugs rather than write bugs:
// Postgres renders numeric(14,2) as "0.00" while the incoming side is normalized to "0", and a
// timestamptz returns a Date while the export sends an ISO string. The write was normalized; the
// COMPARISON was not.
// =============================================================================

import { describe, it, expect } from "vitest";

import { __auditTestables } from "../../../src/modules/bid-board-sync/service.js";

const { sameAuditValue, onlyRealChanges, hasSubstantiveChange, AUDIT_NUMERIC_SCALES, roundDecimalStringLikePostgres } =
  __auditTestables;

describe("sameAuditValue — compares like the database, not like a string", () => {
  // REWRITTEN after review. The previous version of this test asserted the defect as correct, twice:
  // it applied numeric equivalence with no field context, and it pinned
  // `("737.70", "737.7049180327868") -> false`. Both sides of that pair are stored as 737.70 in a
  // numeric(14,2) column, so calling it a change is the per-cycle treadmill this PR exists to stop.
  it("treats numerically equal renderings as unchanged — AT THE COLUMN'S SCALE", () => {
    // The exact pair that appeared on every deal, every run.
    expect(sameAuditValue("0.00", "0", 2)).toBe(true);
    expect(sameAuditValue("39.0000", "39", 4)).toBe(true);
    // Postgres stores this incoming value as 737.70. It did not move.
    expect(sameAuditValue("737.70", "737.7049180327868", 2)).toBe(true);
    // ...but a difference that survives rounding to the stored scale is a real change.
    expect(sameAuditValue("737.70", "737.71", 2)).toBe(false);
    // At a finer scale the same pair IS a change, which is why the scale has to come from the column.
    expect(sameAuditValue("737.70", "737.7049180327868", 4)).toBe(false);
  });

  it("applies numeric equivalence ONLY to fields that are numeric columns", () => {
    // No scale => exact comparison. A text column whose value happens to be digits must keep its edit:
    // bid_board_project_number going 00123 -> 123 is a genuine change Postgres stores distinctly, and an
    // audit that silently drops it is worse than one that is merely noisy.
    expect(sameAuditValue("00123", "123")).toBe(false);
    expect(onlyRealChanges({ bidBoardProjectNumber: { from: "00123", to: "123" } })).toEqual({
      bidBoardProjectNumber: { from: "00123", to: "123" },
    });
    // Long digit strings must not collapse through float precision either.
    expect(sameAuditValue("900719925474099100", "900719925474099200")).toBe(false);
  });

  it("names only columns Postgres actually stores as numeric", () => {
    // Verified against production information_schema: sales_price_per_area LOOKS numeric and is TEXT.
    expect(AUDIT_NUMERIC_SCALES).toEqual({
      bidBoardProjectCost: 2,
      bidBoardProfitMarginPct: 4,
      bidBoardTotalSales: 2,
    });
    expect(AUDIT_NUMERIC_SCALES).not.toHaveProperty("bidBoardSalesPricePerArea");
    expect(AUDIT_NUMERIC_SCALES).not.toHaveProperty("bidBoardProjectNumber");
  });

  it("treats the same instant as unchanged across Date and ISO string", () => {
    const iso = "2026-09-17T16:54:07.004Z";
    expect(sameAuditValue(new Date(iso), iso)).toBe(true);
    expect(sameAuditValue(new Date(iso), "2026-09-18T00:14:12.731Z")).toBe(false);
  });

  it("treats null, undefined and empty string as the same absence", () => {
    expect(sameAuditValue(null, undefined)).toBe(true);
    expect(sameAuditValue("", null)).toBe(true);
    // …but absence appearing or disappearing IS a change.
    expect(sameAuditValue(null, "Dallas")).toBe(false);
    expect(sameAuditValue("Dallas", null)).toBe(false);
  });

  it("never coerces a blank or a date into a number", () => {
    // A lenient numeric compare would call these equal and swallow a real edit.
    expect(sameAuditValue("", "0")).toBe(false);
    expect(sameAuditValue("2026", "2026-09-17T16:54:07.004Z")).toBe(false);
  });

  it("keeps ordinary text changes", () => {
    expect(sameAuditValue("estimating", "service_estimating")).toBe(false);
    expect(sameAuditValue("Dallas", "Dallas")).toBe(true);
  });
});

describe("onlyRealChanges — the row lists edits, or is not written", () => {
  it("drops the pairs that did not move", () => {
    const filtered = onlyRealChanges({
      bidBoardTotalSales: { from: "0.00", to: "0" },
      bidBoardProfitMarginPct: { from: "39.0000", to: "39" },
      bidBoardCreatedAt: { from: "2026-09-17T16:54:07.004Z", to: "2026-09-17T16:54:07.004Z" },
      bidBoardStatus: { from: "bidding", to: "submitted" },
    });
    expect(Object.keys(filtered)).toEqual(["bidBoardStatus"]);
  });

  it("returns an empty map when a whole cycle changed nothing — logBidBoardActivity then writes no row", () => {
    // This is the 63k/day case: the sync re-asserted every column and moved none of them.
    const filtered = onlyRealChanges({
      bidBoardStageSlug: { from: "estimating", to: "estimating" },
      bidBoardStageFamily: { from: "precon", to: "precon" },
      bidBoardStageStatus: { from: "bidding", to: "bidding" },
    });
    expect(filtered).toEqual({});
  });

  it("still reports a genuine $0 — suppression is about NO CHANGE, not about zero", () => {
    // A deal really moving to zero must still be audited; only no-ops are dropped.
    expect(onlyRealChanges({ bidBoardTotalSales: { from: "125000.00", to: "0" } })).toEqual({
      bidBoardTotalSales: { from: "125000.00", to: "0" },
    });
  });
});

/**
 * THE FINDING THAT MADE THE WHOLE PR INERT. `bidBoardLastUpdatedAt` is the run's own extractedAt (or
 * now()), so it differs from the stored value on every cycle for every matched row. `onlyRealChanges`
 * therefore never returned an empty map, `logBidBoardActivity` never took its early return, and all
 * ~63k/day mirror rows were still written — each now containing one field instead of eighteen.
 */
describe("hasSubstantiveChange — a heartbeat is not an edit", () => {
  const heartbeat = { bidBoardLastUpdatedAt: { from: "2026-09-17T00:00:00Z", to: "2026-09-18T00:00:00Z" } };

  it("reports NOTHING substantive when only the sync heartbeat moved", () => {
    expect(hasSubstantiveChange(heartbeat)).toBe(false);
    // ...and the heartbeat really does survive onlyRealChanges, which is why emptiness was not enough.
    expect(onlyRealChanges(heartbeat)).toEqual(heartbeat);
  });

  it("reports substantive as soon as any real field moved, heartbeat included in the row", () => {
    const changes = onlyRealChanges({
      ...heartbeat,
      bidBoardStatus: { from: "Bidding", to: "Awarded" },
    });
    expect(hasSubstantiveChange(changes)).toBe(true);
    // The heartbeat is still reported alongside the real edit — it tells you WHEN the edit synced.
    expect(Object.keys(changes).sort()).toEqual(["bidBoardLastUpdatedAt", "bidBoardStatus"]);
  });

  it("an empty map is not substantive either", () => {
    expect(hasSubstantiveChange({})).toBe(false);
  });

  it("CONTROL — a numeric field that genuinely moved is substantive", () => {
    const changes = onlyRealChanges({
      ...heartbeat,
      bidBoardTotalSales: { from: "1000.00", to: "2000.00" },
    });
    expect(hasSubstantiveChange(changes)).toBe(true);
  });

  it("...and one that only LOOKS moved is not", () => {
    const changes = onlyRealChanges({
      ...heartbeat,
      bidBoardTotalSales: { from: "1000.00", to: "1000.004" },
      bidBoardProfitMarginPct: { from: "39.0000", to: "39" },
    });
    expect(hasSubstantiveChange(changes)).toBe(false);
  });
});

/**
 * Rounding has to match the DATABASE, not IEEE-754. Every expectation below was read off production
 * Postgres (`select '<v>'::numeric(14,2)`), not reasoned about — and four of the six sampled values
 * disagree with `Number(v).toFixed(2)`, which is what this code used to do.
 */
describe("roundDecimalStringLikePostgres — rounds like numeric, not like a float", () => {
  // value, scale, what Postgres stores, what Number.toFixed would have said
  const CASES: Array<[string, number, string, string | null]> = [
    ["1.005", 2, "1.01", "1.00"],
    ["-1.005", 2, "-1.01", "-1.00"],
    ["1.015", 2, "1.02", "1.01"],
    ["2.675", 2, "2.68", "2.67"],
    ["737.704918", 2, "737.70", "737.70"],
    ["0.0049", 2, "0.00", "0.00"],
    ["39.0000", 4, "39.0000", null],
    ["0", 2, "0.00", null],
    ["9.999", 2, "10.00", null],
    ["999.995", 2, "1000.00", null],
  ];

  it.each(CASES)("%s at scale %i stores as %s", (value, scale, stored) => {
    expect(roundDecimalStringLikePostgres(value, scale)).toBe(stored);
  });

  it("disagrees with Number.toFixed exactly where Postgres does", () => {
    const divergent = CASES.filter(([, , stored, viaFloat]) => viaFloat != null && viaFloat !== stored);
    expect(divergent.length).toBeGreaterThan(0);
    for (const [value, scale, stored, viaFloat] of divergent) {
      expect(Number(value).toFixed(scale)).toBe(viaFloat);      // what the old code did
      expect(roundDecimalStringLikePostgres(value, scale)).toBe(stored); // what the database does
    }
  });

  it("never reports -0 as different from 0", () => {
    expect(roundDecimalStringLikePostgres("-0.001", 2)).toBe("0.00");
    expect(sameAuditValue("0.00", "-0.001", 2)).toBe(true);
  });

  it("returns null for anything that is not a plain decimal, so exact comparison takes over", () => {
    expect(roundDecimalStringLikePostgres("abc", 2)).toBeNull();
    expect(roundDecimalStringLikePostgres("1e5", 2)).toBeNull();
    expect(roundDecimalStringLikePostgres("", 2)).toBeNull();
  });

  it("carries the boundary case into sameAuditValue, in both directions", () => {
    // Stored 1.00, export sends 1.005 -> Postgres would store 1.01. That IS a change, and rounding
    // through a float hid it — which, with the heartbeat gate, silently dropped the whole audit row.
    expect(sameAuditValue("1.00", "1.005", 2)).toBe(false);
    // ...and the inverse must not manufacture one.
    expect(sameAuditValue("1.01", "1.005", 2)).toBe(true);
  });

  it("does not lose precision on large values the way a float would", () => {
    expect(roundDecimalStringLikePostgres("99999999999.995", 2)).toBe("100000000000.00");
    expect(sameAuditValue("12345678901.23", "12345678901.234", 2)).toBe(true);
    expect(sameAuditValue("12345678901.23", "12345678901.235", 2)).toBe(false);
  });
});
