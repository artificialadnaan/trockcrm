import { expect, request as playwrightRequest, test } from "@playwright/test";

type DevUser = {
  email: string;
  role: string;
};

type SessionCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
};

const apiBaseURL =
  process.env.PLAYWRIGHT_API_BASE_URL?.trim() ||
  process.env.API_BASE_URL?.trim() ||
  "https://api-production-ad218.up.railway.app";

async function wait(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

const roleCookiesCache = new Map<string, SessionCookie[]>();

async function fetchJsonWithRetry<T>(
  request: import("@playwright/test").APIRequestContext,
  url: string,
  init?: Parameters<import("@playwright/test").APIRequestContext["fetch"]>[1]
) {
  let lastResponse: import("@playwright/test").APIResponse | null = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    lastResponse = await request.fetch(url, init);
    if (lastResponse.ok()) {
      return (await lastResponse.json()) as T;
    }
    if (lastResponse.status() !== 429 && lastResponse.status() < 500) {
      break;
    }
    await wait(300 * attempt);
  }

  expect(lastResponse?.ok(), `${init?.method ?? "GET"} ${url} failed with ${lastResponse?.status()}`).toBeTruthy();
  return (await lastResponse!.json()) as T;
}

function createIssueCollectors(page: import("@playwright/test").Page) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const responseErrors: string[] = [];

  page.on("console", (message) => {
    if (message.type() !== "error") return;
    consoleErrors.push(message.text());
  });

  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  page.on("response", (response) => {
    if (response.ok()) return;
    const url = response.url();
    if (url.includes("/api/auth/me")) return;
    responseErrors.push(`${response.status()} ${response.request().method()} ${url}`);
  });

  return {
    assertClean() {
      expect(consoleErrors, `Console errors:\n${consoleErrors.join("\n")}`).toEqual([]);
      expect(pageErrors, `Page errors:\n${pageErrors.join("\n")}`).toEqual([]);
      expect(responseErrors, `Network errors:\n${responseErrors.join("\n")}`).toEqual([]);
    },
  };
}

async function loginWithRole(page: import("@playwright/test").Page, role: string) {
  let cookies = roleCookiesCache.get(role);

  if (!cookies) {
    const apiRequest = await playwrightRequest.newContext();
    const usersData = await fetchJsonWithRetry<{ users: DevUser[] }>(
      apiRequest,
      `${apiBaseURL}/api/auth/dev/users`
    );
    const selectedUser = usersData.users.find((user) => user.role === role);

    expect(selectedUser, `No dev user found for role ${role}`).toBeDefined();

    await fetchJsonWithRetry<{ user: DevUser }>(apiRequest, `${apiBaseURL}/api/auth/dev/login`, {
      method: "POST",
      data: { email: selectedUser!.email },
    });

    const storageState = await apiRequest.storageState();
    cookies = storageState.cookies as SessionCookie[];
    roleCookiesCache.set(role, cookies);
    await apiRequest.dispose();
  }

  await page.context().addCookies(cookies);
}

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
