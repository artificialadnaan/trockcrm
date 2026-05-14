import pg from "pg";

type Mode = "run" | "cleanup";

const LEAD_PREFIX = "SMOKE TEST DELETE - Lead Form Batch";
const FIXTURE_COMPANY_NAME = `${LEAD_PREFIX} Company`;
const FIXTURE_PROPERTY_NAME = `${LEAD_PREFIX} Property`;
const FIXTURE_CONTACT_EMAIL = "smoke.lead.form.batch@example.invalid";

type Options = {
  mode: Mode;
  apiBaseUrl: string;
  origin: string;
  email: string;
  password: string;
  retain: boolean;
};

type Session = {
  cookies: string;
  csrf: string;
  user: {
    id: string;
    email: string;
    role: string;
    activeOfficeId?: string | null;
    officeId?: string | null;
  };
};

type Fixture = {
  schemaName: string;
  officeSlug: string;
  officeCode: "dfw" | "atl";
  companyId: string;
  propertyId: string;
  contactId: string;
  projectTypeId: string;
  projectTypeName: string;
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
    mode: hasFlag("--cleanup") ? "cleanup" : "run",
    apiBaseUrl:
      readArg("--api-base") ??
      process.env.SMOKE_API_BASE_URL ??
      process.env.API_BASE_URL ??
      "https://api-production-ad218.up.railway.app",
    origin:
      readArg("--origin") ??
      process.env.SMOKE_ORIGIN ??
      process.env.FRONTEND_URL ??
      "https://trockcrm.com",
    email: readArg("--email") ?? process.env.SMOKE_EMAIL ?? "test-sales@trock.test",
    password: readArg("--password") ?? process.env.SMOKE_PASSWORD ?? "TrockTest123!",
    retain: hasFlag("--retain"),
  };
}

function connectionString() {
  const selected = process.env.DATABASE_PUBLIC_URL?.trim() || process.env.DATABASE_URL?.trim();
  if (!selected) throw new Error("DATABASE_PUBLIC_URL or DATABASE_URL is required");
  if (!process.env.DATABASE_PUBLIC_URL && /railway\.internal/.test(selected)) {
    throw new Error("DATABASE_URL points at railway.internal; run with the Postgres service env or set DATABASE_PUBLIC_URL.");
  }
  return selected;
}

function assertSafeSchemaName(schemaName: string) {
  if (!/^office_[a-z0-9_]+$/.test(schemaName)) {
    throw new Error(`Unsafe tenant schema: ${schemaName}`);
  }
}

function qident(schemaName: string) {
  assertSafeSchemaName(schemaName);
  return `"${schemaName}"`;
}

function officeCodeFromSlug(slug: string): "dfw" | "atl" {
  if (slug === "dallas") return "dfw";
  if (slug === "atlanta") return "atl";
  throw new Error(`Unsupported office slug: ${slug}`);
}

function cookieHeaderFrom(setCookie: string[]) {
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
  url: string,
  init: RequestInit & { expectedStatus?: number | number[] } = {}
): Promise<{ status: number; headers: Headers; body: T }> {
  const response = await fetch(url, init);
  const expected = Array.isArray(init.expectedStatus)
    ? init.expectedStatus
    : [init.expectedStatus ?? 200];
  const text = await response.text();
  let body: T;
  try {
    body = text ? JSON.parse(text) as T : ({} as T);
  } catch {
    body = { raw: text } as T;
  }
  if (!expected.includes(response.status)) {
    throw new Error(`HTTP ${response.status} for ${url}: ${text.slice(0, 500)}`);
  }
  return { status: response.status, headers: response.headers, body };
}

async function login(options: Options): Promise<Session> {
  const response = await apiJson<{ user: Session["user"] }>(
    `${options.apiBaseUrl.replace(/\/$/, "")}/api/auth/local/login`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: options.email, password: options.password }),
      expectedStatus: 200,
    }
  );
  const cookies = cookieHeaderFrom(response.headers.getSetCookie?.() ?? []);
  const csrf = cookieValue(cookies, "csrf_token");
  if (!cookies.includes("token=") || !csrf) {
    throw new Error("Login succeeded but did not return token/csrf cookies");
  }
  return { user: response.body.user, cookies, csrf };
}

