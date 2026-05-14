import "dotenv/config";
import { chromium, type Page } from "playwright";
import { Client } from "pg";

const DEFAULT_WEB_BASE_URL = "https://trockcrm.com";
const DEFAULT_API_BASE_URL = "https://api-production-ad218.up.railway.app";
const SALES_EMAIL = "test-sales@trock.test";
const SALES_PASSWORD = "TrockTest123!";
const SMOKE_PREFIX = "SMOKE TEST DELETE - Service Opportunity";

function arg(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function cookieHeader(cookies: Array<{ name: string; value: string }>) {
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

function csrfFromCookies(cookies: Array<{ name: string; value: string }>) {
  return cookies.find((cookie) => cookie.name === "csrf_token")?.value ?? "";
}

function quoteIdent(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

async function login(page: Page, webBaseUrl: string) {
  await page.goto(`${webBaseUrl.replace(/\/$/, "")}/`, { waitUntil: "domcontentloaded" });
  const email = page.getByLabel(/email/i).or(page.getByPlaceholder(/email/i)).first();
  await email.fill(SALES_EMAIL);
  await page.getByLabel(/password/i).or(page.getByPlaceholder(/password/i)).first().fill(SALES_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.getByText(/dashboard|deals|pipeline/i).first().waitFor({ timeout: 30_000 });
}

async function apiFetch<T>(
  apiBaseUrl: string,
  cookies: Array<{ name: string; value: string }>,
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: T }> {
  const headers = new Headers(init.headers);
  headers.set("cookie", cookieHeader(cookies));
  if (!headers.has("content-type") && init.body) headers.set("content-type", "application/json");
  const csrf = csrfFromCookies(cookies);
  if (csrf && (init.method ?? "GET").toUpperCase() !== "GET") headers.set("x-csrf-token", csrf);

  const response = await fetch(`${apiBaseUrl.replace(/\/$/, "")}/api${path}`, {
    ...init,
    headers,
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  return { status: response.status, body };
}

async function resolveOfficeSchema(client: Client, email: string) {
  const result = await client.query(
    `
      SELECT o.slug
        FROM public.users u
        JOIN public.offices o ON o.id = COALESCE(u.active_office_id, u.office_id)
       WHERE lower(u.email) = lower($1)
       LIMIT 1
    `,
    [email]
  );
  const slug = result.rows[0]?.slug ?? "dallas";
  return slug === "atlanta" ? "office_atlanta" : "office_dallas";
}

async function ensureFixture(client: Client, schemaName: string) {
  const schema = quoteIdent(schemaName);
  const suffix = Date.now().toString();
  const companyName = `${SMOKE_PREFIX} Company ${suffix}`;
  const propertyName = `${SMOKE_PREFIX} Property ${suffix}`;
  const companySlug = `smoke-service-opportunity-${suffix}`;

  const company = await client.query(
    `
      INSERT INTO ${schema}.companies (name, slug, category, notes, is_test_data, is_active, updated_at)
      VALUES ($1, $2, 'client', 'SMOKE TEST DELETE fixture for Service Opportunity smoke', true, true, now())
      RETURNING id
    `,
    [companyName, companySlug]
  );
  const property = await client.query(
    `
      INSERT INTO ${schema}.properties (company_id, name, address, city, state, zip, notes, is_test_data, is_active, updated_at)
      VALUES ($1, $2, '100 Smoke Service Way', 'Dallas', 'TX', '75201', 'SMOKE TEST DELETE fixture for Service Opportunity smoke', true, true, now())
      RETURNING id
    `,
    [company.rows[0].id, propertyName]
  );

  return {
    companyId: company.rows[0].id as string,
    companyName,
    propertyId: property.rows[0].id as string,
    propertyName,
  };
}

async function cleanup(client: Client, schemaName: string, ids: { dealId?: string; companyId?: string; propertyId?: string }) {
  const schema = quoteIdent(schemaName);
  const smokeDealRows = ids.companyId || ids.propertyId
    ? await client.query(
        `
          SELECT id
            FROM ${schema}.deals
           WHERE name ILIKE 'SMOKE TEST DELETE%'
             AND ($1::uuid IS NULL OR company_id = $1::uuid)
             AND ($2::uuid IS NULL OR property_id = $2::uuid)
        `,
        [ids.companyId ?? null, ids.propertyId ?? null]
      )
    : { rows: [] as Array<{ id: string }> };
  const dealIds = [...new Set([
    ids.dealId,
    ...smokeDealRows.rows.map((row) => row.id),
  ].filter(Boolean))] as string[];
  for (const dealId of dealIds) {
    await client.query(`DELETE FROM ${schema}.tasks WHERE deal_id = $1`, [dealId]);
    await client.query(`DELETE FROM ${schema}.deal_stage_history WHERE deal_id = $1`, [dealId]);
    await client.query(`DELETE FROM ${schema}.deal_approvals WHERE deal_id = $1`, [dealId]);
    await client.query(`DELETE FROM ${schema}.deal_scoping_intake WHERE deal_id = $1`, [dealId]);
    await client.query(`DELETE FROM ${schema}.deals WHERE id = $1 AND name ILIKE 'SMOKE TEST DELETE%'`, [dealId]);
  }
  if (ids.propertyId) {
    await client.query(`DELETE FROM ${schema}.properties WHERE id = $1 AND is_test_data = true`, [ids.propertyId]);
  }
  if (ids.companyId) {
    await client.query(`DELETE FROM ${schema}.companies WHERE id = $1 AND is_test_data = true`, [ids.companyId]);
  }
}

async function main() {
  const webBaseUrl = arg("--web-base-url") ?? process.env.SMOKE_WEB_BASE_URL ?? DEFAULT_WEB_BASE_URL;
  const apiBaseUrl = arg("--api-base-url") ?? process.env.SMOKE_API_BASE_URL ?? DEFAULT_API_BASE_URL;
  assertCondition(process.env.DATABASE_URL, "DATABASE_URL is required for DB verification and cleanup.");

  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const schemaName = await resolveOfficeSchema(db, SALES_EMAIL);
  const fixture = await ensureFixture(db, schemaName);
  let createdDealId: string | undefined;

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await login(page, webBaseUrl);
    const cookies = await page.context().cookies(apiBaseUrl);

    await page.goto(`${webBaseUrl.replace(/\/$/, "")}/deals`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: /new service opportunity/i }).waitFor({ timeout: 30_000 });
    assertCondition(await page.getByRole("button", { name: /^new deal$/i }).count() === 0, "Old New Deal button is still visible on Deals page.");

    await page.getByRole("button", { name: /new service opportunity/i }).click();
    await page.getByText("Service", { exact: true }).waitFor({ timeout: 15_000 });
    await page.getByText("Direct-create is only available for Service projects. For other project types, start a new Lead.").waitFor();
    await page.getByRole("link", { name: /start a new lead/i }).waitFor();
    assertCondition(await page.locator('[name="projectTypeId"]').count() === 0, "Project Type dropdown/input is present.");

    const opportunityName = `${SMOKE_PREFIX} ${Date.now()}`;
    await page.getByLabel(/opportunity name/i).fill(opportunityName);
    await page.getByRole("button", { name: /select company/i }).click();
    await page.getByPlaceholder(/search companies/i).fill(fixture.companyName);
    await page.getByText(fixture.companyName).click();
    await page.getByRole("button", { name: /select property/i }).click();
    await page.getByPlaceholder(/search properties/i).fill(fixture.propertyName);
    await page.getByText(fixture.propertyName).click();
    await page.getByRole("button", { name: /create service opportunity/i }).click();
    await page.waitForURL(/\/deals\/[0-9a-f-]{36}$/i, { timeout: 30_000 });
    createdDealId = page.url().match(/\/deals\/([0-9a-f-]{36})$/i)?.[1];
    assertCondition(createdDealId, "Could not parse created deal id from URL.");

    const schema = quoteIdent(schemaName);
    const verify = await db.query(
      `
        SELECT d.id,
               d.name,
               d.project_type,
               ptc.slug AS project_type_slug,
               d.workflow_route,
               d.pipeline_disposition,
               psc.slug AS stage_slug,
               d.rfp_approval_requested_at,
               d.rfp_approval_status,
               d.is_bid_board_owned,
               d.bid_board_stage_slug,
               d.bid_board_stage_entered_at,
               d.bid_board_mirror_source_entered_at,
               d.is_read_only_mirror,
               d.read_only_synced_at,
               d.company_id,
               d.property_id,
               d.assigned_rep_id
          FROM ${schema}.deals d
          JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
          LEFT JOIN public.project_type_config ptc ON ptc.id = d.project_type_id
         WHERE d.id = $1
      `,
      [createdDealId]
    );
    const deal = verify.rows[0];
    assertCondition(deal, "Created deal was not found in DB.");
    assertCondition(deal.stage_slug === "opportunity", `Expected Opportunity stage, got ${deal.stage_slug}`);
    assertCondition(deal.project_type === "service", `Expected project_type service, got ${deal.project_type}`);
    assertCondition(deal.project_type_slug === "service", `Expected project_type_slug service, got ${deal.project_type_slug}`);
    assertCondition(deal.workflow_route === "service", `Expected workflow_route service, got ${deal.workflow_route}`);
    assertCondition(deal.rfp_approval_requested_at == null, "RFP requested timestamp should be null before trigger.");
    assertCondition(deal.rfp_approval_status == null, "RFP status should be null before trigger.");
    assertCondition(deal.is_bid_board_owned === false, "New Service opportunity should not be Bid Board owned.");
    assertCondition(deal.bid_board_stage_slug == null, "New Service opportunity should not have Bid Board stage.");
    assertCondition(deal.bid_board_stage_entered_at == null, "New Service opportunity should not have Bid Board stage entered timestamp.");
    assertCondition(deal.bid_board_mirror_source_entered_at == null, "New Service opportunity should not have Bid Board mirror source entered timestamp.");
    assertCondition(deal.is_read_only_mirror === false, "New Service opportunity should not be read-only mirror.");
    assertCondition(deal.read_only_synced_at == null, "New Service opportunity should not have read-only sync timestamp.");
    assertCondition(deal.company_id === fixture.companyId, "Company id mismatch.");
    assertCondition(deal.property_id === fixture.propertyId, "Property id mismatch.");
    assertCondition(Boolean(deal.assigned_rep_id), "Assigned rep missing.");

    const malicious = await apiFetch<{ error?: { message?: string } }>(apiBaseUrl, cookies, "/deals/service-opportunity", {
      method: "POST",
      body: JSON.stringify({
        name: `${SMOKE_PREFIX} malicious non-service`,
        companyId: fixture.companyId,
        propertyId: fixture.propertyId,
        projectType: "roofing",
      }),
    });
    assertCondition(malicious.status === 400, `Expected malicious non-Service create to return 400, got ${malicious.status}.`);

    const readiness = await apiFetch<{ readiness: { status: string } }>(
      apiBaseUrl,
      cookies,
      `/deals/${createdDealId}/scoping-intake/readiness`
    );
    assertCondition(readiness.status === 200, `Expected readiness endpoint 200, got ${readiness.status}.`);

    console.log(JSON.stringify({
      ok: true,
      mode: "pre-trigger eligibility smoke; does not enqueue production RFP jobs",
      dealId: createdDealId,
      schemaName,
      rfpEligibilityFields: {
        stageSlug: deal.stage_slug,
        projectType: deal.project_type,
        projectTypeSlug: deal.project_type_slug,
        workflowRoute: deal.workflow_route,
        rfpApprovalRequestedAt: deal.rfp_approval_requested_at,
        rfpApprovalStatus: deal.rfp_approval_status,
        isBidBoardOwned: deal.is_bid_board_owned,
        bidBoardStageSlug: deal.bid_board_stage_slug,
        bidBoardStageEnteredAt: deal.bid_board_stage_entered_at,
        bidBoardMirrorSourceEnteredAt: deal.bid_board_mirror_source_entered_at,
        isReadOnlyMirror: deal.is_read_only_mirror,
        readOnlySyncedAt: deal.read_only_synced_at,
      },
      readinessStatus: readiness.body.readiness.status,
    }, null, 2));
  } finally {
    await browser.close();
    await cleanup(db, schemaName, { dealId: createdDealId, companyId: fixture.companyId, propertyId: fixture.propertyId });
    await db.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
