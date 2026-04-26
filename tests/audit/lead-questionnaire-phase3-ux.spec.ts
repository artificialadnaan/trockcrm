import { mkdir } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "@playwright/test";

import {
  apiBaseURL,
  createIssueCollectors,
  createRoleApiContext,
  fetchJsonWithRetry,
  fetchResponseWithRetry,
  loginWithRole,
} from "./helpers";

test.use({ headless: false, viewport: { width: 1440, height: 1000 } });

type Company = {
  id: string;
  name: string;
  companyVerificationStatus?: string | null;
  companyVerificationEmailSentAt?: string | null;
};

type Property = {
  id: string;
  name: string;
};

type Stage = {
  id: string;
  name: string;
  slug: string;
};

type ProjectType = {
  id: string;
  name: string;
  slug: string;
};

type Lead = {
  id: string;
  name: string;
  stageId: string;
  updatedAt: string;
  existingCustomerStatus?: string | null;
  leadQuestionnaire?: {
    answers: Record<string, unknown>;
  } | null;
};

type Activity = {
  subject: string | null;
  body: string | null;
};

type Bundle = {
  company: Company;
  property: Property;
  lead: Lead;
  newLeadStage: Stage;
  qualifiedLeadStage: Stage;
  salesValidationStage: Stage;
  projectTypes: {
    restoration: ProjectType;
    traditionalMultifamily: ProjectType;
    commercial: ProjectType;
  };
};

const manualDir = path.join(process.cwd(), "test-results", "manual-verification");

async function screenshot(page: import("@playwright/test").Page, name: string) {
  await mkdir(manualDir, { recursive: true });
  await page.screenshot({
    path: path.join(manualDir, `${process.env.MANUAL_PASS ?? "pass"}-${name}.png`),
    fullPage: true,
  });
}

async function selectByTriggerId(page: import("@playwright/test").Page, id: string, optionName: string) {
  await page.locator(`#${id}`).click();
  await page.getByRole("option", { name: optionName, exact: true }).click();
}

async function selectProjectType(page: import("@playwright/test").Page, optionName: string) {
  await page.locator("#lead-project-type").or(page.locator("#projectTypeId")).click();
  await page.getByRole("option", { name: optionName, exact: true }).click();
}

async function createBundle(): Promise<Bundle> {
  const apiRequest = await createRoleApiContext("rep");
  try {
    const suffix = Date.now();
    const companyData = await fetchJsonWithRetry<{ company: Company }>(
      apiRequest,
      `${apiBaseURL}/api/companies`,
      {
        method: "POST",
        data: {
          name: `AUDIT_TEST_Phase3_Company_${suffix}`,
          category: "other",
          notes: "AUDIT_TEST manual lead questionnaire verification",
        },
      }
    );
    const propertyData = await fetchJsonWithRetry<{ property: Property }>(
      apiRequest,
      `${apiBaseURL}/api/properties`,
      {
        method: "POST",
        data: {
          companyId: companyData.company.id,
          name: `AUDIT_TEST_Phase3_Property_${suffix}`,
          city: "Dallas",
          state: "TX",
        },
      }
    );
    const [projectTypesData, stagesData] = await Promise.all([
      fetchJsonWithRetry<{ projectTypes: ProjectType[] }>(
        apiRequest,
        `${apiBaseURL}/api/pipeline/project-types`
      ),
      fetchJsonWithRetry<{ stages: Stage[] }>(
        apiRequest,
        `${apiBaseURL}/api/pipeline/stages?workflowFamily=lead`
      ),
    ]);

    const restoration = projectTypesData.projectTypes.find((item) => item.slug === "restoration");
    const traditionalMultifamily = projectTypesData.projectTypes.find(
      (item) => item.slug === "traditional_multifamily"
    );
    const commercial = projectTypesData.projectTypes.find((item) => item.slug === "commercial");
    const newLeadStage = stagesData.stages.find((item) => item.slug === "new_lead");
    const qualifiedLeadStage = stagesData.stages.find((item) => item.slug === "qualified_lead");
    const salesValidationStage = stagesData.stages.find((item) => item.slug === "sales_validation_stage");

    expect(restoration).toBeDefined();
    expect(traditionalMultifamily).toBeDefined();
    expect(commercial).toBeDefined();
    expect(newLeadStage).toBeDefined();
    expect(qualifiedLeadStage).toBeDefined();
    expect(salesValidationStage).toBeDefined();

    const leadResponse = await fetchResponseWithRetry(apiRequest, `${apiBaseURL}/api/leads`, {
      method: "POST",
      data: {
        companyId: companyData.company.id,
        propertyId: propertyData.property.id,
        stageId: newLeadStage!.id,
        name: `AUDIT_TEST_Phase3_Lead_${suffix}`,
        sourceCategory: "Other",
        sourceDetail: "Manual verification source",
        projectTypeId: restoration!.id,
        qualificationPayload: {
          estimated_value: 125000,
          timeline_status: "Q3 2026",
        },
        leadQuestionAnswers: {
          insurance_claim: true,
          xactimate: "AUDIT_TEST Xactimate scope",
          emergency_response: false,
        },
      },
    });
    expect(
      leadResponse.ok(),
      `Manual verification lead create failed: ${await leadResponse.text()}`
    ).toBe(true);
    const leadData = (await leadResponse.json()) as { lead: Lead };

    return {
      company: companyData.company,
      property: propertyData.property,
      lead: leadData.lead,
      newLeadStage: newLeadStage!,
      qualifiedLeadStage: qualifiedLeadStage!,
      salesValidationStage: salesValidationStage!,
      projectTypes: {
        restoration: restoration!,
        traditionalMultifamily: traditionalMultifamily!,
        commercial: commercial!,
      },
    };
  } finally {
    await apiRequest.dispose();
  }
}

