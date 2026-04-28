import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// Real-backend Playwright spec for Commit 7's YTD/MTD contracts-signed cards
// on the rep dashboard. Matches the house style (see
// pipeline-workflow-alignment.spec.ts) — creates test data via real API
// endpoints as admin, then logs in as the rep to verify rendered values.
//
// Setup math (assuming "today" is in 2026):
//   Deal A — contract_signed_date = today        (current month, current year) → MTD + YTD
//   Deal B — contract_signed_date = 2026-02-15   (prior month, current year)   → YTD only
//   Deal C — contract_signed_date = 2025-12-01   (prior year)                  → neither
//
// Expected aggregates for rep@trock.dev:
//   YTD count = 2, YTD value = $50k + $80k = $130,000
//   MTD count = 1, MTD value = $50,000
//
// Cleanup deletes all three deals. If a test fails between setup and cleanup
// the deals will linger — names use a Date.now() suffix so they don't collide
// with future runs.

const ADMIN_EMAIL = "admin@trock.dev";
const REP_EMAIL = "rep@trock.dev";

const RUN_ID = String(Date.now());
const DEAL_A_NAME = `PW Contracts YTD-MTD A ${RUN_ID}`;
const DEAL_B_NAME = `PW Contracts YTD-MTD B ${RUN_ID}`;
const DEAL_C_NAME = `PW Contracts YTD-MTD C ${RUN_ID}`;

// Today in YYYY-MM-DD. TZ-aligned to America/Chicago to match server's
// `today` derivation in dashboard/service.ts; safe to run from any TZ.
function todayIso(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
  }).format(new Date());
}

const TODAY = todayIso();
const PRIOR_MONTH_DATE = `${TODAY.slice(0, 4)}-02-15`; // Feb 15 of current year
const PRIOR_YEAR_DATE = `${Number(TODAY.slice(0, 4)) - 1}-12-01`; // Dec 1 of prior year

interface DevUser { id: string; email: string; role: string; }

async function loginAs(request: APIRequestContext, email: string): Promise<DevUser> {
  const usersResponse = await request.get("/api/auth/dev/users");
  expect(usersResponse.ok()).toBeTruthy();
  const usersData = (await usersResponse.json()) as { users: DevUser[] };
  const target = usersData.users.find((u) => u.email.toLowerCase() === email.toLowerCase());
  expect(target, `dev user ${email} must be seeded — run scripts/seed-dev-users.ts`).toBeDefined();
  const loginResponse = await request.post("/api/auth/dev/login", {
    data: { email: target!.email },
  });
  expect(loginResponse.ok()).toBeTruthy();
  return target!;
}

async function loginPageAs(page: Page, email: string): Promise<DevUser> {
  return loginAs(page.context().request, email);
}

interface CreatedDeal { id: string; }

async function createSignedDeal(
  request: APIRequestContext,
  options: {
    name: string;
    stageId: string;
    repUserId: string;
    awardedAmount: string;
    contractSignedDate: string;
    companyId: string;
    propertyId: string;
  }
): Promise<CreatedDeal> {
  const createResp = await request.post("/api/deals", {
    data: {
      name: options.name,
      stageId: options.stageId,
      assignedRepId: options.repUserId,
      awardedAmount: options.awardedAmount,
      companyId: options.companyId,
      propertyId: options.propertyId,
    },
  });
  expect(createResp.ok(), `POST /api/deals for ${options.name} should succeed`).toBeTruthy();
  const { deal } = (await createResp.json()) as { deal: { id: string } };

  const signResp = await request.patch(`/api/deals/${deal.id}/contract-signed-date`, {
    data: { date: options.contractSignedDate },
  });
  expect(signResp.ok(), `PATCH /:id/contract-signed-date for ${options.name} should succeed`).toBeTruthy();
  return { id: deal.id };
}

// Locator that finds the StatCard div whose value/subtitle text we want to
// assert against. The card title is rendered as a <p> inside CardContent;
// finding the nearest ancestor that contains both the title and the values
// gives us a tight scope.
function cardLocatorByTitle(page: Page, title: string) {
  return page.locator(":scope div", { hasText: title }).filter({
    has: page.getByText(title, { exact: true }),
  });
}

