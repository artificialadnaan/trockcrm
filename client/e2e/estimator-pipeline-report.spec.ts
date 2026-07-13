import { expect, test, type Locator, type Page } from "@playwright/test";
import { installCommonApiMocks } from "./helpers/mock-api";

const SHOT_DIR = process.env.ESTIMATOR_REPORT_SHOT_DIR;

const stageColumns = [
  { stageSlug: "opportunity", stageLabel: "Opportunity", displayOrder: 10 },
  { stageSlug: "estimating", stageLabel: "Estimating", displayOrder: 20 },
  { stageSlug: "service_estimating", stageLabel: "Service Estimating", displayOrder: 25 },
  { stageSlug: "estimate_under_review", stageLabel: "Estimate Under Review", displayOrder: 30 },
  { stageSlug: "estimate_sent_to_client", stageLabel: "Estimate Sent", displayOrder: 40 },
  { stageSlug: "contract", stageLabel: "Contract", displayOrder: 50 },
];

function stages(seed: number) {
  return stageColumns.map((stage, index) => ({
    ...stage,
    count: index === 2 ? 0 : seed + index,
    value: index === 2 ? 0 : (seed + index) * 175_000,
  }));
}

const report = {
  generatedAt: "2026-07-13T15:00:00.000Z",
  scope: {
    kind: "active_office",
    cohort: "current_open_pipeline_plus_won_ytd",
    note: "Current open base projects plus projects won this calendar year in the active office.",
  },
  valueBasisLabel: "Best current estimate",
  valueBasisLabels: {
    open: "Best current estimate",
    won: "Awarded-first won value",
  },
  pipeline: { count: 88, value: 28_690_000 },
  won: { count: 24, value: 12_450_000 },
  wonPeriod: { from: "2026-01-01", to: "2026-07-13", label: "Won YTD" },
  stageColumns,
  estimators: [
    {
      key: "sidney_gibson",
      configuredName: "Sidney Gibson",
      estimatorUserId: "sidney-user",
      estimatorName: "Sidney Gibson",
      resolved: true,
      active: true,
      count: 42,
      value: 15_466_067,
      won: { count: 12, value: 6_225_000 },
      stages: stages(2),
    },
    {
      key: "alex_koch",
      configuredName: "Alex Koch",
      estimatorUserId: "alex-user",
      estimatorName: "Alex Koch",
      resolved: true,
      active: true,
      count: 25,
      value: 10_315_952,
      won: { count: 9, value: 5_100_000 },
      stages: stages(1),
    },
  ],
  otherAssigned: {
    count: 4,
    value: 1_125_000,
    won: { count: 1, value: 475_000 },
    stages: stages(0),
  },
  missingEstimator: {
    count: 17,
    value: 1_783_981,
    actionableCount: 12,
    actionableValue: 1_450_000,
    won: { count: 2, value: 650_000 },
    stages: stages(1),
  },
  warnings: [],
};

const evidenceRecords = [
  {
    dealId: "deal-1",
    dealNumber: "DFW-217626-AB",
    projectNumber: "DFW-217626-AB",
    dealName: "Stadium Row Exterior Renovation and Waterproofing",
    ownerId: "owner-1",
    ownerName: "Timothy Mitchell",
    companyName: "Stadium Row Property Holdings",
    propertyName: "Stadium Row",
    stageSlug: "won",
    stageLabel: "Won",
    displayOrder: 90,
    workflowRoute: "normal",
    daysInStage: 9,
    pipelineValue: 2_850_000,
    expectedCloseDate: "2026-04-30",
    wonClosedDate: "2026-05-02",
    estimatorUserId: "sidney-user",
    estimatorName: "Sidney Gibson",
    estimatorActive: true,
    legacyEstimatorName: null,
    assignmentIssue: "none",
    isBidBoardOwned: false,
  },
  {
    dealId: "deal-2",
    dealNumber: "DFW-312726-AA",
    projectNumber: "DFW-312726-AA",
    dealName: "Instrata Upper Kirby",
    ownerId: "owner-2",
    ownerName: "Derek Barr",
    companyName: "Instrata Residential Partners",
    propertyName: "Upper Kirby",
    stageSlug: "won",
    stageLabel: "Won",
    displayOrder: 90,
    workflowRoute: "normal",
    daysInStage: 18,
    pipelineValue: 1_925_000,
    expectedCloseDate: "2026-02-28",
    wonClosedDate: "2026-03-04",
    estimatorUserId: "sidney-user",
    estimatorName: "Sidney Gibson",
    estimatorActive: true,
    legacyEstimatorName: null,
    assignmentIssue: "none",
    isBidBoardOwned: true,
  },
  {
    dealId: "deal-3",
    dealNumber: "ATL-190226-AB",
    projectNumber: "ATL-190226-AB",
    dealName: "Kinstead Apartments Envelope Restoration",
    ownerId: "owner-3",
    ownerName: "Kaleb Marshall",
    companyName: "Kinstead Apartments Management Group",
    propertyName: "Kinstead Apartments",
    stageSlug: "won",
    stageLabel: "Won",
    displayOrder: 90,
    workflowRoute: "normal",
    daysInStage: 3,
    pipelineValue: 1_450_000,
    expectedCloseDate: "2026-06-15",
    wonClosedDate: "2026-06-18",
    estimatorUserId: "sidney-user",
    estimatorName: "Sidney Gibson",
    estimatorActive: true,
    legacyEstimatorName: null,
    assignmentIssue: "none",
    isBidBoardOwned: false,
  },
];

