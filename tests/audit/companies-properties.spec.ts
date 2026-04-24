import { expect, test } from "@playwright/test";

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
  notes: string | null;
  contactCount: number;
  dealCount: number;
};

type AuditProperty = {
  id: string;
  companyId: string;
  companyName: string | null;
  name: string;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  leadCount: number;
  dealCount: number;
};

type PropertyDetail = {
  property: AuditProperty;
  leads: Array<{ id: string; name: string }>;
  deals: Array<{ id: string; name: string }>;
};

type AuditBundle = {
  company: AuditCompany;
  property: AuditProperty;
  propertyDetail: PropertyDetail;
};

async function loadAuditBundle() {
  const apiRequest = await createRoleApiContext("rep");

  try {
    const companyResponse = await fetchJsonWithRetry<{
      companies: AuditCompany[];
      total: number;
    }>(apiRequest, `${apiBaseURL}/api/companies?search=AUDIT_TEST_Company&limit=20`);

    expect(companyResponse.companies.length, "No AUDIT_TEST_ companies available for the production audit").toBeGreaterThan(0);

    for (const company of companyResponse.companies) {
      const propertiesResponse = await fetchJsonWithRetry<{ properties: AuditProperty[] }>(
        apiRequest,
        `${apiBaseURL}/api/properties?companyId=${company.id}&limit=50`
      );
      const property = propertiesResponse.properties[0];
      if (!property) continue;

      const propertyDetail = await fetchJsonWithRetry<PropertyDetail>(
        apiRequest,
        `${apiBaseURL}/api/properties/${property.id}`
      );

      return {
        company,
        property,
        propertyDetail,
      } satisfies AuditBundle;
    }
  } finally {
    await apiRequest.dispose();
  }

  throw new Error("No AUDIT_TEST_ company with a linked property is available for the production audit");
}

async function restoreCompanyNotes(companyId: string, notes: string | null) {
  const apiRequest = await createRoleApiContext("rep");
  try {
    await fetchJsonWithRetry<{ company: AuditCompany }>(apiRequest, `${apiBaseURL}/api/companies/${companyId}`, {
      method: "PATCH",
      data: { notes },
    });
  } finally {
    await apiRequest.dispose();
  }
}

test.describe.serial("companies / properties production audit", () => {
  let auditBundle: AuditBundle;

  test.beforeAll(async () => {
    auditBundle = await loadAuditBundle();
  });

  test("rep can load company directory and safe company creation validation", async ({ page }) => {
    const issues = createIssueCollectors(page);

    await loginWithRole(page, "rep");

    await page.goto("/companies", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Companies", exact: true })).toBeVisible();

    const searchInput = page.getByPlaceholder("Search companies...");
    await searchInput.fill(auditBundle.company.name);
    await expect(page.getByText(auditBundle.company.name, { exact: true })).toBeVisible();

    await page.goto("/companies/new", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "New Company", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Create Company", exact: true }).click();
    const companyNameField = page.getByLabel("Company Name *");
    await expect(companyNameField).toBeFocused();
    await expect
      .poll(async () => companyNameField.evaluate((element) => (element as HTMLInputElement).validationMessage))
      .not.toBe("");

    issues.assertClean();
  });

  test("rep can traverse company tabs and property cross-links without failures", async ({ page }) => {
    const issues = createIssueCollectors(page);

    await loginWithRole(page, "rep");

    await page.goto(`/companies/${auditBundle.company.id}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: auditBundle.company.name, exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Portfolio", exact: true }).click();
    await expect(page.getByText("Related Properties", { exact: true })).toBeVisible();
    await expect(page.getByText("Related Deals", { exact: true }).last()).toBeVisible();
    await expect(page.getByText(/Activity Rollup/i)).toBeVisible();

    const propertyLink = page.locator(`a[href="/properties/${auditBundle.property.id}"]`).first();
    await propertyLink.click();
    await expect(page).toHaveURL(new RegExp(`/properties/${auditBundle.property.id}$`));
    await expect(page.getByRole("heading", { name: /./ }).first()).toBeVisible();
    await expect(page.getByText("Related Leads", { exact: true })).toBeVisible();
    await expect(page.getByText("Related Deals", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Open Company", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/companies/${auditBundle.company.id}$`));

    await page.getByRole("button", { name: "Deals", exact: true }).click();
    if (auditBundle.company.dealCount > 0) {
      const dealRow = page.locator('[class*="cursor-pointer"]').filter({ hasText: "#" }).first();
      await expect(dealRow).toBeVisible();
    } else {
      await expect(page.getByText("No deals linked to this company.", { exact: true })).toBeVisible();
    }

    await page.getByRole("button", { name: "Files", exact: true }).click();
    await expect(
      page.getByText("No files found across associated deals.", { exact: true }).or(page.getByText(/·/))
    ).toBeVisible();

    await page.getByRole("button", { name: "Emails", exact: true }).click();
    await expect(page.getByText("Email integration coming soon", { exact: true })).toBeVisible();

    await page.goto("/properties", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Properties", exact: true })).toBeVisible();
    await page.getByPlaceholder("Search properties or companies...").fill(auditBundle.company.name);
    await expect(page.getByText(auditBundle.property.companyName ?? auditBundle.company.name, { exact: true }).first()).toBeVisible();

    await page.getByRole("button", { name: "New Property", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("button", { name: "Create Property", exact: true }).click();
    await expect(page.getByText("Company is required", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();

    issues.assertClean();
  });

  test("rep can edit an audit company note and restore it", async ({ page }) => {
    const issues = createIssueCollectors(page);
    const originalNotes = auditBundle.company.notes;
    const updatedNotes = `AUDIT_TEST_note_${Date.now()}`;

    await loginWithRole(page, "rep");

    try {
      await page.goto(`/companies/${auditBundle.company.id}/edit`, { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Edit Company", exact: true })).toBeVisible();

      const notesField = page.getByPlaceholder("Internal notes about this company...");
      await notesField.fill(updatedNotes);
      await page.getByRole("button", { name: "Save Changes", exact: true }).click();

      await expect(page).toHaveURL(new RegExp(`/companies/${auditBundle.company.id}$`));
      await expect(page.getByText(updatedNotes, { exact: true })).toBeVisible();
      auditBundle.company.notes = updatedNotes;
    } finally {
      await restoreCompanyNotes(auditBundle.company.id, originalNotes);
      auditBundle.company.notes = originalNotes;
    }

    issues.assertClean();
  });
});
