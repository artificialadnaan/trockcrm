import { expect, test, type Page } from "@playwright/test";
import { installCommonApiMocks } from "./helpers/mock-api";

// Reports Part 4 -- the three new views (Forecast Confidence, At-Risk, Rep 1:1 Pack). Mocks the endpoints
// so the real pages render with representative data, asserts each renders + drilling works, and captures
// screenshots for design review.

const SHOT_DIR = process.env.SHOWCASE_SHOT_DIR;
const BASIS_WON = "Awarded-first won value";
const BASIS_OPEN = "Best current estimate";
const period = { from: "2026-05-24", to: "2026-05-27", mode: "to_date", label: "2026-05-24 → 2026-05-27" };

function ladder(b: [number, number, number, number], n: number, m: number) {
  return {
    bands: [
      { band: "0_30", count: b[0], value: b[0] * 130000 },
      { band: "31_60", count: b[1], value: b[1] * 120000 },
      { band: "61_90", count: b[2], value: b[2] * 110000 },
      { band: "beyond_90", count: b[3], value: b[3] * 100000 },
    ],
    coverage: { n, m, undatedValue: Math.max(0, m - n) * 100000 },
    coverageCaption: `${n} of ${m} open deals have a maintained (future-dated) expected close date.`,
  };
}

function rep(repId: string, repName: string, closed: number, closedVal: number, sent: number, b: [number, number, number, number], leads: Array<[string, number]>, n: number, m: number) {
  return {
    repId,
    repName,
    closed: { count: closed, value: { amount: closedVal, basisLabel: BASIS_WON } },
    projection: ladder(b, n, m),
    sentThisWeek: { count: sent, value: { amount: sent * 160000, basisLabel: BASIS_OPEN } },
    leadStatus: leads.map(([stageLabel, count]) => ({ stageLabel, count })),
  };
}

const weeklyTrend = [
  { weekStart: "2026-04-05", estimating: 10, sent: 8, won: 6, spikeExcluded: false },
  { weekStart: "2026-04-12", estimating: 12, sent: 9, won: 8, spikeExcluded: false },
  { weekStart: "2026-04-19", estimating: 9, sent: 7, won: 5, spikeExcluded: false },
  { weekStart: "2026-04-26", estimating: 14, sent: 12, won: 9, spikeExcluded: false },
  { weekStart: "2026-05-03", estimating: 11, sent: 15, won: 7, spikeExcluded: false },
  { weekStart: "2026-05-10", estimating: 16, sent: 10, won: 8, spikeExcluded: false },
  { weekStart: "2026-05-17", estimating: 40, sent: 38, won: 11, spikeExcluded: true },
  { weekStart: "2026-05-24", estimating: 18, sent: 13, won: 12, spikeExcluded: false },
];

const repA = rep("rep-1", "Alexis Stone", 5, 1_650_000, 6, [4, 3, 1, 1], [["New", 5], ["Working", 3]], 9, 12);
const repB = rep("rep-2", "Marcus Webb", 3, 980_000, 4, [2, 2, 2, 0], [["New", 2]], 6, 9);

const showcase = {
  period,
  departments: [],
  execHero: {
    won: { count: 12, value: { amount: 3_900_000, basisLabel: BASIS_WON } },
    sent: { count: 13, value: { amount: 2_100_000, basisLabel: BASIS_OPEN } },
    estimated: { count: 18, value: { amount: 4_200_000, basisLabel: BASIS_OPEN } },
  },
  reps: [repA, repB],
  officeProjection: ladder([9, 7, 4, 3], 23, 31),
  weeklyTrend,
  valueBases: { won_awarded_first: BASIS_WON, open_best_estimate: BASIS_OPEN },
  notes: [],
};

const repPack = { period, rep: repA, trend: weeklyTrend, allReps: [{ repId: "rep-1", repName: "Alexis Stone" }, { repId: "rep-2", repName: "Marcus Webb" }] };

