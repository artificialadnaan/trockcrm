// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyStoredDealView,
  collectPersistableDealViewParams,
  isPersistableDealViewParam,
  readStoredDealView,
  writeStoredDealView,
} from "./deals-view-preferences";

describe("deals-view-preferences", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => window.localStorage.clear());

  describe("isPersistableDealViewParam — the standing-filter allowlist", () => {
    it("persists the header Rep + timeframe and the base-list dl_ FilterBar dimensions", () => {
      expect(isPersistableDealViewParam("period")).toBe(true);
      expect(isPersistableDealViewParam("assignedRepId")).toBe(true);
      expect(isPersistableDealViewParam("dl_stage")).toBe(true);
      expect(isPersistableDealViewParam("dl_region")).toBe(true);
      expect(isPersistableDealViewParam("dl_sort")).toBe(true);
    });

    it("does NOT persist scope (owned by scope-preferences) or transient drill-down state", () => {
      expect(isPersistableDealViewParam("scope")).toBe(false);
      expect(isPersistableDealViewParam("filter")).toBe(false);
      expect(isPersistableDealViewParam("fb_stage")).toBe(false);
      expect(isPersistableDealViewParam("terminal")).toBe(false);
      expect(isPersistableDealViewParam("estimate")).toBe(false);
      expect(isPersistableDealViewParam("won_from")).toBe(false);
      expect(isPersistableDealViewParam("lost_to")).toBe(false);
    });
  });

  describe("collectPersistableDealViewParams", () => {
    it("keeps only the persistable params and drops empties", () => {
      const collected = collectPersistableDealViewParams(
        "scope=all&period=ytd&assignedRepId=rep-1&filter=at_risk&dl_stage=estimating&fb_region=x&assignedRepId2=&dl_empty=",
      );
      expect(collected).toEqual({ period: "ytd", assignedRepId: "rep-1", dl_stage: "estimating" });
    });
  });

  describe("applyStoredDealView", () => {
    it("fills stored params the URL is missing, and leaves present params untouched (URL wins)", () => {
      const next = applyStoredDealView("assignedRepId=explicit", {
        period: "ytd",
        assignedRepId: "stored-rep",
        dl_stage: "estimating",
      });
      const params = new URLSearchParams(next ?? "");
      expect(params.get("assignedRepId")).toBe("explicit"); // URL wins over the stored value
      expect(params.get("period")).toBe("ytd");
      expect(params.get("dl_stage")).toBe("estimating");
    });

    it("returns null when nothing needs filling (all present or store empty)", () => {
      expect(applyStoredDealView("period=ytd", { period: "ytd" })).toBeNull();
      expect(applyStoredDealView("", {})).toBeNull();
    });

    it("never resurrects a non-persistable key from the store", () => {
      expect(applyStoredDealView("", { filter: "at_risk", scope: "all" } as Record<string, string>)).toBeNull();
    });
  });

  describe("read/write round-trip (per-user localStorage)", () => {
    it("round-trips the persistable subset for a user", () => {
      writeStoredDealView("user-1", { period: "mtd", assignedRepId: "rep-9", dl_region: "west" });
      expect(readStoredDealView("user-1")).toEqual({ period: "mtd", assignedRepId: "rep-9", dl_region: "west" });
    });

    it("is per-user and empty for an unknown user", () => {
      writeStoredDealView("user-1", { period: "ytd" });
      expect(readStoredDealView("user-2")).toEqual({});
      expect(readStoredDealView(null)).toEqual({});
    });

    it("re-filters on read so a stale non-persistable key can't leak back", () => {
      window.localStorage.setItem(
        "deals-view-preference:user-1",
        JSON.stringify({ period: "ytd", filter: "at_risk", scope: "all" }),
      );
      expect(readStoredDealView("user-1")).toEqual({ period: "ytd" });
    });

    it("survives malformed stored JSON", () => {
      window.localStorage.setItem("deals-view-preference:user-1", "{not json");
      expect(readStoredDealView("user-1")).toEqual({});
    });
  });
});
