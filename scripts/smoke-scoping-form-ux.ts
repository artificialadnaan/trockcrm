import { chromium, type Page } from "playwright";

type CliOptions = {
  apiBaseUrl: string;
  origin: string;
  salesEmail: string;
  salesPassword: string;
  adminEmail: string;
  adminPassword: string;
  retain: boolean;
};

type Session = {
  cookies: string;
  csrf: string;
  user: { id: string; email: string; role: string };
};

type Deal = {
  id: string;
  name: string;
  stageId: string;
  projectTypeId: string | null;
};

type SmokeFixture = {
  deal: Deal;
  companyId: string;
  propertyId: string;
  projectType: ProjectType;
};

type PipelineStage = {
  id: string;
  slug: string;
  workflowFamily: string;
  isTerminal?: boolean;
};

type ProjectType = {
  id: string;
  name: string;
};

function readArg(name: string) {
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : null;
}

function hasFlag(name: string) {
  return process.argv.includes(name);
}

function readOptions(): CliOptions {
  return {
    apiBaseUrl:
      readArg("--api-base") ??
      process.env.SMOKE_API_BASE_URL ??
      process.env.API_BASE_URL ??
      "https://api-production-ad218.up.railway.app",
    origin:
      readArg("--origin") ??
      process.env.SMOKE_ORIGIN ??
      process.env.FRONTEND_URL ??
      "https://frontend-production-bcab.up.railway.app",
    salesEmail: readArg("--sales-email") ?? process.env.SMOKE_SALES_EMAIL ?? "test-sales@trock.test",
    salesPassword: readArg("--sales-password") ?? process.env.SMOKE_SALES_PASSWORD ?? "TrockTest123!",
    adminEmail: readArg("--admin-email") ?? process.env.SMOKE_ADMIN_EMAIL ?? "test-admin@trock.test",
    adminPassword: readArg("--admin-password") ?? process.env.SMOKE_ADMIN_PASSWORD ?? "dev123!",
    retain: hasFlag("--retain"),
  };
}

function cookieHeaderFrom(headers: Headers) {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  const setCookie = getSetCookie ? getSetCookie.call(headers) : [];
  return setCookie.map((entry) => entry.split(";")[0]).join("; ");
}

