import { describe, expect, it, vi } from "vitest";
import { presetToDateRange } from "./use-director-dashboard";
import { resolveDatePreset } from "@/lib/pipeline-terminal-filters";

describe("presetToDateRange", () => {
  it("derives date presets from the canonical LOCAL-calendar resolver (consolidated)", () => {
    vi.useFakeTimers();
    // Local-constructed instant so the test is deterministic across runner time zones (the
    // consolidated resolver reads LOCAL calendar fields). March 1 2026, midday local.
    // NOTE: presetToDateRange now resolves on the LOCAL calendar (was UTC) — the platform-wide
    // consolidation. This shifts every consumer (director dashboard, team commissions, and the
    // director rep-detail / P2 surface via this shared hook) to local month/quarter/year boundaries.
    vi.setSystemTime(new Date(2026, 2, 1, 12, 0, 0));

    expect(presetToDateRange("mtd")).toEqual({ from: "2026-03-01", to: "2026-03-01" });
    expect(presetToDateRange("qtd")).toEqual({ from: "2026-01-01", to: "2026-03-01" });
    expect(presetToDateRange("ytd")).toEqual({ from: "2026-01-01", to: "2026-03-01" });
    expect(presetToDateRange("last_month")).toEqual({ from: "2026-02-01", to: "2026-02-28" });

    // Delegates to the canonical resolver — one window math platform-wide.
    for (const p of ["mtd", "qtd", "ytd", "last_month", "last_quarter", "last_year"] as const) {
      expect(presetToDateRange(p)).toEqual(resolveDatePreset(p));
    }
    expect(presetToDateRange("custom")).toEqual(resolveDatePreset("ytd")); // custom -> ytd fallback

    vi.useRealTimers();
  });
});
