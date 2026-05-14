import pg from "pg";
import { chromium, type Locator, type Page } from "playwright";

const DEAL_PREFIX = "SMOKE TEST DELETE - notes-test";
const COMPANY_NAME = `${DEAL_PREFIX} Company`;
const PROPERTY_NAME = `${DEAL_PREFIX} Property`;
const CONTACT_EMAIL_LOCAL_PART = "smoke.estimator.notes";

type Options = {
  origin: string;
  email: string;
  password: string;
  headless: boolean;
  retain: boolean;
};

type SmokeFixture = {
  schemaName: string;
  dealId: string;
  dealName: string;
  companyId: string;
  propertyId: string;
  contactId: string;
  contactEmail: string;
};

function readArg(name: string) {
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : null;
}

function hasFlag(name: string) {
  return process.argv.includes(name);
}

function readOptions(): Options {
  return {
    origin:
      readArg("--origin") ??
      process.env.SMOKE_ORIGIN ??
      process.env.FRONTEND_URL ??
      "https://frontend-production-bcab.up.railway.app",
    email: readArg("--email") ?? process.env.SMOKE_EMAIL ?? "test-sales@trock.test",
    password: readArg("--password") ?? process.env.SMOKE_PASSWORD ?? "TrockTest123!",
    headless: !hasFlag("--headed") && process.env.SMOKE_HEADLESS !== "0",
    retain: hasFlag("--retain"),
  };
}

function connectionString() {
  const selected = process.env.DATABASE_PUBLIC_URL?.trim() || process.env.DATABASE_URL?.trim();
  if (!selected) {
    throw new Error("DATABASE_PUBLIC_URL or DATABASE_URL is required");
  }
  if (!process.env.DATABASE_PUBLIC_URL && /railway\.internal/.test(selected)) {
    throw new Error("DATABASE_URL points at railway.internal; run via Railway service env or provide DATABASE_PUBLIC_URL.");
  }
  return selected;
}

function assertSafeSchemaName(schemaName: string) {
  if (!/^office_[a-z0-9_]+$/.test(schemaName)) {
    throw new Error(`Unsafe office schema name: ${schemaName}`);
  }
}

function qident(schemaName: string) {
  assertSafeSchemaName(schemaName);
  return `"${schemaName}"`;
}

function officeCodeFromSlug(slug: string) {
  if (slug === "dallas") return "dfw";
  if (slug === "atlanta") return "atl";
  return slug.slice(0, 3).toLowerCase();
}

async function cleanupSmokeRows(
  client: pg.Client,
  schemaName: string,
  ids: Pick<SmokeFixture, "dealId" | "companyId" | "propertyId" | "contactId" | "contactEmail">
) {
  const schema = qident(schemaName);
  await client.query(`DELETE FROM ${schema}.deal_scoping_intake WHERE deal_id = $1`, [ids.dealId]);
  await client.query(`DELETE FROM ${schema}.deals WHERE id = $1 AND is_test_data = true AND name ILIKE $2`, [
    ids.dealId,
    `${DEAL_PREFIX}%`,
  ]);
  await client.query(`DELETE FROM ${schema}.properties WHERE id = $1 AND is_test_data = true AND name ILIKE $2`, [
    ids.propertyId,
    `${PROPERTY_NAME}%`,
  ]);
  await client.query(`DELETE FROM ${schema}.contacts WHERE id = $1 AND is_test_data = true AND lower(email) = lower($2)`, [
    ids.contactId,
    ids.contactEmail,
  ]);
  await client.query(`DELETE FROM ${schema}.companies WHERE id = $1 AND is_test_data = true AND name ILIKE $2`, [
    ids.companyId,
    `${COMPANY_NAME}%`,
  ]);
}