test.describe.serial("lead questionnaire phase 3 manual verification", () => {
  let bundle: Bundle;

  test.beforeAll(async () => {
    bundle = await createBundle();
  });

  test.afterAll(async () => {
    if (!bundle?.lead?.id) {
      return;
    }
    const apiRequest = await createRoleApiContext("rep");
    try {
      await fetchResponseWithRetry(apiRequest, `${apiBaseURL}/api/leads/${bundle.lead.id}`, {
        method: "DELETE",
      });
    } finally {
      await apiRequest.dispose();
    }
  });

  test("rep-facing questionnaire UX, source controls, and verification email logging work on production", async ({
    page,
  }) => {
    const issues = createIssueCollectors(page);
    const apiRequest = await createRoleApiContext("rep");

    try {
      await loginWithRole(page, "rep");

      await page.goto("/leads/new", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "New Lead", exact: true })).toBeVisible();
      await selectByTriggerId(page, "sourceCategory", "Other");
      const sourceDetailField = page.locator("#sourceDetail");
      await expect(sourceDetailField).toBeVisible();
      await expect(sourceDetailField).toHaveAttribute("required", "");
      await expect
        .poll(async () => sourceDetailField.evaluate((element) => (element as HTMLInputElement).validity.valueMissing))
        .toBe(true);
      await selectProjectType(page, "Traditional Multifamily");
      await expect(page.getByText("Project Questions", { exact: true })).toBeVisible();
      for (const key of [
        "bid_due_date",
        "budget",
        "number_of_bidders",
        "client_bid_portal_requirements",
        "poc",
        "timeline",
        "client_provided_docs",
        "project_permitted",
        "market_type",
        "life_safety",
      ]) {
        await expect(page.locator(`#${key}`), `${key} baseline question should render`).toBeVisible();
      }
      await expect(page.locator("#corridors")).toBeVisible();
      await screenshot(page, "01-new-lead-create-flow-source-and-questionnaire");

      await page.goto(`/leads/${bundle.lead.id}`, { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: bundle.lead.name, exact: true })).toBeVisible();
      await expect(page.getByText("Project Questions", { exact: true }).first()).toBeVisible();
      await expect(page.getByText("Lead Summary", { exact: true })).toBeVisible();
      const projectQuestionsBox = await page.getByText("Project Questions", { exact: true }).first().boundingBox();
      const leadSummaryBox = await page.getByText("Lead Summary", { exact: true }).boundingBox();
      expect(projectQuestionsBox?.x ?? 9999).toBeLessThan(leadSummaryBox?.x ?? 0);
      await expect(page.getByText("Insurance Claim", { exact: true })).toBeVisible();
      await expect(page.getByText("Yes", { exact: true }).first()).toBeVisible();
      await screenshot(page, "02-existing-lead-main-column-layout-and-boolean-display");

      const leadDetail = await fetchJsonWithRetry<{ lead: Lead }>(
        apiRequest,
        `${apiBaseURL}/api/leads/${bundle.lead.id}`
      );
      expect(leadDetail.lead.existingCustomerStatus).toBe("New");
      expect(leadDetail.lead.leadQuestionnaire?.answers.insurance_claim).toBe(true);

      await expect(page.getByRole("button", { name: "Edit Lead", exact: true })).toHaveCount(1);
      await page.getByRole("button", { name: "Edit Lead", exact: true }).click();
      await expect(page.getByText("Edit Lead", { exact: true })).toBeVisible();
      const editSourceDetail = page.locator("#lead-source-detail").or(page.locator("#sourceDetail"));
      await expect(editSourceDetail).toHaveValue("Manual verification source");
      await expect(editSourceDetail).toHaveAttribute("required", "");
      await expect(page.getByText("Existing Customer Status", { exact: true })).toBeVisible();
      await expect(page.getByText("New", { exact: true }).first()).toBeVisible();
      await screenshot(page, "03-edit-mode-saved-values-and-readonly-customer-status");

      await selectProjectType(page, "Traditional Multifamily");
      await expect(page.locator("#corridors")).toBeVisible();
      await expect(page.locator("#insurance_claim")).toHaveCount(0);
      await screenshot(page, "04-project-type-switch-traditional-question-set");

      await selectByTriggerId(page, "corridors", "Yes");
      await expect(page.locator("#corridor_closed_open_air")).toBeVisible();
      await selectByTriggerId(page, "corridor_closed_open_air", "Closed");
      await screenshot(page, "05-corridors-cascade-closed-open-air-options");

      await selectProjectType(page, "Restoration");
      await expect(page.locator("#insurance_claim")).toBeVisible();
      await selectByTriggerId(page, "insurance_claim", "No");
      await expect(page.locator("#xactimate")).toHaveCount(0);
      await selectByTriggerId(page, "insurance_claim", "Yes");
      await expect(page.locator("#xactimate")).toBeVisible();
      await expect(page.locator('label[for="xactimate"]')).toContainText("*");
      await screenshot(page, "06-insurance-claim-xactimate-required-reveal");

      const companyDetail = await fetchJsonWithRetry<{ company: Company }>(
        apiRequest,
        `${apiBaseURL}/api/companies/${bundle.company.id}`
      );
      expect(companyDetail.company.companyVerificationStatus).toBe("pending");
      expect(companyDetail.company.companyVerificationEmailSentAt).toBeTruthy();
      const activities = await fetchJsonWithRetry<{ activities: Activity[] }>(
        apiRequest,
        `${apiBaseURL}/api/activities?companyId=${bundle.company.id}&limit=20`
      );
      const verificationActivity = activities.activities.find((activity) =>
        activity.body?.includes("Company verification email sent to adnaan.iqbal@gmail.com")
      );
      expect(verificationActivity?.subject).toContain("Company verification needed");
      await page.goto(`/companies/${bundle.company.id}`, { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: bundle.company.name, exact: true })).toBeVisible();
      await screenshot(page, "07-company-verification-email-logged");

      await page.goto(`/leads/${bundle.lead.id}`, { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("button", { name: "Edit Lead", exact: true })).toBeVisible();
      await fetchResponseWithRetry(apiRequest, `${apiBaseURL}/api/leads/${bundle.lead.id}`, {
        method: "DELETE",
      });
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.getByText("Hidden lead records are read-only.", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Edit Lead", exact: true })).toHaveCount(0);
      await screenshot(page, "08-hidden-lead-read-only");

      issues.assertClean();
    } finally {
      await apiRequest.dispose();
    }
  });
});