function cookieValue(cookies: string, name: string) {
  const match = cookies
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

async function apiJson<T>(
  options: CliOptions,
  path: string,
  session: Session | null,
  init: RequestInit & { expectedStatus?: number | number[] } = {}
): Promise<{ status: number; headers: Headers; body: T }> {
  const response = await fetch(`${options.apiBaseUrl.replace(/\/$/, "")}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(session ? { cookie: session.cookies, "x-csrf-token": session.csrf } : {}),
      ...(init.headers ?? {}),
    },
  });
  const expected = Array.isArray(init.expectedStatus)
    ? init.expectedStatus
    : [init.expectedStatus ?? 200];
  const text = await response.text();
  let body: T;
  try {
    body = text ? (JSON.parse(text) as T) : ({} as T);
  } catch {
    body = { raw: text } as T;
  }
  if (!expected.includes(response.status)) {
    throw new Error(`HTTP ${response.status} for ${path}: ${text.slice(0, 700)}`);
  }
  return { status: response.status, headers: response.headers, body };
}

async function login(options: CliOptions, email: string, password: string): Promise<Session> {
  const response = await apiJson<{ user: Session["user"] }>(options, "/api/auth/local/login", null, {
    method: "POST",
    body: JSON.stringify({ email, password }),
    expectedStatus: 200,
  });
  const cookies = cookieHeaderFrom(response.headers);
  const csrf = cookieValue(cookies, "csrf_token");
  if (!cookies.includes("token=") || !csrf) {
    throw new Error(`Login for ${email} did not return token/csrf cookies`);
  }
  return { user: response.body.user, cookies, csrf };
}

async function createSmokeDeal(options: CliOptions, sales: Session, admin: Session): Promise<SmokeFixture> {
  let companyId: string | null = null;
  let propertyId: string | null = null;
  let dealId: string | null = null;

  try {
    const [stages, projectTypes] = await Promise.all([
      apiJson<{ stages: PipelineStage[] }>(options, "/api/pipeline/stages?workflowFamily=standard_deal", sales),
      apiJson<{ projectTypes: ProjectType[] }>(options, "/api/pipeline/project-types", sales),
    ]);
    const opportunityStage =
      stages.body.stages.find((stage) => stage.slug === "opportunity" && stage.workflowFamily === "standard_deal") ??
      stages.body.stages.find((stage) => stage.workflowFamily === "standard_deal" && !stage.isTerminal);
    const projectType =
      projectTypes.body.projectTypes.find((type) => /roof/i.test(type.name)) ??
      projectTypes.body.projectTypes[0];
    if (!opportunityStage || !projectType) {
      throw new Error("Missing opportunity stage or active project type for smoke deal creation");
    }

    const name = `SMOKE TEST DELETE - Scoping Form UX ${new Date().toISOString()}`;
    const company = await apiJson<{ company: { id: string } }>(options, "/api/companies", sales, {
      method: "POST",
      body: JSON.stringify({
        name,
        category: "other",
        address: "501 Smoke Test Way",
        city: "Dallas",
        state: "TX",
        zip: "75201",
        notes: "SMOKE TEST DELETE - scoping form UX smoke fixture",
      }),
      expectedStatus: 201,
    });
    companyId = company.body.company.id;

    const property = await apiJson<{ property: { id: string } }>(options, "/api/properties", sales, {
      method: "POST",
      body: JSON.stringify({
        companyId,
        name,
        address: "501 Smoke Test Way",
        city: "Dallas",
        state: "TX",
        zip: "75201",
        notes: "SMOKE TEST DELETE - scoping form UX smoke fixture",
      }),
      expectedStatus: 201,
    });
    propertyId = property.body.property.id;

    const created = await apiJson<{ deal: Deal }>(options, "/api/deals", sales, {
      method: "POST",
      body: JSON.stringify({
        name,
        stageId: opportunityStage.id,
        projectTypeId: projectType.id,
        companyId,
        propertyId,
        description: "SMOKE TEST DELETE - verifies deal scoping form UX",
        propertyAddress: "501 Smoke Test Way",
        propertyCity: "Dallas",
        propertyState: "TX",
        propertyZip: "75201",
      }),
      expectedStatus: 201,
    });
    dealId = created.body.deal.id;
    return { deal: created.body.deal, companyId, propertyId, projectType };
  } catch (error) {
    await cleanupSmokeFixture(options, admin, { dealId, propertyId, companyId, retain: false });
    throw error;
  }
}

async function cleanupSmokeFixture(
  options: CliOptions,
  admin: Session,
  fixture: { dealId: string | null; propertyId: string | null; companyId: string | null; retain: boolean }
) {
  if (fixture.retain) {
    console.log(
      `[smoke] retained fixture deal=${fixture.dealId ?? "none"} property=${fixture.propertyId ?? "none"} company=${fixture.companyId ?? "none"}`
    );
    return;
  }
  const cleanupTargets = [
    fixture.dealId ? `/api/deals/${fixture.dealId}` : null,
    fixture.propertyId ? `/api/properties/${fixture.propertyId}` : null,
    fixture.companyId ? `/api/companies/${fixture.companyId}` : null,
  ].filter((path): path is string => Boolean(path));
  for (const path of cleanupTargets) {
    await apiJson(options, path, admin, {
      method: "DELETE",
      expectedStatus: [204, 404],
    });
  }
}

async function openScopeTab(page: Page, options: CliOptions, dealId: string) {
  await page.goto(`${options.origin.replace(/\/$/, "")}/deals/${dealId}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("tab", { name: /scoping|opportunity scope/i }).click({ timeout: 15_000 }).catch(async () => {
    await page.getByRole("button", { name: /scoping|opportunity scope/i }).click({ timeout: 15_000 });
  });
  await page.locator("#scoping-section-scope").waitFor({ timeout: 20_000 });
}

async function assertScroll(page: Page, label: string, targetSelector: string) {
  const before = await page.evaluate(() => window.scrollY);
  await page.getByRole("button", { name: new RegExp(label, "i") }).first().click();
  await page.waitForTimeout(500);
  await page.locator(targetSelector).waitFor({ timeout: 5_000 });
  const after = await page.evaluate(() => window.scrollY);
  const targetTop = await page.locator(targetSelector).evaluate((element) =>
    Math.round(element.getBoundingClientRect().top)
  );
  if (after === before && Math.abs(targetTop) > 160) {
    throw new Error(`Clicking ${label} did not scroll near ${targetSelector}`);
  }
}

async function runBrowserSmoke(options: CliOptions, sales: Session, deal: Deal) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ baseURL: options.origin });
  const frontendUrl = new URL(options.origin);
  const apiUrl = new URL(options.apiBaseUrl);
  const cookieTargets = Array.from(new Set([frontendUrl.hostname, apiUrl.hostname]));
  await context.addCookies(
    sales.cookies.split(";").flatMap((part) => {
      const [name, ...rest] = part.trim().split("=");
      return cookieTargets.map((domain) => ({
        name,
        value: rest.join("="),
        domain,
        path: "/",
        httpOnly: name === "token",
        secure: (domain === apiUrl.hostname ? apiUrl : frontendUrl).protocol === "https:",
        sameSite: "Lax" as const,
      }));
    })
  );
  const page = await context.newPage();
  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") failures.push(message.text());
  });

  try {
    await openScopeTab(page, options, deal.id);

    for (const [label, selector] of [
      ["Project Overview", "#scoping-section-projectOverview"],
      ["Opportunity Review", "#scoping-section-opportunity"],
      ["Property Details", "#scoping-section-propertyDetails"],
      ["Scope", "#scoping-section-scope"],
      ["Attachments", "#scoping-section-attachments"],
    ] as const) {
      await assertScroll(page, label, selector);
    }

    await page.getByRole("button", { name: /Property Details: Property Address/i }).click();
    await page.waitForTimeout(500);
    await page.locator("#scoping-field-propertyDetails-propertyAddress").waitFor();

    const bodyText = await page.locator("body").innerText();
    if (!bodyText.includes("Scope docs") || !bodyText.includes("Site photos")) {
      throw new Error("Attachment cards were not visible");
    }
    if (/Scope docs\s+Required|Site photos\s+Required/i.test(bodyText)) {
      throw new Error("Scope docs or Site photos still show Required");
    }

    await page.locator("#scoping-section-scope").scrollIntoViewIfNeeded();
    await page.getByText("Select at least one scope item that applies to this project. You can choose multiple.").waitFor();
    const firstScopeButton = page.locator("#scoping-section-scope button[aria-pressed]").first();
    const selectedBefore = await firstScopeButton.getAttribute("aria-pressed");
    const beforeUrl = page.url();
    const beforeY = await page.evaluate(() => window.scrollY);
    if (selectedBefore !== "true") {
      await firstScopeButton.click();
    } else {
      await firstScopeButton.click();
      await firstScopeButton.click();
    }
    await page.getByText(/Saving|Saved|All changes saved/i).first().waitFor({ timeout: 7_000 });
    const afterUrl = page.url();
    const afterY = await page.evaluate(() => window.scrollY);
    if (beforeUrl !== afterUrl) {
      throw new Error("Scope selection changed the current URL");
    }
    if (Math.abs(afterY - beforeY) > 100) {
      throw new Error(`Scope selection changed scroll position from ${beforeY} to ${afterY}`);
    }

    if (failures.length > 0) {
      throw new Error(`Browser errors during smoke: ${failures.join(" | ")}`);
    }
  } finally {
    await browser.close();
  }
}

