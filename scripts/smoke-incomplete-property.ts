import pg from "pg";
import { chromium, type Page } from "playwright";

const MARKER = "SMOKE TEST DELETE incomplete property";
const DEFAULT_FRONTEND_URL = "https://trockcrm.com";

type Fixture = {
  schemaName: string;
  companyId: string;
  contactId: string;
  completePropertyId: string;
  incompletePropertyId: string;
  dealId: string;
  projectTypeId: string;
};

function readArg(name: string) {
  const prefix = `${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? null;
}

function connectionString() {
  const selected = process.env.DATABASE_PUBLIC_URL?.trim() || process.env.DATABASE_URL?.trim();
  if (!selected) throw new Error("DATABASE_PUBLIC_URL or DATABASE_URL is required");
  if (!process.env.DATABASE_PUBLIC_URL && /railway\.internal/.test(selected)) {
    throw new Error("DATABASE_URL points at railway.internal; run through Railway Postgres env or set DATABASE_PUBLIC_URL.");
  }
  return selected;
}

function qident(schemaName: string) {
  if (!/^office_[a-z0-9_]+$/.test(schemaName)) throw new Error(`Unsafe schema name: ${schemaName}`);
  return `"${schemaName}"`;
}

async function cleanupFixture(client: pg.Client, schemaName: string) {
  const schema = qident(schemaName);
  await client.query("BEGIN");
  try {
    await client.query(`
      DELETE FROM ${schema}.deal_scoping_intake
      WHERE deal_id IN (SELECT id FROM ${schema}.deals WHERE description ILIKE $1)
    `, [`${MARKER}%`]);
    await client.query(`DELETE FROM ${schema}.deals WHERE description ILIKE $1`, [`${MARKER}%`]);
    await client.query(`DELETE FROM ${schema}.leads WHERE description ILIKE $1`, [`${MARKER}%`]);
    await client.query(`DELETE FROM ${schema}.contacts WHERE notes ILIKE $1`, [`${MARKER}%`]);
    await client.query(`DELETE FROM ${schema}.properties WHERE notes ILIKE $1`, [`${MARKER}%`]);
    await client.query(`DELETE FROM ${schema}.companies WHERE notes ILIKE $1`, [`${MARKER}%`]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function createFixture(client: pg.Client, email: string): Promise<Fixture> {
  const user = await client.query<{ office_slug: string; user_id: string }>(`
    SELECT o.slug AS office_slug, u.id AS user_id
    FROM public.users u
    JOIN public.offices o ON o.id = COALESCE(u.active_office_id, u.office_id)
    WHERE lower(u.email) = lower($1)
    LIMIT 1
  `, [email]);
  const officeSlug = user.rows[0]?.office_slug ?? "dallas";
  const userId = user.rows[0]?.user_id;
  const schemaName = `office_${officeSlug}`;
  const schema = qident(schemaName);
  await cleanupFixture(client, schemaName);

  const stage = await client.query<{ id: string }>(`
    SELECT id FROM public.pipeline_stage_config
    WHERE is_active = true AND workflow_family = 'standard_deal'
    ORDER BY display_order ASC
    LIMIT 1
  `);
  const projectType = await client.query<{ id: string; name: string }>(`
    SELECT id, name FROM public.project_type_config
    WHERE is_active = true
    ORDER BY display_order ASC NULLS LAST, name ASC
    LIMIT 1
  `);
  if (!stage.rows[0] || !projectType.rows[0] || !userId) throw new Error("Missing smoke fixture prerequisites");

  const company = await client.query<{ id: string }>(`
    INSERT INTO ${schema}.companies (name, slug, category, city, state, notes, is_test_data, is_active, updated_at)
    VALUES ($1, $2, 'client', 'Dallas', 'TX', $3, true, true, NOW())
    RETURNING id
  `, [`${MARKER} Company`, `smoke-incomplete-property-${Date.now()}`, MARKER]);
  const contact = await client.query<{ id: string }>(`
    INSERT INTO ${schema}.contacts (company_id, first_name, last_name, email, phone, category, notes, is_test_data, is_active, updated_at)
    VALUES ($1, 'Smoke', 'Property', $2, '555-010-1000', 'client', $3, true, true, NOW())
    RETURNING id
  `, [company.rows[0].id, `smoke-incomplete-property-${Date.now()}@example.invalid`, MARKER]);
  const completeProperty = await client.query<{ id: string }>(`
    INSERT INTO ${schema}.properties (company_id, name, address, city, state, zip, build_year, unit_count, notes, is_test_data, is_active, updated_at)
    VALUES ($1, $2, '100 Complete Way', 'Dallas', 'TX', '75201', 2001, 120, $3, true, true, NOW())
    RETURNING id
  `, [company.rows[0].id, `${MARKER} Complete Property`, MARKER]);
  const incompleteProperty = await client.query<{ id: string }>(`
    INSERT INTO ${schema}.properties (company_id, name, address, city, state, zip, build_year, unit_count, notes, is_test_data, is_active, updated_at)
    VALUES ($1, $2, NULL, 'Peachtree Corners', 'GA', NULL, 2001, 120, $3, true, true, NOW())
    RETURNING id
  `, [company.rows[0].id, `${MARKER} Incomplete Property`, MARKER]);
  const deal = await client.query<{ id: string }>(`
    INSERT INTO ${schema}.deals (
      deal_number, name, stage_id, assigned_rep_id, primary_contact_id, company_id, property_id,
      description, property_address, property_city, property_state, property_zip,
      project_type, project_type_id, source, workflow_route, is_test_data, is_active, stage_entered_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '100 Complete Way', 'Dallas', 'TX', '75201',
      $9, $10, 'test-data', 'normal', true, true, NOW(), NOW())
    RETURNING id
  `, [
    `SMOKE-${Date.now()}`,
    `${MARKER} Deal`,
    stage.rows[0].id,
    userId,
    contact.rows[0].id,
    company.rows[0].id,
    completeProperty.rows[0].id,
    MARKER,
    projectType.rows[0].name,
    projectType.rows[0].id,
  ]);

  return {
    schemaName,
    companyId: company.rows[0].id,
    contactId: contact.rows[0].id,
    completePropertyId: completeProperty.rows[0].id,
    incompletePropertyId: incompleteProperty.rows[0].id,
    dealId: deal.rows[0].id,
    projectTypeId: projectType.rows[0].id,
  };
}

async function login(page: Page, frontendUrl: string, email: string, password: string) {
  await page.goto(`${frontendUrl}/login`, { waitUntil: "networkidle" });
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole("button", { name: /sign in|log in/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 30_000 });
}

async function selectAndRepairIncompleteProperty(page: Page, street: string, zip: string) {
  await page.getByRole("button", { name: /select property|complete|incomplete|project address/i }).first().click();
  await page.getByText("(incomplete address)").first().waitFor({ timeout: 15_000 });
  await page.getByText(`${MARKER} Complete Property`).waitFor({ timeout: 15_000 });
  await page.getByText(`${MARKER} Incomplete Property`).click();
  await page.getByText("Complete this property address").waitFor({ timeout: 10_000 });
  await page.getByLabel("Property street address").fill(street);
  await page.getByLabel("Property ZIP").fill(zip);
  await page.getByRole("button", { name: "Save address" }).click();
  await page.getByText("Complete this property address").waitFor({ state: "detached", timeout: 15_000 });
}

async function resetIncompleteProperty(client: pg.Client, fixture: Fixture) {
  await client.query(`
    UPDATE ${qident(fixture.schemaName)}.properties
    SET address = NULL, zip = NULL, updated_at = NOW()
    WHERE id = $1
  `, [fixture.incompletePropertyId]);
}

async function assertPropertyAddress(client: pg.Client, fixture: Fixture, expectedAddress: string, expectedZip: string) {
  const row = await client.query<{ address: string | null; zip: string | null }>(`
    SELECT address, zip FROM ${qident(fixture.schemaName)}.properties WHERE id = $1
  `, [fixture.incompletePropertyId]);
  if (row.rows[0]?.address !== expectedAddress || row.rows[0]?.zip !== expectedZip) {
    throw new Error(`Expected repaired property ${expectedAddress} ${expectedZip}, got ${JSON.stringify(row.rows[0])}`);
  }
}

async function assertDirectDealSnapshot(client: pg.Client, fixture: Fixture, expectedAddress: string, expectedZip: string) {
  const row = await client.query<{
    property_address: string | null;
    property_city: string | null;
    property_state: string | null;
    property_zip: string | null;
  }>(`
    SELECT property_address, property_city, property_state, property_zip
    FROM ${qident(fixture.schemaName)}.deals
    WHERE description = $1
    ORDER BY created_at DESC
    LIMIT 1
  `, [`${MARKER} direct create`]);
  const deal = row.rows[0];
  if (
    !deal ||
    deal.property_address !== expectedAddress ||
    deal.property_city !== "Peachtree Corners" ||
    deal.property_state !== "GA" ||
    deal.property_zip !== expectedZip
  ) {
    throw new Error(`Expected direct deal snapshot to use repaired property address, got ${JSON.stringify(deal)}`);
  }
}

async function main() {
  if (process.argv.includes("--help")) {
    console.log("Usage: SMOKE_PASSWORD=... DATABASE_PUBLIC_URL=... node --import tsx scripts/smoke-incomplete-property.ts [--frontend-url=https://trockcrm.com] [--email=test-sales@trock.test]");
    return;
  }

  const frontendUrl = (readArg("--frontend-url") ?? process.env.SMOKE_FRONTEND_URL ?? DEFAULT_FRONTEND_URL).replace(/\/$/, "");
  const email = readArg("--email") ?? process.env.SMOKE_EMAIL ?? "test-sales@trock.test";
  const password = readArg("--password") ?? process.env.SMOKE_PASSWORD;
  if (!password) throw new Error("SMOKE_PASSWORD or --password=... is required");

  const client = new pg.Client({
    connectionString: connectionString(),
    ssl: connectionString().includes("localhost") ? undefined : { rejectUnauthorized: false },
  });
  await client.connect();
  const fixture = await createFixture(client, email);
  const browser = await chromium.launch({ headless: process.env.HEADLESS !== "0" });
  const page = await browser.newPage();
  try {
    await login(page, frontendUrl, email, password);

    await page.goto(`${frontendUrl}/leads/new?companyId=${fixture.companyId}&primaryContactId=${fixture.contactId}&name=${encodeURIComponent(`${MARKER} Lead`)}`, { waitUntil: "networkidle" });
    await selectAndRepairIncompleteProperty(page, "5000 Triangle Pkwy", "30092");
    await assertPropertyAddress(client, fixture, "5000 Triangle Pkwy", "30092");

    await resetIncompleteProperty(client, fixture);
    await page.goto(`${frontendUrl}/deals/${fixture.dealId}?tab=scoping`, { waitUntil: "networkidle" });
    await page.getByText("Change Property").waitFor({ timeout: 20_000 });
    await selectAndRepairIncompleteProperty(page, "6000 Triangle Pkwy", "30092");
    await assertPropertyAddress(client, fixture, "6000 Triangle Pkwy", "30092");

    await resetIncompleteProperty(client, fixture);
    await page.goto(`${frontendUrl}/deals/new?companyId=${fixture.companyId}&name=${encodeURIComponent(`${MARKER} Direct Deal`)}&description=${encodeURIComponent(`${MARKER} direct create`)}&projectTypeId=${fixture.projectTypeId}`, { waitUntil: "networkidle" });
    await selectAndRepairIncompleteProperty(page, "7000 Triangle Pkwy", "30092");
    await page.getByRole("button", { name: "Create Deal" }).click();
    await page.waitForURL(/\/deals\/[^/]+$/, { timeout: 30_000 });
    await assertDirectDealSnapshot(client, fixture, "7000 Triangle Pkwy", "30092");

    console.log(JSON.stringify({
      ok: true,
      fixture: {
        schemaName: fixture.schemaName,
        companyId: fixture.companyId,
        completePropertyId: fixture.completePropertyId,
        incompletePropertyId: fixture.incompletePropertyId,
        dealId: fixture.dealId,
      },
      assertions: [
        "lead form dropdown showed complete and incomplete properties",
        "incomplete property was visually flagged",
        "lead form inline address repair updated property",
        "deal scoping Change Property inline address repair updated property",
        "direct deal create copied repaired property address into deal snapshot",
      ],
    }, null, 2));
  } finally {
    await browser.close();
    await cleanupFixture(client, fixture.schemaName);
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