function evidence(url: URL) {
  const cohort = url.searchParams.get("cohort") === "won" ? "won" : "open";
  return {
    generatedAt: "2026-07-13T15:00:00.000Z",
    filter: {
      cohort,
      bucket: url.searchParams.get("bucket") ?? "target",
      estimatorKey: url.searchParams.get("estimatorKey"),
      estimatorName: "Sidney Gibson",
      stageSlug: url.searchParams.get("stageSlug"),
      stageLabel: null,
      valueBasisLabel: cohort === "won" ? "Awarded-first won value" : "Best current estimate",
      period: cohort === "won" ? report.wonPeriod : null,
    },
    total: cohort === "won" ? { count: 12, value: 6_225_000 } : { count: 42, value: 15_466_067 },
    pagination: { page: 1, pageSize: 25, total: evidenceRecords.length, totalPages: 1 },
    records: evidenceRecords.map((record) => cohort === "won"
      ? record
      : { ...record, stageSlug: "estimating", stageLabel: "Estimating", wonClosedDate: null }),
  };
}

async function installMocks(page: Page) {
  await installCommonApiMocks(page);
  await page.route("**/api/reports/estimator-pipeline/evidence**", (route) => {
    return route.fulfill({ json: { data: evidence(new URL(route.request().url())) } });
  });
  await page.route("**/api/reports/estimator-pipeline", (route) => {
    return route.fulfill({ json: { data: report } });
  });
}

async function expectNoHorizontalOverflow(locator: Locator) {
  const dimensions = await locator.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(dimensions.scrollWidth, JSON.stringify(dimensions)).toBeLessThanOrEqual(dimensions.clientWidth + 1);
}

test("estimator report and evidence drawer stay usable without horizontal scrolling", async ({ page }) => {
  await installMocks(page);

  for (const viewport of [
    { name: "desktop", width: 1440, height: 1050 },
    { name: "tablet", width: 1024, height: 900 },
    { name: "phone", width: 390, height: 844 },
    { name: "compact", width: 320, height: 780 },
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto("/reports/operations/estimator-pipeline?officeId=office-1");

    await expect(page.getByRole("heading", { name: "Estimator Pipeline" })).toBeVisible();
    await expect(page.getByText("Won YTD", { exact: true }).first()).toBeVisible();
    await expectNoHorizontalOverflow(page.locator("html"));

    if (viewport.width >= 1280) {
      await expect(page.getByTestId("estimator-stage-table")).toBeVisible();
      await expectNoHorizontalOverflow(page.getByTestId("estimator-stage-table"));
    } else {
      await expect(page.getByTestId("estimator-stage-cards")).toBeVisible();
      await expectNoHorizontalOverflow(page.getByTestId("estimator-stage-cards"));
    }

    if (SHOT_DIR) {
      await page.screenshot({ path: `${SHOT_DIR}/estimator-${viewport.name}-report.png`, fullPage: true });
    }

    const trigger = page.getByRole("button", { name: /Show Sidney Gibson Won YTD/ }).first();
    await trigger.click();
    const sheet = page.locator('[data-slot="sheet-content"]');
    const scroller = page.getByTestId("estimator-evidence-scroller");
    await expect(sheet).toBeVisible();
    await expect(scroller).toBeVisible();
    await expect(page.getByRole("heading", { name: "Sidney Gibson: Won YTD" })).toBeVisible();
    await expect(page.getByText("Awarded-first won value").first()).toBeVisible();
    await expectNoHorizontalOverflow(sheet);
    await expectNoHorizontalOverflow(scroller);

    if (viewport.width >= 1024) {
      await expect(page.getByTestId("estimator-evidence-table")).toBeVisible();
      await expectNoHorizontalOverflow(page.getByTestId("estimator-evidence-table"));
    } else {
      const evidenceCards = page.getByTestId("estimator-evidence-cards");
      await expect(evidenceCards).toBeVisible();
      await expectNoHorizontalOverflow(evidenceCards);
      await expect(
        evidenceCards.getByRole("heading", { name: evidenceRecords[0].dealName, level: 3 }),
      ).toBeVisible();
    }

    const close = sheet.locator('[data-slot="sheet-close"]');
    const box = await close.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);

    if (SHOT_DIR) {
      await page.screenshot({ path: `${SHOT_DIR}/estimator-${viewport.name}-drawer.png` });
    }

    if (viewport.width === 320) {
      await page.keyboard.press("Escape");
      await expect(trigger).toBeFocused();
    } else {
      await close.click();
    }
    await expect(sheet).toBeHidden();
  }
});
