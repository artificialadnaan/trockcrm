import { expect, test } from "@playwright/test";

import { apiBaseURL, createIssueCollectors, fetchJsonWithRetry, loginWithRole } from "./helpers";

async function fetchFirstDirectorRepId(page: import("@playwright/test").Page) {
  const request = page.context().request;
  const dashboardData = await fetchJsonWithRetry<{
    data: { repCards: Array<{ repId: string }> };
  }>(request, `${apiBaseURL}/api/dashboard/director`);
  const repId = dashboardData.data.repCards[0]?.repId;
  expect(repId, "Director dashboard returned no rep cards to drill into").toBeTruthy();
  return repId!;
}

test.describe("reports / director / admin production audit", () => {
  test("director can load reports without console or network failures", async ({ page }) => {
    const issues = createIssueCollectors(page);

    await loginWithRole(page, "director");
    await page.goto("/reports", { waitUntil: "domcontentloaded" });

    await expect(page.getByRole("heading", { name: "Reports", exact: true })).toBeVisible();
    await expect(page.getByText("Workflow Overview")).toBeVisible();
    await expect(page.getByText("Data Mining")).toBeVisible();
    await expect(page.getByText("Untouched Contacts and Dormant Companies")).toBeVisible();
    await expect(page.getByText("No untouched contacts found.").or(page.getByText("Jordan Client"))).toBeVisible();

    issues.assertClean();
  });

  const directorPages = [
    {
      name: "director dashboard",
      path: "/director",
      heading: { role: "heading" as const, name: "Director Dashboard", exact: true },
    },
    {
      name: "sales process disconnects",
      path: "/admin/sales-process-disconnects",
      heading: { role: "heading" as const, name: "Sales Process Disconnects", exact: true },
    },
    {
      name: "admin intervention workspace",
      path: "/admin/interventions",
      heading: { role: "heading" as const, name: "Admin Intervention Workspace", exact: true },
    },
    {
      name: "intervention analytics",
      path: "/admin/intervention-analytics",
      heading: { role: "heading" as const, name: "Intervention Analytics", exact: true },
    },
    {
      name: "merge queue",
      path: "/admin/merge-queue",
      heading: { role: "heading" as const, name: "Duplicate Merge Queue", exact: true },
    },
    {
      name: "migration dashboard",
      path: "/admin/migration",
      heading: { role: "heading" as const, name: "HubSpot Migration", exact: true },
    },
  ];

  for (const pageCase of directorPages) {
    test(`director can load ${pageCase.name} without console or network failures`, async ({ page }) => {
      const issues = createIssueCollectors(page);

      await loginWithRole(page, "director");
      await page.goto(pageCase.path, { waitUntil: "domcontentloaded" });

      await expect(
        page.getByRole(pageCase.heading.role, {
          name: pageCase.heading.name,
          exact: pageCase.heading.exact,
        })
      ).toBeVisible();

      issues.assertClean();
    });
  }

  test("director can load a rep drilldown without console or network failures", async ({ page }) => {
    const issues = createIssueCollectors(page);

    await loginWithRole(page, "director");
    const repId = await fetchFirstDirectorRepId(page);

    await page.goto(`/director/rep/${repId}`, { waitUntil: "domcontentloaded" });

    await expect(page.getByText("Activity Summary")).toBeVisible();
    await expect(page.getByText("Pipeline by Stage")).toBeVisible();

    issues.assertClean();
  });

  const adminPages = [
    {
      name: "offices",
      path: "/admin/offices",
      heading: { role: "heading" as const, name: "Offices", exact: true },
    },
    {
      name: "users",
      path: "/admin/users",
      heading: { role: "heading" as const, name: "Users", exact: true },
    },
    {
      name: "pipeline configuration",
      path: "/admin/pipeline",
      heading: { role: "heading" as const, name: "Pipeline Configuration", exact: true },
    },
    {
      name: "global commissions",
      path: "/admin/commissions",
      heading: { role: "heading" as const, name: "Global Commissions", exact: true },
    },
    {
      name: "procore sync",
      path: "/admin/procore",
      heading: { role: "heading" as const, name: "Procore Sync Status", exact: true },
    },
    {
      name: "audit log",
      path: "/admin/audit",
      heading: { role: "heading" as const, name: "Audit Log", exact: true },
    },
    {
      name: "admin data scrub",
      path: "/admin/data-scrub",
      heading: { role: "heading" as const, name: "Admin Data Scrub", exact: true },
    },
    {
      name: "cross-office reports",
      path: "/admin/cross-office-reports",
      heading: { role: "heading" as const, name: "Cross-Office Reports", exact: true },
    },
    {
      name: "ai action queue",
      path: "/admin/ai-actions",
      heading: { role: "heading" as const, name: "AI Action Queue", exact: true },
    },
    {
      name: "ai ops",
      path: "/admin/ai-ops",
      heading: { role: "heading" as const, name: "AI Ops", exact: true },
    },
    {
      name: "admin guide",
      path: "/help/admin-guide",
      heading: { role: "heading" as const, name: "Admin Guide", exact: true },
    },
  ];

  for (const pageCase of adminPages) {
    test(`admin can load ${pageCase.name} without console or network failures`, async ({ page }) => {
      const issues = createIssueCollectors(page);

      await loginWithRole(page, "admin");
      await page.goto(pageCase.path, { waitUntil: "domcontentloaded" });

      await expect(
        page.getByRole(pageCase.heading.role, {
          name: pageCase.heading.name,
          exact: pageCase.heading.exact,
        })
      ).toBeVisible();

      issues.assertClean();
    });
  }
});
