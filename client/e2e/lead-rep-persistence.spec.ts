import { expect, test } from "@playwright/test";
import { installCommonApiMocks } from "./helpers/mock-api";

const baseLead = {
  id: "lead-1",
  companyId: "company-1",
  companyName: "Acme Property Group",
  propertyId: "property-1",
  property: { id: "property-1", name: "Acme", address: "1 Main", city: "Dallas", state: "TX", zip: "75201" },
  primaryContactId: "contact-1",
  name: "Lead Rep Persistence",
  stageId: "stage-lead",
  assignedRepId: "admin-1",
  salesRepId: "admin-1",
  assignedRepName: null,
  status: "open",
  source: "Referral",
  sourceCategory: "Referral",
  sourceDetail: null,
  description: "Smoke lead",
  projectTypeId: null,
  projectType: null,
  qualificationPayload: {},
  projectTypeQuestionPayload: {},
  verificationStatus: "not_required",
  verificationRequiredReason: null,
  stageEnteredAt: "2026-04-28T12:00:00.000Z",
  convertedAt: null,
  isActive: true,
  createdAt: "2026-04-28T12:00:00.000Z",
  updatedAt: "2026-04-28T12:00:00.000Z",
  convertedDealId: null,
  convertedDealNumber: null,
  leadQuestionAnswers: {},
};

test("create lead, assign rep, save, reload, and display rep name", async ({ page }) => {
  let savedLead = { ...baseLead };
  await installCommonApiMocks(page);
  await page.route("**/api/leads/lead-1", async (route) => {
    if (route.request().method() === "PATCH") {
      expect(await route.request().postDataJSON()).toEqual({
        assignedRepId: "rep-hidden",
        salesRepId: "rep-hidden",
      });
      savedLead = { ...savedLead, assignedRepId: "rep-hidden", salesRepId: "rep-hidden" };
      return route.fulfill({ json: { lead: savedLead } });
    }
    return route.fulfill({ json: { lead: savedLead } });
  });
  await page.route("**/api/leads/lead-1/timeline**", (route) => route.fulfill({ json: { activities: [] } }));

  await page.goto("/leads/lead-1");
  await page.getByRole("combobox").click();
  await page.getByRole("option", { name: "Hidden Sales Rep" }).click();
  await page.getByRole("button", { name: "Save Assignment" }).click();

  await expect(page.getByText("Hidden Sales Rep")).toBeVisible();
  await expect(page.getByText("Unassigned")).toHaveCount(0);

  await page.reload();
  await expect(page.getByText("Hidden Sales Rep")).toBeVisible();
  await expect(page.getByText("Unassigned")).toHaveCount(0);
});
