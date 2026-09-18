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

const { sameAuditValue, onlyRealChanges, bookkeepingSuppressed } = __auditTestables;

describe("sameAuditValue — compares like the database, not like a string", () => {
  it("treats numerically equal renderings as unchanged", () => {
    // The exact pair that appeared on every deal, every run.
    expect(sameAuditValue("0.00", "0")).toBe(true);
    // REVISED once the rounding was understood: this pair is NOT a change. The column is numeric(14,2),
    // so 737.7049… stores as 737.70 — the write alters nothing. The original assertion here called it a
    // change, which is exactly the churn that kept the mirror at ~7,500 rows per two hours.
    expect(sameAuditValue("737.70", "737.7049180327868")).toBe(true);
    expect(sameAuditValue("39.0000", "39")).toBe(true);
  });

  it("compares at the STORED precision — a numeric(14,2) column rounds, so full float precision is not a change", () => {
    // Measured live after the first pass of this fix: the heartbeat audits fell 7,476 -> 7 per two hours
    // while the mirror stayed at ~7,500, and every surviving row was a pair like these. The column
    // rounds on write and the export sends full precision, so comparing them as written makes every run
    // a change — and the next write rounds again, forever.
    expect(sameAuditValue("666.67", "666.6666666666666")).toBe(true);
    expect(sameAuditValue("5833.33", "5833.333333333333")).toBe(true);
    expect(sameAuditValue("36066.11", "36066.113517716316")).toBe(true);
    expect(sameAuditValue("583.33", "583.3333333333334")).toBe(true);
  });

  it("still catches a change that survives rounding to the stored scale", () => {
    // The rounding must not swallow real money movement — 737.70 -> 737.71 is a cent, and a cent counts.
    expect(sameAuditValue("737.70", "737.71")).toBe(false);
    expect(sameAuditValue("666.67", "666.68")).toBe(false);
    // A stored integer scale rounds the incoming to an integer, and a half-unit move still differs.
    expect(sameAuditValue("100", "100.4")).toBe(true);
    expect(sameAuditValue("100", "100.6")).toBe(false);
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

describe("bookkeepingSuppressed — the export's clock is not an edit to the deal", () => {
  it("writes nothing when the export timestamp is the only thing that moved", () => {
    // Measured across one post-deploy cycle: 837 of 838 mirror rows carried ONLY this field, after the
    // format fix (#1144) and the precision fix (#1151) had removed everything else. It is the one field
    // no comparison can settle, because it genuinely changes on every run — the same claim
    // `readOnlySyncedAt` was making, and it gets the same answer.
    expect(
      bookkeepingSuppressed({
        bidBoardLastUpdatedAt: { from: "2026-09-18T20:14:12.731Z", to: "2026-09-18T21:46:11.402Z" },
      })
    ).toEqual({});
  });

  it("KEEPS the timestamp as context when something real moved alongside it", () => {
    // It is barred from being the REASON a row exists, not from appearing in one. Losing it would strip
    // useful context from genuine edits.
    const real = {
      bidBoardStatus: { from: "bidding", to: "submitted" },
      bidBoardLastUpdatedAt: { from: "2026-09-18T20:14:12.731Z", to: "2026-09-18T21:46:11.402Z" },
    };
    expect(bookkeepingSuppressed(real)).toEqual(real);
  });

  it("leaves an already-empty map alone, and never invents a row", () => {
    expect(bookkeepingSuppressed({})).toEqual({});
  });

  it("does not suppress a money move that happens to arrive with the timestamp", () => {
    const moved = {
      bidBoardTotalSales: { from: "125000.00", to: "0" },
      bidBoardLastUpdatedAt: { from: "2026-09-18T20:14:12.731Z", to: "2026-09-18T21:46:11.402Z" },
    };
    expect(bookkeepingSuppressed(moved)).toEqual(moved);
  });
});
