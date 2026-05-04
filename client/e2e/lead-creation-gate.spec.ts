import { expect, test } from "@playwright/test";
import { adminUser, installCommonApiMocks } from "./helpers/mock-api";

const company = {
  id: "company-1",
  name: "Acme Property Group",
  category: "client",
  address: null,
  city: null,
  state: null,
  zip: null,
  phone: null,
  website: null,
  notes: null,
  companyVerificationStatus: "not_required",
  companyVerificationRequestedAt: null,
  companyVerificationEmailSentAt: null,
  companyVerifiedAt: null,
  companyVerifiedBy: null,
  contactCount: 1,
  dealCount: 0,
  createdAt: "2026-05-04T12:00:00.000Z",
  updatedAt: "2026-05-04T12:00:00.000Z",
};

const property = {
  id: "property-1",
  companyId: "company-1",
  companyName: "Acme Property Group",
  name: "Palm Villas",
  address: "123 Main St",
  city: "Dallas",
  state: "TX",
  zip: "75001",
  buildYear: 2001,
  unitCount: 120,
  notes: null,
  isActive: true,
  createdAt: "2026-05-04T12:00:00.000Z",
  updatedAt: "2026-05-04T12:00:00.000Z",
  leadCount: 0,
  dealCount: 0,
  convertedDealCount: 0,
  lastActivityAt: null,
};

const contact = {
  id: "contact-1",
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@example.test",
  phone: null,
  jobTitle: null,
  category: "client",
};

async function installLeadCreationGateMocks(page: import("@playwright/test").Page) {
  await installCommonApiMocks(page);
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({ json: { user: { ...adminUser, id: "rep-1", role: "rep", displayName: "Rep One" } } })
  );
  await page.route("**/api/companies/company-1", (route) => route.fulfill({ json: { company } }));
  await page.route("**/api/properties/property-1", (route) => route.fulfill({ json: { property } }));
  await page.route("**/api/properties?**", (route) => route.fulfill({ json: { properties: [property] } }));
  await page.route("**/api/companies/company-1/contacts", (route) =>
    route.fulfill({ json: { contacts: [contact] } })
  );
  await page.route("**/api/leads/questionnaire-template?**", (route) =>
    route.fulfill({
      json: {
        enabled: true,
        questionnaire: {
          projectTypeId: "type-5",
          nodes: [
            {
              id: "node-bid-due-date",
              projectTypeId: null,
              parentNodeId: null,
              parentOptionValue: null,
              nodeType: "question",
              key: "bid_due_date",
              label: "Bid Due Date",
              prompt: null,
              inputType: "date",
              options: [],
              isRequired: true,
              displayOrder: 10,
              isActive: true,
            },
            {
              id: "node-number-of-bidders",
              projectTypeId: null,
              parentNodeId: null,
              parentOptionValue: null,
              nodeType: "question",
              key: "number_of_bidders",
              label: "Number of Bidders",
              prompt: null,
              inputType: "number",
              options: [],
              isRequired: false,
              displayOrder: 20,
              isActive: true,
            },
          ],
          allNodes: [],
          answers: {},
        },
      },
    })
  );
}

test("lead creation gate blocks missing prerequisites and submits a complete create payload", async ({ page }) => {
  await installLeadCreationGateMocks(page);
  let createPayload: Record<string, unknown> | null = null;
  await page.route("**/api/leads", async (route) => {
    if (route.request().method() !== "POST") {
      return route.fulfill({ json: { leads: [] } });
    }
    createPayload = await route.request().postDataJSON();
    return route.fulfill({ status: 201, json: { lead: { id: "lead-created" } } });
  });
  await page.route("**/api/leads/lead-created", (route) =>
    route.fulfill({ json: { lead: { id: "lead-created", name: "Gate Lead" } } })
  );

  await page.goto("/leads/new?companyId=company-1&propertyId=property-1&primaryContactId=contact-1&projectTypeId=type-5&source=Referral&name=Gate%20Lead");

  await expect(page.getByRole("button", { name: "Create Lead" })).toBeDisabled();
  await expect(page.getByText("POC role is required.")).toBeVisible();
  await expect(page.getByText("Budget status is required.")).toBeVisible();
  await expect(page.getByText("Bid Due Date is required.")).toBeVisible();

  await page.getByRole("combobox", { name: "Point of Contact" }).click();
  await page.getByText("Ada Lovelace").click();
  await page.locator("#primaryContactRole").click();
  await page.getByText("Property Manager").click();
  await page.locator("#budgetStatus").click();
  await page.getByText("Budgeted Q1").click();
  await page.locator("#bid_due_date").fill("2026-06-01");

  await expect(page.getByRole("button", { name: "Create Lead" })).toBeEnabled();
  await page.getByRole("button", { name: "Create Lead" }).click();

  await expect
    .poll(() => createPayload)
    .toMatchObject({
      companyId: "company-1",
      propertyId: "property-1",
      primaryContactId: "contact-1",
      primaryContactRole: "property_manager",
      budgetStatus: "budgeted_q1",
      projectTypeId: "type-5",
      leadQuestionAnswers: {
        bid_due_date: "2026-06-01",
      },
    });
});