async function assertServerValidation(options: CliOptions, sales: Session, deal: Deal) {
  const bidDueDate = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  await apiJson(options, `/api/deals/${deal.id}/scoping-intake`, sales, {
    method: "PATCH",
    body: JSON.stringify({
      sectionData: {
        projectOverview: { propertyName: deal.name, bidDueDate },
        opportunity: {
          preBidMeetingCompleted: "yes",
          siteVisitDecision: "not_required",
        },
        propertyDetails: { propertyAddress: "501 Smoke Test Way" },
        scope: { selectedProjectTypeIds: deal.projectTypeId ? [deal.projectTypeId] : [] },
        scopeSummary: { summary: "SMOKE TEST DELETE - verifies deal scoping form UX" },
      },
    }),
  });
  const ready = await apiJson<{ readiness: { status: string; errors: { attachments: Record<string, string[]> } } }>(
    options,
    `/api/deals/${deal.id}/scoping-intake/readiness`,
    sales
  );
  if (ready.body.readiness.status !== "ready") {
    throw new Error(`Expected scoping readiness ready without Scope docs/Site photos, got ${JSON.stringify(ready.body)}`);
  }
  if (Object.keys(ready.body.readiness.errors.attachments ?? {}).length > 0) {
    throw new Error(`Attachments still block readiness: ${JSON.stringify(ready.body.readiness.errors.attachments)}`);
  }

  await apiJson(options, `/api/deals/${deal.id}/scoping-intake`, sales, {
    method: "PATCH",
    body: JSON.stringify({
      sectionData: {
        scope: { selectedProjectTypeIds: [] },
      },
    }),
  });
  const response = await apiJson<{ error?: string; code?: string }>(
    options,
    `/api/deals/${deal.id}/trigger-rfp`,
    sales,
    {
      method: "POST",
      expectedStatus: 400,
    }
  );
  const errorText = JSON.stringify(response.body);
  if (!/scope|selectedProjectTypeIds/i.test(errorText)) {
    throw new Error(`Expected zero-scope validation error, got ${errorText}`);
  }
}

async function main() {
  const options = readOptions();
  const sales = await login(options, options.salesEmail, options.salesPassword);
  const admin = await login(options, options.adminEmail, options.adminPassword);
  const { deal, companyId, propertyId, projectType } = await createSmokeDeal(options, sales, admin);
  console.log(`[smoke] created ${deal.name} (${deal.id}) using ${projectType.name}`);
  try {
    await runBrowserSmoke(options, sales, deal);
    await assertServerValidation(options, sales, deal);
    console.log("[smoke] scoping form UX smoke passed");
  } finally {
    await cleanupSmokeFixture(options, admin, {
      dealId: deal.id,
      propertyId,
      companyId,
      retain: options.retain,
    });
  }
}

main().catch((error) => {
  console.error("[smoke] failed", error);
  process.exit(1);
});
