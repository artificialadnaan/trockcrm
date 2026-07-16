// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyStoredDealView,
  isBareDealsView,
  isPersistableDealViewParam,
  readStoredDealView,
  writeStoredDealView,
} from "./deals-view-preferences";

describe("deals-view-preferences", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => window.localStorage.clear());

  describe("isPersistableDealViewParam — the standing-filter allowlist", () => {
    it("persists the header Rep + timeframe", () => {
      expect(isPersistableDealViewParam("period")).toBe(true);
      expect(isPersistableDealViewParam("assignedRepId")).toBe(true);
    });

    it("does NOT persist scope, the base-list FilterBar (dl_), or transient drill-down state", () => {
      expect(isPersistableDealViewParam("scope")).toBe(false); // owned by scope-preferences
      expect(isPersistableDealViewParam("dl_stage")).toBe(false); // dropped by drill-downs — deferred
      expect(isPersistableDealViewParam("dl_page")).toBe(false); // pagination is not a filter
      expect(isPersistableDealViewParam("filter")).toBe(false);
      expect(isPersistableDealViewParam("fb_stage")).toBe(false);
      expect(isPersistableDealViewParam("terminal")).toBe(false);
      expect(isPersistableDealViewParam("estimate")).toBe(false);
      expect(isPersistableDealViewParam("won_from")).toBe(false);
      expect(isPersistableDealViewParam("lost_to")).toBe(false);
    });
  });

  describe("isBareDealsView — only a bare view is safe to hydrate into", () => {
    it("treats an empty query or context-only (scope / officeId) as bare", () => {
      expect(isBareDealsView("")).toBe(true);
      expect(isBareDealsView("scope=all")).toBe(true);
      expect(isBareDealsView("scope=mine")).toBe(true);
      expect(isBareDealsView("officeId=office-b")).toBe(true); // cross-office context, still bare
      expect(isBareDealsView("scope=all&officeId=office-b")).toBe(true);
    });

    it("treats any authoritative link (filter / dl_ base-list / explicit period-rep) as NOT bare", () => {
      expect(isBareDealsView("scope=all&filter=won")).toBe(false); // drill-down deep link
      expect(isBareDealsView("scope=all&dl_stageIds=estimating")).toBe(false); // base-list link
      expect(isBareDealsView("scope=all&period=ytd")).toBe(false); // explicit timeframe
      expect(isBareDealsView("assignedRepId=rep-1")).toBe(false); // explicit rep
    });
  });

  describe("applyStoredDealView", () => {
    it("fills stored params the URL is missing, and leaves present params untouched (URL wins)", () => {
      const next = applyStoredDealView("assignedRepId=explicit", {
        period: "ytd",
        assignedRepId: "stored-rep",
      });
      const params = new URLSearchParams(next ?? "");
      expect(params.get("assignedRepId")).toBe("explicit"); // URL wins over the stored value
      expect(params.get("period")).toBe("ytd");
    });

    it("returns null when nothing needs filling (all present or store empty)", () => {
      expect(applyStoredDealView("period=ytd", { period: "ytd" })).toBeNull();
      expect(applyStoredDealView("", {})).toBeNull();
    });

    it("never resurrects a non-persistable key from the store", () => {
      expect(applyStoredDealView("", { filter: "at_risk", scope: "all" } as Record<string, string>)).toBeNull();
    });
  });

  describe("read/write round-trip (per-user + per-office localStorage)", () => {
    it("round-trips the persistable subset for a user + office", () => {
      writeStoredDealView("user-1", "office-a", { period: "mtd", assignedRepId: "rep-9" });
      expect(readStoredDealView("user-1", "office-a")).toEqual({ period: "mtd", assignedRepId: "rep-9" });
    });

    it("is keyed per-office — an office-A rep does NOT leak into office B", () => {
      writeStoredDealView("user-1", "office-a", { period: "ytd", assignedRepId: "rep-a" });
      expect(readStoredDealView("user-1", "office-b")).toEqual({});
    });

    it("is per-user and empty for an unknown user / null user", () => {
      writeStoredDealView("user-1", "office-a", { period: "ytd" });
      expect(readStoredDealView("user-2", "office-a")).toEqual({});
      expect(readStoredDealView(null, "office-a")).toEqual({});
    });

    it("returns an empty object for a null / undefined officeId (nothing stored under the default key)", () => {
      expect(readStoredDealView("user-1", null)).toEqual({});
      expect(readStoredDealView("user-1", undefined)).toEqual({});
    });

    it("re-filters on read so a stale non-persistable key (incl. a since-removed dl_) can't leak back", () => {
      window.localStorage.setItem(
        "deals-view-preference:user-1:office-a",
        JSON.stringify({ period: "ytd", filter: "at_risk", scope: "all", dl_stage: "estimating" }),
      );
      expect(readStoredDealView("user-1", "office-a")).toEqual({ period: "ytd" });
    });

    it("drops a persistable key whose stored value is not a string (e.g. a corrupted period: 5)", () => {
      window.localStorage.setItem(
        "deals-view-preference:user-1:office-a",
        JSON.stringify({ period: 5, assignedRepId: "rep-1" }),
      );
      expect(readStoredDealView("user-1", "office-a")).toEqual({ assignedRepId: "rep-1" });
    });

    it("survives malformed stored JSON", () => {
      window.localStorage.setItem("deals-view-preference:user-1:office-a", "{not json");
      expect(readStoredDealView("user-1", "office-a")).toEqual({});
    });
  });
});
