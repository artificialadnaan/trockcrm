import { expect, test } from "@playwright/test";
import { getLeadValidationQuestionSetForProjectType } from "@trock-crm/shared/types";

import {
  apiBaseURL,
  createIssueCollectors,
  createRoleApiContext,
  fetchJsonWithRetry,
  loginWithRole,
} from "./helpers";

type AuditCompany = {
  id: string;
  name: string;
};

type AuditProperty = {
  id: string;
  name: string;
};

type AuditProjectType = {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
};

type AuditBundle = {
  company: AuditCompany;
  property: AuditProperty;
  projectType: AuditProjectType;
};

type DealTeamMember = {
  id: string;
  userId: string;
  displayName: string;
  role: string;
};

async function loadAuditBundle() {
  const apiRequest = await createRoleApiContext("rep");

  try {
    const companyResponse = await fetchJsonWithRetry<{
      companies: AuditCompany[];
      total: number;
    }>(apiRequest, `${apiBaseURL}/api/companies?search=AUDIT_TEST_Company&limit=20`);

    expect(companyResponse.companies.length, "No AUDIT_TEST_ companies available for lead progression audit").toBeGreaterThan(0);

    let property: AuditProperty | null = null;
    let company: AuditCompany | null = null;
    for (const candidate of companyResponse.companies) {
      const propertiesResponse = await fetchJsonWithRetry<{ properties: AuditProperty[] }>(
        apiRequest,
        `${apiBaseURL}/api/properties?companyId=${candidate.id}&limit=20`
      );
      if (propertiesResponse.properties[0]) {
        property = propertiesResponse.properties[0];
        company = candidate;
        break;
      }
    }

    expect(company, "No AUDIT_TEST_ company with a linked property is available").toBeDefined();
    expect(property, "No AUDIT_TEST_ property is available").toBeDefined();

    const projectTypesResponse = await fetchJsonWithRetry<{ projectTypes: AuditProjectType[] }>(
      apiRequest,
      `${apiBaseURL}/api/pipeline/project-types`
    );
    const projectType = projectTypesResponse.projectTypes.find((entry) => entry.isActive);
    expect(projectType, "No active project type is available for lead progression audit").toBeDefined();

    return {
      company: company!,
      property: property!,
      projectType: projectType!,
    } satisfies AuditBundle;
  } finally {
    await apiRequest.dispose();
  }
}

async function deleteLeadById(leadId: string) {
  const apiRequest = await createRoleApiContext("rep");

  try {
    await fetchJsonWithRetry(apiRequest, `${apiBaseURL}/api/leads/${leadId}`, {
      method: "DELETE",
    });
  } finally {
    await apiRequest.dispose();
  }
}

async function deleteDealById(dealId: string) {
  const apiRequest = await createRoleApiContext("admin");

  try {
    await fetchJsonWithRetry(apiRequest, `${apiBaseURL}/api/deals/${dealId}`, {
      method: "DELETE",
    });
  } finally {
    await apiRequest.dispose();
  }
}

async function listDealTeamMembers(dealId: string) {
  const apiRequest = await createRoleApiContext("rep");

  try {
    const data = await fetchJsonWithRetry<{ members: DealTeamMember[] }>(
      apiRequest,
      `${apiBaseURL}/api/deals/${dealId}/team`
    );
    return data.members;
  } finally {
    await apiRequest.dispose();
  }
}

async function removeDealTeamMember(dealId: string, memberId: string) {
  const apiRequest = await createRoleApiContext("rep");

  try {
    await fetchJsonWithRetry(apiRequest, `${apiBaseURL}/api/deals/${dealId}/team/${memberId}`, {
      method: "DELETE",
    });
  } finally {
    await apiRequest.dispose();
  }
}

async function fillLeadQuestionnaire(page: import("@playwright/test").Page, projectTypeSlug: string) {
  await page.getByLabel("Source").fill("AUDIT_TEST referral");
  await page.getByLabel("Existing Customer Status").fill("Repeat customer");
  await page.getByLabel("Estimated Value").fill("125000");
  await page.getByLabel("Timeline Status").fill("Q3 2026");

  const questionSet = getLeadValidationQuestionSetForProjectType(projectTypeSlug);
  for (const question of questionSet.questions) {
    if (question.input === "boolean") {
      await page.getByLabel(question.label).click();
      await page.getByRole("option", { name: "Yes", exact: true }).click();
      continue;
    }

    const value =
      question.input === "number"
        ? "1"
        : question.input === "textarea"
          ? `AUDIT_TEST ${question.label}`
          : `AUDIT_TEST ${question.label}`;

    await page.getByLabel(question.label).fill(value);
  }
}