async function cleanupSmokeRows(client: pg.Client, schemaName: string) {
  const schema = qident(schemaName);
  const leads = await client.query<{ id: string }>(
    `SELECT id FROM ${schema}.leads WHERE name LIKE $1 OR description LIKE $1`,
    [`${LEAD_PREFIX}%`]
  );
  const leadIds = leads.rows.map((row) => row.id);

  await client.query("BEGIN");
  try {
    let deletedLeadCount = 0;
    if (leadIds.length > 0) {
      await client.query(`DELETE FROM ${schema}.lead_question_answer_history WHERE lead_id = ANY($1::uuid[])`, [leadIds]);
      await client.query(`DELETE FROM ${schema}.lead_question_answers WHERE lead_id = ANY($1::uuid[])`, [leadIds]);
      await client.query(`DELETE FROM ${schema}.lead_due_diligence_approvals WHERE lead_id = ANY($1::uuid[])`, [leadIds]);
      await client.query(`DELETE FROM ${schema}.lead_stage_history WHERE lead_id = ANY($1::uuid[])`, [leadIds]);
      await client.query(`DELETE FROM ${schema}.tasks WHERE lead_id = ANY($1::uuid[])`, [leadIds]);
      const deleted = await client.query(`DELETE FROM ${schema}.leads WHERE id = ANY($1::uuid[])`, [leadIds]);
      deletedLeadCount = deleted.rowCount ?? 0;
    }

    const deletedProperties = await client.query(
      `
        DELETE FROM ${schema}.properties
         WHERE name = $1
            OR notes LIKE $2
            OR address = '123 Smoke Test Way'
      `,
      [FIXTURE_PROPERTY_NAME, `${LEAD_PREFIX}%`]
    );
    const deletedContacts = await client.query(
      `
        DELETE FROM ${schema}.contacts
         WHERE lower(email) = lower($1)
            OR notes LIKE $2
      `,
      [FIXTURE_CONTACT_EMAIL, `${LEAD_PREFIX}%`]
    );
    const deletedCompanies = await client.query(
      `
        DELETE FROM ${schema}.companies
         WHERE slug = 'smoke-test-delete-lead-form-batch-company'
            OR name = $1
            OR notes LIKE $2
      `,
      [FIXTURE_COMPANY_NAME, `${LEAD_PREFIX}%`]
    );

    await client.query("COMMIT");
    return {
      deletedLeads: deletedLeadCount,
      deletedProperties: deletedProperties.rowCount ?? 0,
      deletedContacts: deletedContacts.rowCount ?? 0,
      deletedCompanies: deletedCompanies.rowCount ?? 0,
      leadIds,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

async function resolveSmokeTenant(client: pg.Client, email: string) {
  const user = await client.query<{ office_slug: string }>(
    `
      SELECT o.slug AS office_slug
        FROM public.users u
        JOIN public.offices o ON o.id = u.office_id
       WHERE lower(u.email) = lower($1)
       LIMIT 1
    `,
    [email]
  );
  const officeSlug = user.rows[0]?.office_slug;
  if (!officeSlug) throw new Error(`Unable to resolve office for ${email}`);

  const schemaName = `office_${officeSlug}`;
  return { officeSlug, schemaName, officeCode: officeCodeFromSlug(officeSlug) };
}

async function loadFixture(client: pg.Client, email: string): Promise<Fixture> {
  const { officeSlug, schemaName, officeCode } = await resolveSmokeTenant(client, email);
  const schema = qident(schemaName);

  await cleanupSmokeRows(client, schemaName);

  const projectType = await client.query<{ id: string; name: string }>(
    `
      SELECT id, name
        FROM public.project_type_config
       WHERE is_active = true
       ORDER BY code::int ASC NULLS LAST, display_order ASC, name ASC
       LIMIT 1
    `
  );
  if (!projectType.rows[0]) throw new Error("No active project type is configured");

  const company = await client.query<{ id: string }>(
    `
      INSERT INTO ${schema}.companies (name, slug, category, city, state, notes, is_test_data, is_active, updated_at)
      VALUES ($1, 'smoke-test-delete-lead-form-batch-company', 'client', 'Dallas', 'TX', $2, true, true, NOW())
      ON CONFLICT (slug) DO UPDATE SET
        name = EXCLUDED.name,
        notes = EXCLUDED.notes,
        is_test_data = true,
        is_active = true,
        updated_at = NOW()
      RETURNING id
    `,
    [FIXTURE_COMPANY_NAME, `${LEAD_PREFIX} fixture company`]
  );

  const existingContact = await client.query<{ id: string }>(
    `SELECT id FROM ${schema}.contacts WHERE lower(email) = lower($1) LIMIT 1`,
    [FIXTURE_CONTACT_EMAIL]
  );
  const contact = existingContact.rows[0]
    ? await client.query<{ id: string }>(
        `
          UPDATE ${schema}.contacts
             SET first_name = 'Smoke',
                 last_name = 'Lead Form',
                 company_name = $1,
                 company_id = $2,
                 category = 'client',
                 notes = $3,
                 is_test_data = true,
                 is_active = true,
                 updated_at = NOW()
           WHERE id = $4
           RETURNING id
        `,
        [FIXTURE_COMPANY_NAME, company.rows[0].id, `${LEAD_PREFIX} fixture contact`, existingContact.rows[0].id]
      )
    : await client.query<{ id: string }>(
        `
          INSERT INTO ${schema}.contacts (
            first_name, last_name, email, company_name, company_id, category, notes, is_test_data, is_active, updated_at
          )
          VALUES ('Smoke', 'Lead Form', $1, $2, $3, 'client', $4, true, true, NOW())
          RETURNING id
        `,
        [FIXTURE_CONTACT_EMAIL, FIXTURE_COMPANY_NAME, company.rows[0].id, `${LEAD_PREFIX} fixture contact`]
      );

  const existingProperty = await client.query<{ id: string }>(
    `SELECT id FROM ${schema}.properties WHERE company_id = $1 AND address = '123 Smoke Test Way' LIMIT 1`,
    [company.rows[0].id]
  );
  const property = existingProperty.rows[0]
    ? await client.query<{ id: string }>(
        `
          UPDATE ${schema}.properties
             SET name = $1,
                 city = 'Dallas',
                 state = 'TX',
                 zip = '75001',
                 build_year = 2001,
                 unit_count = 120,
                 notes = $2,
                 is_test_data = true,
                 is_active = true,
                 updated_at = NOW()
           WHERE id = $3
           RETURNING id
        `,
        [FIXTURE_PROPERTY_NAME, `${LEAD_PREFIX} fixture property`, existingProperty.rows[0].id]
      )
    : await client.query<{ id: string }>(
        `
          INSERT INTO ${schema}.properties (
            company_id, name, address, city, state, zip, build_year, unit_count, notes, is_test_data, is_active, updated_at
          )
          VALUES ($1, $2, '123 Smoke Test Way', 'Dallas', 'TX', '75001', 2001, 120, $3, true, true, NOW())
          RETURNING id
        `,
        [company.rows[0].id, FIXTURE_PROPERTY_NAME, `${LEAD_PREFIX} fixture property`]
      );

  return {
    schemaName,
    officeSlug,
    officeCode,
    companyId: company.rows[0].id,
    propertyId: property.rows[0].id,
    contactId: contact.rows[0].id,
    projectTypeId: projectType.rows[0].id,
    projectTypeName: projectType.rows[0].name,
  };
}

async function createSmokeLead(options: Options, session: Session, fixture: Fixture) {
  const leadName = `${LEAD_PREFIX} ${new Date().toISOString()}`;
  const response = await apiJson<{ lead: { id: string; name: string } }>(
    `${options.apiBaseUrl.replace(/\/$/, "")}/api/leads`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cookie": session.cookies,
        "origin": options.origin.replace(/\/$/, ""),
        "x-csrf-token": session.csrf,
      },
      body: JSON.stringify({
        companyId: fixture.companyId,
        propertyId: fixture.propertyId,
        primaryContactId: fixture.contactId,
        primaryContactRole: "regional_vp",
        name: leadName,
        assignedRepId: session.user.id,
        salesRepId: session.user.id,
        officeCode: fixture.officeCode,
        projectTypeId: fixture.projectTypeId,
        bidDueDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
        budgetStatus: "budgeted_q2",
        sourceCategory: "Referral",
        sourceDetail: "SMOKE TEST DELETE lead form batch",
        description: `${LEAD_PREFIX} verifies POC role, retained Estimated Value, placeholders, and Life Safety.`,
        qualificationPayload: {
          existing_customer_status: null,
          estimated_value: 50000,
          timeline_status: new Date(Date.now() + 21 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
        },
        leadQuestionAnswers: {
          life_safety: true,
        },
      }),
      expectedStatus: 201,
    }
  );
  return response.body.lead;
}

async function verifyPersistence(client: pg.Client, schemaName: string, leadId: string) {
  const schema = qident(schemaName);
  const result = await client.query(
    `
      WITH life_node AS (
        SELECT id FROM public.project_type_question_nodes WHERE key = 'life_safety' AND is_active = true LIMIT 1
      ),
      budget_node AS (
        SELECT id FROM public.project_type_question_nodes WHERE key = 'budget' AND is_active = true LIMIT 1
      )
      SELECT l.id,
             l.name,
             l.primary_contact_role,
             l.qualification_payload->>'estimated_value' AS estimated_value,
             (SELECT a.value_json FROM ${schema}.lead_question_answers a WHERE a.lead_id = l.id AND a.question_id = (SELECT id FROM life_node)) AS life_safety,
             EXISTS(SELECT 1 FROM ${schema}.lead_question_answers a WHERE a.lead_id = l.id AND a.question_id = (SELECT id FROM budget_node)) AS has_active_budget_answer
        FROM ${schema}.leads l
       WHERE l.id = $1
       LIMIT 1
    `,
    [leadId]
  );
  const row = result.rows[0];
  if (!row) throw new Error(`Smoke lead ${leadId} was not found`);
  if (row.primary_contact_role !== "regional_vp") throw new Error(`POC role did not persist: ${row.primary_contact_role}`);
  if (Number(row.estimated_value) !== 50000) throw new Error(`Estimated Value did not persist as 50000: ${row.estimated_value}`);
  if (row.life_safety !== true) throw new Error(`Life Safety did not persist as true: ${JSON.stringify(row.life_safety)}`);
  if (row.has_active_budget_answer) throw new Error("Smoke lead still wrote an active Budget questionnaire answer");
  return row;
}

async function verifyBudgetBackfill(client: pg.Client, schemaName: string) {
  const schema = qident(schemaName);
  const result = await client.query(
    `
      WITH budget_node AS (
        SELECT id FROM public.project_type_question_nodes WHERE key = 'budget'
      )
      SELECT COUNT(*)::int AS missing_estimated_from_budget
        FROM ${schema}.leads l
        JOIN ${schema}.lead_question_answers a ON a.lead_id = l.id
       WHERE a.question_id IN (SELECT id FROM budget_node)
         AND a.value_json IS NOT NULL
         AND a.value_json::text NOT IN ('null', '""')
         AND (
           l.qualification_payload->>'estimated_value' IS NULL
           OR btrim(l.qualification_payload->>'estimated_value') = ''
         )
    `
  );
  const missing = Number(result.rows[0]?.missing_estimated_from_budget ?? 0);
  if (missing > 0) {
    throw new Error(`Budget backfill is incomplete: ${missing} budget answers still lack Estimated Value`);
  }
  return { missingEstimatedFromBudget: missing };
}

async function main() {
  const options = readOptions();
  const client = new pg.Client({ connectionString: connectionString(), ssl: { rejectUnauthorized: false } });
  await client.connect();

  try {
    if (options.mode === "cleanup") {
      const tenant = await resolveSmokeTenant(client, options.email);
      console.log(JSON.stringify({ mode: options.mode, schemaName: tenant.schemaName, cleanup: await cleanupSmokeRows(client, tenant.schemaName) }, null, 2));
      return;
    }

    const fixture = await loadFixture(client, options.email);
    const session = await login(options);
    const lead = await createSmokeLead(options, session, fixture);
    const persistence = await verifyPersistence(client, fixture.schemaName, lead.id);
    const backfill = await verifyBudgetBackfill(client, fixture.schemaName);
    const cleanup = options.retain ? null : await cleanupSmokeRows(client, fixture.schemaName);

    console.log(JSON.stringify({
      mode: options.mode,
      schemaName: fixture.schemaName,
      fixture,
      lead,
      persistence,
      backfill,
      cleanup,
    }, null, 2));
  } finally {
    await client.end();
  }
}

if (process.argv[1]?.includes("smoke-lead-form-batch.ts")) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
