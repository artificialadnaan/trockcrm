import { describe, expect, it, vi } from "vitest";
import { computeWeeklyTrend } from "../../../src/modules/reports/monday-showcase-service.js";
import { sundayWeekStart } from "../../../src/lib/period.js";

// CodeRabbit downstream FIX 1 — the 8-week Momentum trend (A2 sparkline / A3 lanes / Rep-pack) is
// Sunday-grouped server-side. computeWeeklyTrend previously anchored its 8 buckets on the PERIOD START
// (`from`). For weekly modes `from` IS a Sunday, but for MTD/YTD `from` is first-of-month / Jan-1, which
// is usually NOT a Sunday — so the trend (a) ended at the start of the month/year instead of near today
// and (b) emitted non-Sunday buckets that miss the Sunday-grouped query rows. The fix anchors the 8
// weeks on the Sunday of the CURRENT PERIOD END (`to`), which is mode-agnostic and a no-op for weekly
// modes. A mock tenantDb (no DB) is enough: we only assert the bucket SHAPE (count, Sunday alignment,
// ends-at-current-week), not the values.

function mockTenantDb() {
  return { execute: vi.fn().mockResolvedValue({ rows: [] }) } as any;
}

const utcDow = (iso: string) => new Date(`${iso}T12:00:00Z`).getUTCDay(); // 0 = Sunday
const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

describe("computeWeeklyTrend — Sunday anchor derived from the period END (mode-agnostic)", () => {
  it("MTD window (from = first-of-month, a Monday) still yields 8 Sunday-aligned weeks ending at the current week", async () => {
    // to = 2026-06-16 (Tuesday); its week's Sunday is 2026-06-14. from = first-of-month (2026-06-01, a Monday).
    const trend = await computeWeeklyTrend(mockTenantDb(), { from: "2026-06-01", to: "2026-06-16" });
    expect(trend).toHaveLength(8);
    // every bucket is a Sunday (so it aligns to the Sunday-grouped cohort query)
    for (const w of trend) expect(utcDow(w.weekStart)).toBe(0);
    // ends at the CURRENT week's Sunday — NOT at the month start
    expect(trend.at(-1)!.weekStart).toBe(sundayWeekStart("2026-06-16"));
    expect(trend.at(-1)!.weekStart).toBe("2026-06-14");
    expect(trend[0]!.weekStart).toBe("2026-04-26");
    // consecutive buckets are exactly 7 days apart
    for (let i = 1; i < trend.length; i++) expect(daysBetween(trend[i - 1]!.weekStart, trend[i]!.weekStart)).toBe(7);
  });

  it("YTD window (from = Jan-1) trails the CURRENT week, not January", async () => {
    const trend = await computeWeeklyTrend(mockTenantDb(), { from: "2026-01-01", to: "2026-06-16" });
    expect(trend).toHaveLength(8);
    expect(trend.at(-1)!.weekStart).toBe("2026-06-14"); // current week, not Jan
    for (const w of trend) expect(utcDow(w.weekStart)).toBe(0);
  });

  it("weekly modes are unchanged: the anchor still equals `from` (to_date: to=today; completed: to=Saturday)", async () => {
    // to_date: from = this Sunday, to = today (mid-week) -> anchor = this Sunday = from.
    const wtd = await computeWeeklyTrend(mockTenantDb(), { from: "2026-06-14", to: "2026-06-16" });
    expect(wtd.at(-1)!.weekStart).toBe("2026-06-14");
    // completed: from = prior Sunday, to = prior Saturday -> anchor = prior Sunday = from.
    const completed = await computeWeeklyTrend(mockTenantDb(), { from: "2026-06-07", to: "2026-06-13" });
    expect(completed.at(-1)!.weekStart).toBe("2026-06-07");
  });
});