async function createSmokeFixture(client: pg.Client, email: string): Promise<SmokeFixture> {
  const user = await client.query<{
    id: string;
    office_id: string;
    office_slug: string;
  }>(
    `
      SELECT u.id, u.office_id, o.slug AS office_slug
        FROM public.users u
        JOIN public.offices o ON o.id = u.office_id
       WHERE lower(u.email) = lower($1)
       LIMIT 1
    `,
    [email]
  );
  const smokeUser = user.rows[0];
  if (!smokeUser?.office_slug) {
    throw new Error(`Unable to resolve smoke user and office for ${email}`);
  }

  const schemaName = `office_${smokeUser.office_slug}`;
  assertSafeSchemaName(schemaName);
  const schema = qident(schemaName);
  await client.query("BEGIN");
  try {
    const suffix = Date.now().toString();
    const contactEmail = `${CONTACT_EMAIL_LOCAL_PART}+${suffix}@example.invalid`;
    const stage = await client.query<{ id: string }>(
      `
        SELECT id
          FROM public.pipeline_stage_config
         WHERE workflow_family = 'standard_deal'
           AND is_active_pipeline = true
           AND slug = 'opportunity'
         LIMIT 1
      `
    );
    const fallbackStage = stage.rows[0] ?? (
      await client.query<{ id: string }>(
        `
          SELECT id
            FROM public.pipeline_stage_config
           WHERE workflow_family = 'standard_deal'
             AND is_active_pipeline = true
           ORDER BY display_order ASC
           LIMIT 1
        `
      )
    ).rows[0];
    if (!fallbackStage) {
      throw new Error("No active standard deal stage is configured");
    }

    const projectType = await client.query<{ id: string }>(
      `
        SELECT id
          FROM public.project_type_config
         WHERE is_active = true
         ORDER BY code::int ASC NULLS LAST, display_order ASC, name ASC
         LIMIT 1
      `
    );

    const company = await client.query<{ id: string }>(
      `
        INSERT INTO ${schema}.companies (name, slug, category, city, state, notes, is_test_data, is_active, updated_at)
        VALUES ($1, $2, 'client', 'Dallas', 'TX', $3, true, true, NOW())
        RETURNING id
      `,
      [COMPANY_NAME, `smoke-test-delete-estimator-notes-company-${suffix}`, "SMOKE TEST DELETE fixture for estimator notes smoke"]
    );
    const contact = await client.query<{ id: string }>(
      `
        INSERT INTO ${schema}.contacts (first_name, last_name, email, company_name, company_id, category, notes, is_test_data, is_active, updated_at)
        VALUES ('Smoke', 'Estimator Notes', $1, $2, $3, 'client', $4, true, true, NOW())
        RETURNING id
      `,
      [contactEmail, COMPANY_NAME, company.rows[0].id, "SMOKE TEST DELETE fixture contact for estimator notes smoke"]
    );
    const property = await client.query<{ id: string }>(
      `
        INSERT INTO ${schema}.properties (company_id, name, address, city, state, zip, notes, is_test_data, is_active, updated_at)
        VALUES ($1, $2, '501 Smoke Test Way', 'Dallas', 'TX', '75201', $3, true, true, NOW())
        RETURNING id
      `,
      [company.rows[0].id, PROPERTY_NAME, "SMOKE TEST DELETE fixture property for estimator notes smoke"]
    );

    const dealName = `${DEAL_PREFIX} ${suffix}`;
    const deal = await client.query<{ id: string }>(
      `
        INSERT INTO ${schema}.deals (
          deal_number,
          name,
          stage_id,
          assigned_rep_id,
          primary_contact_id,
          company_id,
          property_id,
          project_type_id,
          description,
          office_code,
          workflow_route,
          pipeline_disposition,
          is_test_data,
          is_active,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'normal', 'deals', true, true, NOW())
        RETURNING id
      `,
      [
        `SMK-NOTES-${suffix.slice(-12)}`,
        dealName,
        fallbackStage.id,
        smokeUser.id,
        contact.rows[0].id,
        company.rows[0].id,
        property.rows[0].id,
        projectType.rows[0]?.id ?? null,
        "SMOKE TEST DELETE - estimator notes typing smoke fixture",
        officeCodeFromSlug(smokeUser.office_slug),
      ]
    );

    await client.query("COMMIT");
    return {
      schemaName,
      dealId: deal.rows[0].id,
      dealName,
      companyId: company.rows[0].id,
      propertyId: property.rows[0].id,
      contactId: contact.rows[0].id,
      contactEmail,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  }
}

async function login(page: Page, options: Options) {
  await page.goto(options.origin, { waitUntil: "domcontentloaded" });
  if (await page.locator("#email").isVisible({ timeout: 10_000 }).catch(() => false)) {
    await page.locator("#email").fill(options.email);
    await page.locator("#password").fill(options.password);
    await page.locator("button[type='submit']").click();
    await page.waitForLoadState("networkidle").catch(() => undefined);
  }
}

async function typeRealistically(locator: Locator, text: string) {
  for (const char of text) {
    await locator.pressSequentially(char, { delay: 50 + Math.floor(Math.random() * 51) });
  }
}

async function assertTextareaValue(locator: Locator, expected: string, label: string) {
  const actual = await locator.inputValue();
  if (actual !== expected) {
    throw new Error(`${label} mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function run() {
  const options = readOptions();
  const client = new pg.Client({ connectionString: connectionString(), ssl: process.env.PGSSLMODE === "require" ? { rejectUnauthorized: false } : undefined });
  let fixture: SmokeFixture | null = null;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;

  try {
    await client.connect();
    fixture = await createSmokeFixture(client, options.email);
    console.info(`[smoke-estimator-notes] Created ${fixture.dealName} (${fixture.dealId}) in ${fixture.schemaName}`);

    browser = await chromium.launch({ headless: options.headless });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await login(page, options);
    await page.goto(`${options.origin.replace(/\/$/, "")}/deals/${fixture.dealId}?tab=scoping`, {
      waitUntil: "domcontentloaded",
    });

    const notes = page.locator("#estimatorConsultationNotes");
    await notes.waitFor({ state: "visible", timeout: 30_000 });
    await notes.fill("");

    const longText =
      "Estimator consultation smoke verifies that realistic typing across an autosave boundary keeps every character in place for live sales reps editing scope notes.";
    await notes.click();
    await typeRealistically(notes, longText);
    await page.waitForTimeout(1_500);
    await assertTextareaValue(notes, longText, "continuous typing");

    const pausedText = "this is a test sentence typed across a deliberate autosave pause";
    await notes.fill("");
    await notes.click();
    await typeRealistically(notes, "this is a te");
    await page.waitForTimeout(750);
    await typeRealistically(notes, "st sentence typed across a deliberate autosave pause");
    await page.waitForTimeout(1_800);
    await assertTextareaValue(notes, pausedText, "paused mid-word typing");
    await page.reload({ waitUntil: "domcontentloaded" });
    const reloadedNotes = page.locator("#estimatorConsultationNotes");
    await reloadedNotes.waitFor({ state: "visible", timeout: 30_000 });
    await assertTextareaValue(reloadedNotes, pausedText, "paused mid-word typing after reload");

    console.info("[smoke-estimator-notes] PASS: estimator notes retained all typed characters.");
  } finally {
    if (browser) await browser.close();
    if (fixture && !options.retain) {
      await cleanupSmokeRows(client, fixture.schemaName, fixture);
      console.info("[smoke-estimator-notes] Cleaned up SMOKE TEST DELETE fixture rows.");
    } else if (fixture) {
      console.info(`[smoke-estimator-notes] Retained fixture ${fixture.dealId} due to --retain.`);
    }
    await client.end().catch(() => undefined);
  }
}

run().catch((err) => {
  console.error("[smoke-estimator-notes] FAIL", err);
  process.exit(1);
});
