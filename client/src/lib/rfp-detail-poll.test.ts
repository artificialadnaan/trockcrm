import { describe, expect, it } from "vitest";
import { isRfpDetailPollActive, RFP_DETAIL_POLL_WINDOW_MS } from "./rfp-detail-poll";

const NOW = new Date("2026-07-06T20:00:00.000Z").getTime();
const isoAgo = (msAgo: number) => new Date(NOW - msAgo).toISOString();

describe("isRfpDetailPollActive", () => {
  it("polls a recently-requested pending / pending_outbox RFP", () => {
    expect(isRfpDetailPollActive("pending", isoAgo(30_000), NOW)).toBe(true);
    expect(isRfpDetailPollActive("pending_outbox", isoAgo(60_000), NOW)).toBe(true);
  });

  it("does NOT poll a request older than the window (legacy stuck 'pending' deals stop refreshing)", () => {
    expect(isRfpDetailPollActive("pending", isoAgo(RFP_DETAIL_POLL_WINDOW_MS + 1000), NOW)).toBe(false);
    expect(isRfpDetailPollActive("pending", isoAgo(3 * 24 * 60 * 60 * 1000), NOW)).toBe(false); // days old
  });

  it("does NOT poll a non-pending status or an unstamped / unparseable request", () => {
    expect(isRfpDetailPollActive("approved", isoAgo(30_000), NOW)).toBe(false);
    expect(isRfpDetailPollActive("send_failed", isoAgo(30_000), NOW)).toBe(false);
    expect(isRfpDetailPollActive(null, isoAgo(30_000), NOW)).toBe(false);
    expect(isRfpDetailPollActive("pending", null, NOW)).toBe(false);
    expect(isRfpDetailPollActive("pending", "not-a-date", NOW)).toBe(false);
  });

  it("polls right at the window boundary but not past it", () => {
    expect(isRfpDetailPollActive("pending", isoAgo(RFP_DETAIL_POLL_WINDOW_MS), NOW)).toBe(true);
    expect(isRfpDetailPollActive("pending", isoAgo(RFP_DETAIL_POLL_WINDOW_MS + 1), NOW)).toBe(false);
  });
});