const atRiskRecords = [
  { id: "d1", dealNumber: "dfw-101", name: "Cedar Ridge HOA", repId: "rep-1", repName: "Alexis Stone", stageLabel: "Estimate Sent", value: 180000, expectedCloseDate: "2026-05-10", reason: "stale_dated", daysInStage: 41 },
  { id: "d2", dealNumber: "dfw-102", name: "Lakeside Tower", repId: "rep-2", repName: "Marcus Webb", stageLabel: "Opportunity", value: 120000, expectedCloseDate: null, reason: "no_date", daysInStage: 12 },
  { id: "d3", dealNumber: "dfw-103", name: "Maple Court Apartments", repId: "rep-1", repName: "Alexis Stone", stageLabel: "Estimating", value: 90000, expectedCloseDate: "2026-04-20", reason: "stale_dated", daysInStage: 60 },
];
const atRisk = {
  scope: { kind: "office" },
  summary: { count: 3, valueAtRisk: 390000 },
  byReason: { stale_dated: { count: 2, valueAtRisk: 270000 }, no_date: { count: 1, valueAtRisk: 120000 } },
  records: atRiskRecords,
};

function evidenceFor(url: URL) {
  const metric = url.searchParams.get("metric") || "won";
  const hasValue = metric !== "leads";
  return {
    metric,
    metricLabel: metric,
    dateAxisLabel: metric === "won" ? "Won close date" : metric === "projection" ? "Expected close date" : "Entered the stage",
    period,
    scope: { kind: "office" },
    band: url.searchParams.get("band"),
    leadStage: url.searchParams.get("leadStage"),
    total: { count: 3, value: hasValue ? 525000 : null, basisLabel: hasValue ? BASIS_WON : null },
    records: Array.from({ length: 3 }, (_, i) => ({
      id: `ev-${i}`, dealNumber: `dfw-${i}`, name: ["Cedar Ridge HOA", "Lakeside Tower", "Vista Park"][i],
      repId: "rep-1", repName: "Alexis Stone", stageLabel: "Won", value: hasValue ? 175000 : null, cohortDate: "2026-05-25",
    })),
  };
}

async function setup(page: Page) {
  await installCommonApiMocks(page);
  await page.route("**/api/reports/monday-showcase?**", (route) => route.fulfill({ json: { data: showcase } }));
  await page.route("**/api/reports/monday-showcase/evidence**", (route) => route.fulfill({ json: { data: evidenceFor(new URL(route.request().url())) } }));
  await page.route("**/api/reports/rep-pack**", (route) => route.fulfill({ json: { data: repPack } }));
  await page.route("**/api/reports/at-risk**", (route) => route.fulfill({ json: { data: atRisk } }));
  await page.setViewportSize({ width: 1440, height: 1100 });
}

test("A·1 Forecast Confidence Board renders + a band drills", async ({ page }) => {
  await setup(page);
  await page.goto("/reports/forecast-confidence");
  await expect(page.getByRole("heading", { name: "Forecast Confidence Board" })).toBeVisible();
  await expect(page.getByText("23 of 31 open deals")).toBeVisible();
  await expect(page.getByRole("link", { name: /At-Risk watchlist/ })).toBeVisible();
  if (SHOT_DIR) await page.screenshot({ path: `${SHOT_DIR}/p4-forecast.png`, fullPage: true });
  await page.getByText("0–30d").first().click();
  await expect(page.getByText("reconcile to it by construction")).toBeVisible();
  if (SHOT_DIR) await page.screenshot({ path: `${SHOT_DIR}/p4-forecast-drawer.png`, fullPage: true });
});

test("A·3 At-Risk Watchlist renders the blind-spot list", async ({ page }) => {
  await setup(page);
  await page.goto("/reports/at-risk");
  await expect(page.getByRole("heading", { name: /At-Risk/ })).toBeVisible();
  await expect(page.getByText("Cedar Ridge HOA")).toBeVisible();
  await expect(page.getByText("No close date").first()).toBeVisible();
  await expect(page.getByText("Past due").first()).toBeVisible();
  if (SHOT_DIR) await page.screenshot({ path: `${SHOT_DIR}/p4-at-risk.png`, fullPage: true });
});

test("B·1 Rep 1:1 Pack renders + closed drills", async ({ page }) => {
  await setup(page);
  await page.goto("/reports/rep-pack");
  await expect(page.getByRole("heading", { name: "Rep 1:1 Pack" })).toBeVisible();
  await expect(page.getByText("Last 8 weeks")).toBeVisible();
  if (SHOT_DIR) await page.screenshot({ path: `${SHOT_DIR}/p4-rep-pack.png`, fullPage: true });
  await page.getByText("Closed", { exact: false }).first().click();
  await expect(page.getByText("reconcile to it by construction")).toBeVisible();
  if (SHOT_DIR) await page.screenshot({ path: `${SHOT_DIR}/p4-rep-pack-drawer.png`, fullPage: true });
});
