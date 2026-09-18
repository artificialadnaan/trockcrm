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

const { sameAuditValue, onlyRealChanges } = __auditTestables;

describe("sameAuditValue — compares like the database, not like a string", () => {
  it("treats numerically equal renderings as unchanged", () => {
    // The exact pair that appeared on every deal, every run.
    expect(sameAuditValue("0.00", "0")).toBe(true);
    expect(sameAuditValue("737.70", "737.7049180327868")).toBe(false);
    expect(sameAuditValue("39.0000", "39")).toBe(true);
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
