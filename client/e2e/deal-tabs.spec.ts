import { expect, test } from "@playwright/test";
import { installCommonApiMocks } from "./helpers/mock-api";

const opportunityDeal = {
  id: "deal-opportunity",
  dealNumber: "dfw-3-11826-ab",
  name: "Opportunity Tab Deal",
  stageId: "stage-opportunity",
  assignedRepId: "admin-1",
  assignedRepName: "Admin User",
  sourceLeadId: "lead-1",
  companyId: "company-1",
  propertyId: "property-1",
  primaryContactId: null,
  changeOrders: [],
  approvals: [],
  stageHistory: [],
  workflowRoute: "normal",
  isBidBoardOwned: false,
  bidBoardOwnership: { isOwned: false },
  postConversionEnrichment: { applies: false, isComplete: true, requiredFields: [], missingFields: [] },
  stageEnteredAt: "2026-04-28T12:00:00.000Z",
  createdAt: "2026-04-28T12:00:00.000Z",
  updatedAt: "2026-04-28T12:00:00.000Z",
  proposalStatus: "not_started",
  proposalDraftStartedAt: null,
  proposalSentAt: null,
  proposalAcceptedAt: null,
  proposalRevisionCount: 0,
};

test("overview tab remains selected on opportunity-stage deals", async ({ page }) => {
  await installCommonApiMocks(page);
  await page.route("**/api/deals/deal-opportunity/detail", (route) => route.fulfill({ json: { deal: opportunityDeal } }));
  await page.route("**/api/deals/deal-opportunity/scoping-intake**", (route) => route.fulfill({ json: { intake: null, readiness: { status: "draft" } } }));
  await page.route("**/api/deals/deal-opportunity/team", (route) => route.fulfill({ json: { members: [] } }));

  await page.goto("/deals/deal-opportunity");
  await expect(page.getByRole("button", { name: "Opportunity Scope" })).toHaveClass(/border-brand-red/);

  await page.getByRole("button", { name: "Overview" }).click();
  await expect(page).toHaveURL(/tab=overview/);
  await expect(page.getByText("Stage & Status")).toBeVisible();
  await expect(page.getByRole("button", { name: "Overview" })).toHaveClass(/border-brand-red/);
});
