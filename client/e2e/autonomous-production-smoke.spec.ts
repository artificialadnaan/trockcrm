import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const password = process.env.PLAYWRIGHT_TEST_PASSWORD;
const reportPath =
  process.env.AUTONOMOUS_SMOKE_REPORT ??
  path.resolve(process.cwd(), "docs/autonomous-smoke-results-2026-05-08.json");

type ApiEvent = {
  method: string;
  url: string;
  status: number;
};

type RouteResult = {
  route: string;
  title: string;
  bodyText: string;
  api: ApiEvent[];
  consoleErrors: string[];
  pageErrors: string[];
  status: "ok" | "broken";
};

const report: {
  startedAt: string;
  results: RouteResult[];
  apiChecks: Array<{ label: string; status: number; ok: boolean; sample?: unknown }>;
} = {
  startedAt: new Date().toISOString(),
  results: [],
  apiChecks: [],
};

test.afterAll(() => {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify({ ...report, finishedAt: new Date().toISOString() }, null, 2));
});

async function login(page: Page, email: string) {
  if (!password) throw new Error("PLAYWRIGHT_TEST_PASSWORD is required");
  const response = await page.request.post("/api/auth/local/login", {
    data: { email, password },
  });
  expect(response.status(), `${email} login status`).toBe(200);
  return (await response.json()) as {
    user: {
      id: string;
      email: string;
      role: string;
      requiresOnboarding: boolean;
      cleanupUrl?: string | null;
    };
  };
}

async function getJson(request: APIRequestContext, label: string, url: string) {
  const response = await request.get(url);
  let sample: unknown;
  try {
    sample = await response.json();
  } catch {
    sample = await response.text();
  }
  report.apiChecks.push({ label, status: response.status(), ok: response.ok(), sample });
  return { response, sample };
}

function firstId(sample: unknown, key: string): string | null {
  if (!sample || typeof sample !== "object") return null;
  const rows = (sample as Record<string, unknown>)[key];
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const first = rows[0];
  if (!first || typeof first !== "object") return null;
  const id = (first as Record<string, unknown>).id;
  return typeof id === "string" ? id : null;
}

async function smokeRoute(page: Page, route: string) {
  const api: ApiEvent[] = [];
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  const responseHandler = (response: { url: () => string; request: () => { method: () => string }; status: () => number }) => {
    const url = response.url();
    if (url.includes("/api/")) {
      api.push({ method: response.request().method(), url, status: response.status() });
    }
  };
  const consoleHandler = (message: { type: () => string; text: () => string }) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  };
  const pageErrorHandler = (error: Error) => pageErrors.push(error.message);

  page.on("response", responseHandler);
  page.on("console", consoleHandler);
  page.on("pageerror", pageErrorHandler);

  let status: RouteResult["status"] = "ok";
  try {
    await page.goto(route, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
  } catch (error) {
    status = "broken";
    pageErrors.push(error instanceof Error ? error.message : String(error));
  }

  const title = await page.title().catch(() => "");
  const bodyText = await page.locator("body").innerText({ timeout: 5000 }).catch((error) => {
    status = "broken";
    pageErrors.push(error instanceof Error ? error.message : String(error));
    return "";
  });
  if (api.some((event) => event.status >= 500) || pageErrors.length > 0) status = "broken";

  report.results.push({
    route,
    title,
    bodyText: bodyText.slice(0, 1500),
    api,
    consoleErrors,
    pageErrors,
    status,
  });

  page.off("response", responseHandler);
  page.off("console", consoleHandler);
  page.off("pageerror", pageErrorHandler);
}

test.describe.serial("autonomous production smoke", () => {
  test("admin surfaces and detail routes render", async ({ page }) => {
    await login(page, "test-admin@trock.test");

    const deals = await getJson(page.request, "deals list", "/api/deals?limit=1");
    const leads = await getJson(page.request, "leads list", "/api/leads?limit=1");
    const companies = await getJson(page.request, "companies list", "/api/companies?limit=1");
    const contacts = await getJson(page.request, "contacts list", "/api/contacts?limit=1");
    const properties = await getJson(page.request, "properties list", "/api/properties?limit=1");
    await getJson(page.request, "tasks overdue", "/api/tasks?section=overdue&limit=20");
    await getJson(page.request, "tasks today", "/api/tasks?section=today&limit=20");

    const routes = [
      "/dashboard",
      "/deals",
      "/deals/board",
      firstId(deals.sample, "deals") ? `/deals/${firstId(deals.sample, "deals")}` : null,
      "/leads",
      "/leads/board",
      firstId(leads.sample, "leads") ? `/leads/${firstId(leads.sample, "leads")}` : null,
      "/companies",
      firstId(companies.sample, "companies") ? `/companies/${firstId(companies.sample, "companies")}` : null,
      "/contacts",
      firstId(contacts.sample, "contacts") ? `/contacts/${firstId(contacts.sample, "contacts")}` : null,
      "/properties",
      firstId(properties.sample, "properties") ? `/properties/${firstId(properties.sample, "properties")}` : null,
      "/tasks",
      "/reports",
      "/email",
      "/files",
    ].filter((route): route is string => Boolean(route));

    for (const route of routes) {
      await smokeRoute(page, route);
    }
  });

  test("sales cleanup gate renders assigned smoke cleanup items", async ({ page }) => {
    const loginResult = await login(page, "test-sales@trock.test");
    report.apiChecks.push({
      label: "sales login onboarding gate",
      status: 200,
      ok: true,
      sample: loginResult.user,
    });

    await smokeRoute(page, "/pipeline/my-cleanup");
    await smokeRoute(page, "/onboarding-required");
  });
});