test.describe.serial("rep dashboard: contracts signed YTD/MTD cards", () => {
  let adminRequest: APIRequestContext;
  let repUser: DevUser;
  const createdDealIds: string[] = [];

  test.beforeAll(async ({ playwright }) => {
    adminRequest = await playwright.request.newContext({
      baseURL: process.env.PLAYWRIGHT_BASE_URL?.trim() || "http://127.0.0.1:4173",
    });

    await loginAs(adminRequest, ADMIN_EMAIL);

    // Discover the rep user id (needed for assignedRepId).
    const usersResp = await adminRequest.get("/api/auth/dev/users");
    expect(usersResp.ok()).toBeTruthy();
    const { users } = (await usersResp.json()) as { users: DevUser[] };
    const rep = users.find((u) => u.email.toLowerCase() === REP_EMAIL);
    expect(rep, `dev user ${REP_EMAIL} must be seeded — run scripts/seed-dev-users.ts`).toBeDefined();
    repUser = rep!;

    // Pick any non-terminal deal stage. POST /api/deals requires stageId.
    const stagesResp = await adminRequest.get("/api/pipeline/stages?workflowFamily=deal");
    expect(stagesResp.ok()).toBeTruthy();
    const stagesData = (await stagesResp.json()) as {
      stages: Array<{ id: string; slug: string; isTerminal?: boolean }>;
    };
    const stage = stagesData.stages.find((s) => !s.isTerminal) ?? stagesData.stages[0];
    expect(stage, "at least one deal stage must exist").toBeDefined();

    // Pick any property — its companyId pairs with it for the deal payload.
    const propsResp = await adminRequest.get("/api/properties?limit=1");
    expect(propsResp.ok()).toBeTruthy();
    const propsData = (await propsResp.json()) as {
      properties: Array<{ id: string; companyId: string }>;
    };
    const property = propsData.properties[0];
    expect(
      property,
      "Dev environment requires at least one seeded property for deal creation. " +
        "Seed via the admin UI or import a tenant fixture; silent test.skip on missing " +
        "data is the wrong failure mode for a regression spec."
    ).toBeDefined();

    const dealA = await createSignedDeal(adminRequest, {
      name: DEAL_A_NAME,
      stageId: stage!.id,
      repUserId: repUser.id,
      awardedAmount: "50000",
      contractSignedDate: TODAY,
      companyId: property.companyId,
      propertyId: property.id,
    });
    const dealB = await createSignedDeal(adminRequest, {
      name: DEAL_B_NAME,
      stageId: stage!.id,
      repUserId: repUser.id,
      awardedAmount: "80000",
      contractSignedDate: PRIOR_MONTH_DATE,
      companyId: property.companyId,
      propertyId: property.id,
    });
    const dealC = await createSignedDeal(adminRequest, {
      name: DEAL_C_NAME,
      stageId: stage!.id,
      repUserId: repUser.id,
      awardedAmount: "100000",
      contractSignedDate: PRIOR_YEAR_DATE,
      companyId: property.companyId,
      propertyId: property.id,
    });
    createdDealIds.push(dealA.id, dealB.id, dealC.id);
  });

  test.afterAll(async () => {
    if (!adminRequest) return;
    for (const id of createdDealIds) {
      const resp = await adminRequest.delete(`/api/deals/${id}`);
      // Best-effort cleanup; log but don't fail the suite if a deal is
      // already gone or can't be deleted.
      if (!resp.ok()) {
        console.warn(`[cleanup] DELETE /api/deals/${id} → ${resp.status()}`);
      }
    }
    await adminRequest.dispose();
  });

  test("rep sees YTD card with count=2 and value=$130,000 above existing grid", async ({ page }) => {
    await loginPageAs(page, REP_EMAIL);
    await page.goto("/");

    // Title visible on the page (positive existence check).
    const ytdTitle = page.getByText("Contracts Signed YTD", { exact: true });
    await expect(ytdTitle).toBeVisible();

    // Card region — climb to the StatCard's outer Card, then assert content.
    const ytdCard = cardLocatorByTitle(page, "Contracts Signed YTD").first();
    await expect(ytdCard).toContainText("Contracts Signed YTD");
    await expect(ytdCard).toContainText("2"); // YTD count
    await expect(ytdCard).toContainText("130,000"); // YTD value (currency-symbol-agnostic)

    // The new cards must appear ABOVE the existing 6-card grid. We assert
    // this by checking that "Contracts Signed YTD" appears in the rendered
    // HTML before "Active Leads" (the first card of the existing grid).
    const html = await page.content();
    const ytdIdx = html.indexOf("Contracts Signed YTD");
    const activeLeadsIdx = html.indexOf("Active Leads");
    expect(ytdIdx).toBeGreaterThan(-1);
    expect(activeLeadsIdx).toBeGreaterThan(-1);
    expect(ytdIdx).toBeLessThan(activeLeadsIdx);
  });

  test("rep sees MTD card with count=1 and value=$50,000", async ({ page }) => {
    await loginPageAs(page, REP_EMAIL);
    await page.goto("/");

    const mtdTitle = page.getByText("Contracts Signed MTD", { exact: true });
    await expect(mtdTitle).toBeVisible();

    const mtdCard = cardLocatorByTitle(page, "Contracts Signed MTD").first();
    await expect(mtdCard).toContainText("Contracts Signed MTD");
    await expect(mtdCard).toContainText("1");
    await expect(mtdCard).toContainText("50,000");
  });

  test("MTD ⊆ YTD invariants: MTD count ≤ YTD count, MTD value ≤ YTD value", async ({ page }) => {
    await loginPageAs(page, REP_EMAIL);
    await page.goto("/");

    // Hit the JSON endpoint directly — DOM scraping for numeric comparison
    // is fragile; the API response is the source of truth and the cards
    // render from it.
    const resp = await page.request.get("/api/dashboard/rep");
    expect(resp.ok()).toBeTruthy();
    const { data } = (await resp.json()) as {
      data: {
        contractsSignedYtd: { count: number; totalValue: number };
        contractsSignedMtd: { count: number; totalValue: number };
      };
    };

    expect(data.contractsSignedMtd.count).toBeLessThanOrEqual(data.contractsSignedYtd.count);
    expect(data.contractsSignedMtd.totalValue).toBeLessThanOrEqual(data.contractsSignedYtd.totalValue);
    // Sanity: with our setup the deltas are exactly 1 and 80000 respectively.
    expect(data.contractsSignedYtd.count - data.contractsSignedMtd.count).toBe(1);
    expect(data.contractsSignedYtd.totalValue - data.contractsSignedMtd.totalValue).toBe(80000);
  });

  test("mobile viewport (375px): both cards remain visible and stack", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await loginPageAs(page, REP_EMAIL);
    await page.goto("/");

    await expect(page.getByText("Contracts Signed YTD", { exact: true })).toBeVisible();
    await expect(page.getByText("Contracts Signed MTD", { exact: true })).toBeVisible();
    // The cards' wrapping div uses `grid-cols-1 sm:grid-cols-2`, so at 375px
    // (below the sm: breakpoint of 640px) they should stack — meaning the
    // MTD card's bounding box top is greater than the YTD card's bottom.
    const ytdBox = await cardLocatorByTitle(page, "Contracts Signed YTD").first().boundingBox();
    const mtdBox = await cardLocatorByTitle(page, "Contracts Signed MTD").first().boundingBox();
    expect(ytdBox).not.toBeNull();
    expect(mtdBox).not.toBeNull();
    expect(mtdBox!.y).toBeGreaterThanOrEqual(ytdBox!.y + ytdBox!.height - 1); // -1 for sub-pixel rounding
  });

  test("admin loads /, gets AdminDashboardPage, new rep cards correctly absent", async ({ page }) => {
    await loginPageAs(page, ADMIN_EMAIL);
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    await page.goto("/");

    // Page rendered something — wait for any element from the admin
    // dashboard to appear before asserting absence of the rep-only cards.
    // The PageHeader is a stable shared element; rely on document body
    // settling first.
    await page.waitForLoadState("networkidle");

    // Rep-only cards must NOT render for admin (admin gets AdminDashboardPage,
    // a different component entirely).
    await expect(page.getByText("Contracts Signed YTD", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Contracts Signed MTD", { exact: true })).toHaveCount(0);

    expect(errors, `no uncaught page errors during admin dashboard load: ${errors.join("; ")}`).toEqual([]);
  });
});
