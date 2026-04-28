import { expect, test } from "@playwright/test";
import { installCommonApiMocks } from "./helpers/mock-api";

function deal(id: string, sourceLeadId: string | null) {
  return {
    id,
    dealNumber: sourceLeadId ? "dfw-9-11826-aa" : "TR-0648",
    name: sourceLeadId ? "New CRM Conversion" : "Legacy Imported Deal",
    stageId: "stage-estimating",
    assignedRepId: "admin-1",
    sourceLeadId,
    companyId: sourceLeadId ? "company-1" : null,
    propertyId: sourceLeadId ? "property-1" : null,
    workflowRoute: "normal",
    isBidBoardOwned: false,
    stageEnteredAt: "2026-04-28T12:00:00.000Z",
    createdAt: "2026-04-28T12:00:00.000Z",
    updatedAt: "2026-04-28T12:00:00.000Z",
    changeOrders: [],
    approvals: [],
    stageHistory: [],
    postConversionEnrichment: { applies: Boolean(sourceLeadId), isComplete: false, requiredFields: [], missingFields: [] },
    bidBoardOwnership: { isOwned: false },
  };
}

test("legacy imported and new CRM-originated deal endpoints both return 200", async ({ page }) => {
  await installCommonApiMocks(page);

  const legacy = deal("legacy-deal", null);
  const crm = deal("crm-deal", "lead-1");
  await page.route("**/api/deals/legacy-deal", (route) => route.fulfill({ json: { deal: legacy } }));
  await page.route("**/api/deals/legacy-deal/detail", (route) => route.fulfill({ json: { deal: legacy } }));
  await page.route("**/api/deals/crm-deal", (route) => route.fulfill({ json: { deal: crm } }));
  await page.route("**/api/deals/crm-deal/detail", (route) => route.fulfill({ json: { deal: crm } }));

  await page.goto("/deals/crm-deal?tab=overview");
  await expect(page.getByText("New CRM Conversion")).toBeVisible();

  const responses = await page.evaluate(async () => {
    const urls = ["/api/deals/legacy-deal", "/api/deals/legacy-deal/detail", "/api/deals/crm-deal", "/api/deals/crm-deal/detail"];
    return Promise.all(urls.map(async (url) => ({ url, status: (await fetch(url)).status })));
  });

  expect(responses).toEqual([
    { url: "/api/deals/legacy-deal", status: 200 },
    { url: "/api/deals/legacy-deal/detail", status: 200 },
    { url: "/api/deals/crm-deal", status: 200 },
    { url: "/api/deals/crm-deal/detail", status: 200 },
  ]);
});
