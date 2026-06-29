import { expect, test, type Page } from "@playwright/test";
import { installCommonApiMocks } from "./helpers/mock-api";
import { SHOWCASE_VARIANTS } from "../src/pages/reports/monday-showcase/types";

// Reports Part 3 -- drill-to-evidence + richer visuals. Mocks the showcase + evidence endpoints so the
// real components render with representative data (DB-independent), asserts a clicked number opens a
// drawer whose total reconciles to it, and captures every consolidated variant + the drawer for design
// review. The variant list is sourced from SHOWCASE_VARIANTS so it can't drift from the registry (the
// 8->5 consolidation removed A1/A2/B1; the Exec survivor is now labeled "Exec · One Glance").

// Screenshots are opt-in (design-review capture); the assertions below run in CI regardless.
const SHOT_DIR = process.env.SHOWCASE_SHOT_DIR;

const BASIS_WON = "Awarded-first won value";
const BASIS_OPEN = "Best current estimate";

function ladder(b0: number, b1: number, b2: number, b3: number, n: number, m: number) {
  return {
    bands: [
      { band: "0_30", count: b0, value: b0 * 130000 },
      { band: "31_60", count: b1, value: b1 * 120000 },
      { band: "61_90", count: b2, value: b2 * 110000 },
      { band: "beyond_90", count: b3, value: b3 * 100000 },
    ],
    // undatedValue = the open $ of the M − N complement (the "No future close date" card). Synthesized
    // for the mock so the B4 undated card renders a plausible $ alongside its M − N count.
    coverage: { n, m, undatedValue: Math.max(0, m - n) * 100000 },
    coverageCaption: `${n} of ${m} open deals have a maintained (future-dated) expected close date.`,
  };
}

function rep(
  repId: string,
  repName: string,
  closedCount: number,
  closedVal: number,
  sent: number,
  bands: [number, number, number, number],
  leads: Array<[string, number]>,
  n: number,
  m: number
) {
  return {
    repId,
    repName,
    closed: { count: closedCount, value: { amount: closedVal, basisLabel: BASIS_WON } },
    projection: ladder(bands[0], bands[1], bands[2], bands[3], n, m),
    sentThisWeek: { count: sent, value: { amount: sent * 160000, basisLabel: BASIS_OPEN } },
    leadStatus: leads.map(([stageLabel, count]) => ({ stageLabel, count })),
  };
}

const showcase = {
  period: { from: "2026-05-24", to: "2026-05-27", mode: "to_date", label: "2026-05-24 → 2026-05-27" },
  departments: [
    { key: "estimating", label: "Estimating", count: 18, value: { amount: 4_200_000, basisLabel: BASIS_OPEN }, deltaCountWoW: 3, sparkline: [10, 12, 9, 14, 11, 16, 13, 18], deferred: false },
    { key: "sent", label: "Sent", count: 13, value: { amount: 2_100_000, basisLabel: BASIS_OPEN }, deltaCountWoW: -2, sparkline: [8, 9, 7, 12, 15, 10, 15, 13], deferred: false },
    { key: "won", label: "Won", count: 12, value: { amount: 3_900_000, basisLabel: BASIS_WON }, deltaCountWoW: 5, sparkline: [6, 8, 5, 9, 7, 40, 11, 12], deferred: false },
    { key: "collected", label: "Collected", count: null, value: null, deltaCountWoW: null, sparkline: [], deferred: true },
  ],
  execHero: {
    won: { count: 12, value: { amount: 3_900_000, basisLabel: BASIS_WON } },
    sent: { count: 13, value: { amount: 2_100_000, basisLabel: BASIS_OPEN } },
    estimated: { count: 18, value: { amount: 4_200_000, basisLabel: BASIS_OPEN } },
  },
  reps: [
    rep("rep-1", "Alexis Stone", 5, 1_650_000, 6, [4, 3, 1, 1], [["New", 5], ["Working", 3]], 9, 12),
    rep("rep-2", "Marcus Webb", 3, 980_000, 4, [2, 2, 2, 0], [["New", 2]], 6, 9),
    rep("rep-3", "Priya Nair", 3, 870_000, 2, [2, 1, 1, 1], [["Working", 4]], 5, 7),
    rep("rep-4", "Devon Hart", 1, 400_000, 1, [1, 1, 0, 1], [["New", 1]], 3, 3),
  ],
  officeProjection: ladder(9, 7, 4, 3, 23, 31),
  weeklyTrend: [
    { weekStart: "2026-04-05", estimating: 10, sent: 8, won: 6, spikeExcluded: false },
    { weekStart: "2026-04-12", estimating: 12, sent: 9, won: 8, spikeExcluded: false },
    { weekStart: "2026-04-19", estimating: 9, sent: 7, won: 5, spikeExcluded: false },
    { weekStart: "2026-04-26", estimating: 14, sent: 12, won: 9, spikeExcluded: false },
    { weekStart: "2026-05-03", estimating: 11, sent: 15, won: 7, spikeExcluded: false },
    { weekStart: "2026-05-10", estimating: 16, sent: 10, won: 8, spikeExcluded: false },
    { weekStart: "2026-05-17", estimating: 40, sent: 38, won: 11, spikeExcluded: true },
    { weekStart: "2026-05-24", estimating: 18, sent: 13, won: 12, spikeExcluded: false },
  ],
  valueBases: { won_awarded_first: BASIS_WON, open_best_estimate: BASIS_OPEN },
  notes: [
    "Estimated/Sent are stage-entry cohorts (a proxy; Estimated is weak — no dedicated event date).",
    "Won is a close-date cohort — different cohort from the stage-entry ones.",
    "Collected is deferred (no finance source yet).",
    "Won $ uses awarded-first; open $ uses best-estimate — never summed.",
  ],
};