test.describe.serial("lead to opportunity progression production audit", () => {
  let auditBundle: AuditBundle;

  test.beforeAll(async () => {
    auditBundle = await loadAuditBundle();
  });

  test("rep can create a lead from a stale stage link, progress it to opportunity, assign the deal team, and reach the estimating blocker cleanly", async ({
    page,
  }) => {
    const issues = createIssueCollectors(page);
    const leadName = `AUDIT_TEST_LeadProgress_${Date.now()}`;
    let leadId: string | null = null;
    let dealId: string | null = null;
    let createdTeamMemberId: string | null = null;

    await loginWithRole(page, "rep");

    try {
      const query = new URLSearchParams({
        companyId: auditBundle.company.id,
        propertyId: auditBundle.property.id,
        projectTypeId: auditBundle.projectType.id,
        stageId: "legacy-contacted",
        name: leadName,
      });

      await page.goto(`/leads/new?${query.toString()}`, { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "New Lead", exact: true })).toBeVisible();
      await expect(page.getByLabel("Initial Stage")).toContainText("New Lead");

      await fillLeadQuestionnaire(page, auditBundle.projectType.slug);
      await page.getByRole("button", { name: "Create Lead", exact: true }).click();

      await page.waitForURL(/\/leads\/[^/?#]+$/);
      leadId = page.url().match(/\/leads\/([^/?#]+)/)?.[1] ?? null;
      expect(leadId, "Lead id should be present after create").toBeTruthy();
      await expect(page.getByRole("heading", { name: leadName, exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Move to Qualified Lead", exact: true })).toBeVisible();

      await page.getByRole("button", { name: "Move to Qualified Lead", exact: true }).click();
      await page.getByRole("button", { name: "Move Lead", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "Move to Sales Validation Stage", exact: true })
      ).toBeVisible();

      await page.getByRole("button", { name: "Move to Sales Validation Stage", exact: true }).click();
      await page.getByRole("button", { name: "Move Lead", exact: true }).click();
      await expect(page.getByRole("button", { name: "Convert to Opportunity", exact: true })).toBeVisible();

      await page.getByRole("button", { name: "Convert to Opportunity", exact: true }).click();
      await page.getByRole("button", { name: "Convert to Opportunity", exact: true }).last().click();
      await page.waitForURL(/\/deals\/[^/?#]+\?tab=scoping$/);
      dealId = page.url().match(/\/deals\/([^/?#]+)/)?.[1] ?? null;
      expect(dealId, "Deal id should be present after lead conversion").toBeTruthy();

      await page.getByRole("button", { name: /^Team/ }).click();
      const addTeamMemberButton = page.getByRole("button", { name: "Add Team Member", exact: true }).first();
      await expect(addTeamMemberButton).toBeVisible();
      await addTeamMemberButton.click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.getByLabel("User").click();
      const firstUserOption = page.getByRole("option").first();
      const assignedUserName = (await firstUserOption.textContent())?.trim() ?? "";
      await firstUserOption.click();
      await page.getByLabel("Role").click();
      await page.getByRole("option", { name: "Estimator", exact: true }).click();
      await page.getByLabel("Notes (optional)").fill("AUDIT_TEST team assignment");
      await page.getByRole("button", { name: "Add Member", exact: true }).click();
      await expect(page.getByText("Estimator", { exact: true })).toBeVisible();
      if (assignedUserName) {
        await expect(page.getByText(assignedUserName, { exact: true })).toBeVisible();
      }

      const members = await listDealTeamMembers(dealId!);
      const createdMember = members.find(
        (member) => member.role === "estimator" && member.displayName === assignedUserName
      );
      expect(createdMember, "Assigned estimator should be persisted").toBeDefined();
      createdTeamMemberId = createdMember?.id ?? null;

      await page.goto(`/deals/${dealId}`, { waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: "Move Stage", exact: true }).click();
      await page.getByRole("menuitem", { name: /Estimate in Progress/ }).click();
      await expect(page.getByText(/Open Scoping Workspace/, { exact: false })).toBeVisible();
      await page.getByRole("link", { name: "Open Scoping Workspace", exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/deals/${dealId}\\?tab=scoping$`));

      await page.getByRole("button", { name: "Estimates", exact: true }).click();
      await expect(page.getByText(/Estimate/i).first()).toBeVisible();
    } finally {
      if (createdTeamMemberId && dealId) {
        await removeDealTeamMember(dealId, createdTeamMemberId);
      }
      if (dealId) {
        await deleteDealById(dealId);
      }
      if (leadId) {
        await deleteLeadById(leadId);
      }
    }

    issues.assertClean();
  });
});