function evidenceFor(url: URL) {
  const metric = url.searchParams.get("metric") || "won";
  const repId = url.searchParams.get("repId") || undefined;
  const band = url.searchParams.get("band") || undefined;
  const hasValue = metric !== "leads";
  const basis = metric === "won" ? BASIS_WON : hasValue ? BASIS_OPEN : null;
  const axis = metric === "won" ? "Won close date" : metric === "projection" ? "Expected close date" : metric === "leads" ? "Lead created" : `Entered the ${metric} stage`;
  const names = ["Cedar Ridge HOA", "Lakeside Tower", "Maple Court Apartments", "Vista Commercial Park", "Birchwood Estates", "Harbor Point Plaza"];
  const count = band ? 3 : repId ? 4 : 6;
  const per = metric === "won" ? 325000 : 175000;
  const records = Array.from({ length: count }, (_, i) => ({
    id: `ev-${metric}-${i}`,
    dealNumber: metric === "leads" ? null : `dfw-${100 + i}`,
    name: names[i % names.length],
    repId: repId ?? `rep-${(i % 4) + 1}`,
    repName: ["Alexis Stone", "Marcus Webb", "Priya Nair", "Devon Hart"][i % 4],
    stageLabel: metric === "leads" ? (i % 2 ? "Working" : "New") : metric === "won" ? "Won" : "Estimate Sent",
    value: hasValue ? per + i * 15000 : null,
    cohortDate: `2026-05-2${(i % 5) + 1}`,
  }));
  const value = hasValue ? records.reduce((s, r) => s + (r.value ?? 0), 0) : null;
  return {
    metric,
    metricLabel: metric === "won" ? "Won" : metric === "sent" ? "Sent" : metric === "estimated" ? "Estimating" : metric === "projection" ? "Projected (open)" : "Active leads",
    dateAxisLabel: axis,
    period: showcase.period,
    scope: repId ? { kind: "rep", repId, repName: "Alexis Stone" } : { kind: "office" },
    band: band ?? null,
    leadStage: url.searchParams.get("leadStage") ?? null,
    total: { count: records.length, value, basisLabel: basis },
    records,
  };
}

async function setup(page: Page) {
  await installCommonApiMocks(page);
  await page.route("**/api/reports/monday-showcase?**", (route) => route.fulfill({ json: { data: showcase } }));
  await page.route("**/api/reports/monday-showcase/evidence**", (route) =>
    route.fulfill({ json: { data: evidenceFor(new URL(route.request().url())) } })
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
}

// Sourced from the registry so the spec tracks the consolidated 5-variant set (HERO "Exec · One Glance",
// A3, B2, B3, B4) and never drifts back to the removed A1/A2/B1 buttons.
const VARIANTS = SHOWCASE_VARIANTS.map((v) => v.label);
const HERO_LABEL = SHOWCASE_VARIANTS.find((v) => v.key === "HERO")!.label;

test("Monday showcase: all variants render + drill opens a reconciling drawer", async ({ page }) => {
  await setup(page);
  await page.goto("/reports/monday-showcase");
  await expect(page.getByRole("heading", { name: "Monday Showcase" })).toBeVisible();
  await expect(page.getByText("Won this week")).toBeVisible();

  for (const label of VARIANTS) {
    await page.getByRole("button", { name: label, exact: true }).click();
    await page.waitForTimeout(150);
    if (SHOT_DIR) {
      const slug = label.split(" ")[0].replace(/[^A-Za-z0-9]/g, "");
      await page.screenshot({ path: `${SHOT_DIR}/variant-${slug}.png`, fullPage: true });
    }
  }

  // Drill: open the exec hero Won tile -> drawer with a reconciliation banner.
  await page.getByRole("button", { name: HERO_LABEL, exact: true }).click();
  await page.getByText("Won this week").click();
  await expect(page.getByText("reconcile to it by construction")).toBeVisible();
  await expect(page.getByText(/records/).first()).toBeVisible();
  await page.waitForTimeout(200);
  if (SHOT_DIR) await page.screenshot({ path: `${SHOT_DIR}/drawer-won-office.png`, fullPage: true });
});
