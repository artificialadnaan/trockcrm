import pg from "pg";
import { Resend } from "resend";

type SmokeMode = "run" | "cleanup" | "inspect-old";

const LEAD_PREFIX = "SMOKE TEST DELETE - DD Email";
const FIXTURE_COMPANY_NAME = `${LEAD_PREFIX} Company`;
const FIXTURE_PROPERTY_NAME = `${LEAD_PREFIX} Property`;
const FIXTURE_CONTACT_EMAIL = "smoke.dd.email@example.invalid";

type CliOptions = {
  mode: SmokeMode;
  apiBaseUrl: string;
  origin: string;
  email: string;
  password: string;
  allowRealRecipients: boolean;
  emailOverrideConfirmed: boolean;
  retain: boolean;
  pollMs: number;
  timeoutMs: number;
};

type SmokeFixture = {
  schemaName: string;
  officeSlug: string;
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

function readOptions(): CliOptions {
  const mode: SmokeMode = hasFlag("--cleanup")
    ? "cleanup"
    : hasFlag("--inspect-old")
      ? "inspect-old"
      : "run";

  return {
    mode,
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
    email: readArg("--email") ?? process.env.SMOKE_EMAIL ?? "test-sales@trock.test",
    password: readArg("--password") ?? process.env.SMOKE_PASSWORD ?? "TrockTest123!",
    allowRealRecipients: hasFlag("--allow-real-recipients"),
    retain: hasFlag("--retain"),
    emailOverrideConfirmed:
      hasFlag("--email-override-confirmed") ||
      process.env.SMOKE_EMAIL_OVERRIDE_CONFIRMED === "1",
    pollMs: Number(readArg("--poll-ms") ?? process.env.SMOKE_POLL_MS ?? 2_000),
    timeoutMs: Number(readArg("--timeout-ms") ?? process.env.SMOKE_TIMEOUT_MS ?? 90_000),
  };
}

function connectionString() {
  const selected = process.env.DATABASE_PUBLIC_URL?.trim() || process.env.DATABASE_URL?.trim();
  if (!selected) {
    throw new Error("DATABASE_PUBLIC_URL or DATABASE_URL is required");
  }
  if (!process.env.DATABASE_PUBLIC_URL && /railway\.internal/.test(selected)) {
    throw new Error("DATABASE_URL points at railway.internal; use DATABASE_PUBLIC_URL from the Postgres Railway service.");
  }
  return selected;
}

function assertSafeSchemaName(schemaName: string) {
  if (!/^office_[a-z0-9_]+$/.test(schemaName)) {
    throw new Error(`Unsafe office schema name: ${schemaName}`);
  }
}

function qident(value: string) {
  assertSafeSchemaName(value);
  return `"${value}"`;
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

function officeCodeFromSlug(slug: string) {
  if (slug === "dallas") return "dfw";
  if (slug === "atlanta") return "atl";
  throw new Error(`Unsupported smoke office slug: ${slug}`);
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

async function login(options: CliOptions) {
  const login = await apiJson<{ user: { id: string; email: string; role: string; activeOfficeId?: string | null } }>(
    `${options.apiBaseUrl.replace(/\/$/, "")}/api/auth/local/login`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: options.email, password: options.password }),
      expectedStatus: 200,
    }
  );
  const cookies = cookieHeaderFrom(login.headers.getSetCookie?.() ?? []);
  if (!cookies.includes("token=")) {
    throw new Error("Login succeeded but no token cookie was returned");
  }
  const csrf = cookieValue(cookies, "csrf_token");
  if (!csrf) {
    throw new Error("Login succeeded but no csrf_token cookie was returned");
  }
  return { user: login.body.user, cookies, csrf };
}

async function loadFixture(client: pg.Client, email: string): Promise<SmokeFixture> {
  const user = await client.query<{
    office_id: string;
    office_slug: string;
  }>(
    `
      SELECT u.office_id, o.slug AS office_slug
        FROM public.users u
        JOIN public.offices o ON o.id = u.office_id
       WHERE lower(u.email) = lower($1)
       LIMIT 1
    `,
    [email]
  );
  const officeSlug = user.rows[0]?.office_slug;
  if (!officeSlug) {
    throw new Error(`Unable to resolve office slug for ${email}`);
  }
  const schemaName = `office_${officeSlug}`;
  assertSafeSchemaName(schemaName);
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
  if (!projectType.rows[0]) {
    throw new Error("No active project type is configured");
  }

  const company = await client.query<{ id: string }>(
    `
      INSERT INTO ${schema}.companies (name, slug, category, city, state, notes, is_test_data, is_active, updated_at)
      VALUES ($1, 'smoke-test-delete-dd-email-company', 'client', 'Dallas', 'TX', $2, true, true, NOW())
      ON CONFLICT (slug) DO UPDATE SET
        name = EXCLUDED.name,
        notes = EXCLUDED.notes,
        is_test_data = true,
        is_active = true,
        updated_at = NOW()
      RETURNING id
    `,
    [FIXTURE_COMPANY_NAME, "SMOKE TEST DELETE fixture for DD email smoke"]
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
                 last_name = 'DD Email',
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
        [FIXTURE_COMPANY_NAME, company.rows[0].id, "SMOKE TEST DELETE fixture contact for DD email smoke", existingContact.rows[0].id]
      )
    : await client.query<{ id: string }>(
        `
          INSERT INTO ${schema}.contacts (first_name, last_name, email, company_name, company_id, category, notes, is_test_data, is_active, updated_at)
          VALUES ('Smoke', 'DD Email', $1, $2, $3, 'client', $4, true, true, NOW())
          RETURNING id
        `,
        [FIXTURE_CONTACT_EMAIL, FIXTURE_COMPANY_NAME, company.rows[0].id, "SMOKE TEST DELETE fixture contact for DD email smoke"]
      );

  const property = await client.query<{ id: string }>(
    `
      INSERT INTO ${schema}.properties (company_id, name, address, city, state, zip, build_year, unit_count, notes, is_test_data, is_active, updated_at)
      VALUES ($1, $2, '501 Smoke Test Way', 'Dallas', 'TX', '75201', 2001, 120, $3, true, true, NOW())
      RETURNING id
    `,
    [company.rows[0].id, FIXTURE_PROPERTY_NAME, "SMOKE TEST DELETE fixture property for DD email smoke"]
  );

  return {
    schemaName,
    officeSlug,
    companyId: company.rows[0].id,
    propertyId: property.rows[0].id,
    contactId: contact.rows[0].id,
    projectTypeId: projectType.rows[0].id,
    projectTypeName: projectType.rows[0].name,
  };
}

async function cleanupSmokeRows(client: pg.Client, schemaName: string) {
  const schema = qident(schemaName);
  await client.query("BEGIN");
  try {
    const leadIds = await client.query<{ id: string }>(
      `SELECT id FROM ${schema}.leads WHERE name ILIKE $1`,
      [`${LEAD_PREFIX}%`]
    );
    const ids = leadIds.rows.map((row) => row.id);
    if (ids.length) {
      await client.query(`DELETE FROM ${schema}.lead_question_answer_history WHERE lead_id = ANY($1::uuid[])`, [ids]);
      await client.query(`DELETE FROM ${schema}.lead_question_answers WHERE lead_id = ANY($1::uuid[])`, [ids]);
      await client.query(`DELETE FROM ${schema}.lead_stage_history WHERE lead_id = ANY($1::uuid[])`, [ids]);
      await client.query(`DELETE FROM ${schema}.lead_due_diligence_approvals WHERE lead_id = ANY($1::uuid[])`, [ids]);
      await client.query(`DELETE FROM ${schema}.activities WHERE lead_id = ANY($1::uuid[])`, [ids]);
      await client.query(
        `
          DELETE FROM ${schema}.tasks
           WHERE title = 'New Lead Assignment'
             AND entity_snapshot ->> 'leadId' = ANY($1::text[])
        `,
        [ids]
      );
      await client.query(`DELETE FROM ${schema}.leads WHERE id = ANY($1::uuid[])`, [ids]);
    }

    await client.query(
      `
        DELETE FROM ${schema}.properties
         WHERE name = $1
           AND is_test_data = true
           AND NOT EXISTS (SELECT 1 FROM ${schema}.leads l WHERE l.property_id = properties.id)
           AND NOT EXISTS (SELECT 1 FROM ${schema}.deals d WHERE d.property_id = properties.id)
      `,
      [FIXTURE_PROPERTY_NAME]
    );
    await client.query(
      `DELETE FROM ${schema}.contacts WHERE email = $1 AND is_test_data = true`,
      [FIXTURE_CONTACT_EMAIL]
    );
    await client.query(
      `
        DELETE FROM ${schema}.companies
         WHERE slug = 'smoke-test-delete-dd-email-company'
           AND is_test_data = true
           AND NOT EXISTS (SELECT 1 FROM ${schema}.properties p WHERE p.company_id = companies.id)
           AND NOT EXISTS (SELECT 1 FROM ${schema}.leads l WHERE l.company_id = companies.id)
           AND NOT EXISTS (SELECT 1 FROM ${schema}.deals d WHERE d.company_id = companies.id)
      `
    );
    await client.query("COMMIT");
    return { deletedLeadCount: ids.length };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

async function createLeadViaApi(options: CliOptions, session: Awaited<ReturnType<typeof login>>, fixture: SmokeFixture) {
  const leadName = `${LEAD_PREFIX} ${new Date().toISOString()}`;
  const bidDueDate = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const result = await apiJson<{ lead: { id: string; name: string; verificationStatus?: string } }>(
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
        primaryContactRole: "property_manager",
        name: leadName,
        officeCode: officeCodeFromSlug(fixture.officeSlug),
        projectTypeId: fixture.projectTypeId,
        bidDueDate,
        budgetStatus: "budgeted_q2",
        sourceCategory: "Referral",
        sourceDetail: "SMOKE TEST DELETE DD email flow",
        description: "SMOKE TEST DELETE - verifies live DD email dispatch path",
      }),
      expectedStatus: 201,
    }
  );
  return result.body.lead;
}

async function pollApproval(client: pg.Client, schemaName: string, leadId: string, timeoutMs: number, pollMs: number) {
  const schema = qident(schemaName);
  const deadline = Date.now() + timeoutMs;
  let last: Record<string, unknown> | null = null;
  while (Date.now() < deadline) {
    const approval = await client.query(
      `
        SELECT a.id, a.lead_id, a.status, a.email_sent_at, a.email_message_id, a.requested_at,
               a.approval_token,
               l.name AS lead_name,
               ARRAY(
                 SELECT u.email
                   FROM public.notification_recipient_groups g
                   JOIN public.notification_recipient_assignments nra ON nra.group_id = g.id
                   JOIN public.users u ON u.id = nra.user_id
                  WHERE g.key = 'lead_due_diligence'
                  ORDER BY u.email
               ) AS recipients
          FROM ${schema}.lead_due_diligence_approvals a
          JOIN ${schema}.leads l ON l.id = a.lead_id
         WHERE a.lead_id = $1
         LIMIT 1
      `,
      [leadId]
    );
    last = approval.rows[0] ?? null;
    if (last?.email_sent_at) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`Timed out waiting for DD approval email_sent_at. Last approval state: ${JSON.stringify(last)}`);
}

function publicDueDiligenceUrl(options: CliOptions, token: string) {
  return `${options.apiBaseUrl.replace(/\/$/, "")}/api/public/lead-due-diligence/${encodeURIComponent(token)}`;
}

function extractDueDiligenceHrefFromEmail(email: unknown) {
  const serialized = JSON.stringify(email ?? {});
  const unescaped = serialized.replace(/\\u0026/g, "&").replace(/&amp;/g, "&");
  const quotedUrl = unescaped.match(/https?:\/\/[^"\\\s<>]+\/api\/public\/lead-due-diligence\/[a-f0-9]{64}/i)?.[0];
  if (quotedUrl) return quotedUrl;
  const queryUrl = unescaped.match(/https?:\/\/[^"\\\s<>]+\/api\/public\/lead-due-diligence\?token=[a-f0-9]{64}/i)?.[0];
  if (queryUrl) return queryUrl;
  const relativePath = unescaped.match(/\/api\/public\/lead-due-diligence\/[a-f0-9]{64}/i)?.[0];
  return relativePath ?? null;
}

async function validatePublicDueDiligenceLink(
  options: CliOptions,
  approval: Record<string, unknown>,
  resend: Record<string, unknown> | null
) {
  const token = typeof approval.approval_token === "string" ? approval.approval_token : "";
  if (!/^[a-f0-9]{64}$/i.test(token)) {
    throw new Error(`DD approval ${String(approval.id)} has an invalid approval_token shape`);
  }

  const resendEmail = resend?.checked === true ? resend.email : null;
  const emailHref = extractDueDiligenceHrefFromEmail(resendEmail);
  if (resendEmail && !emailHref) {
    throw new Error(`Resend message ${String(approval.email_message_id)} did not contain a DD public review href`);
  }
  const url = emailHref
    ? new URL(emailHref, options.apiBaseUrl.replace(/\/$/, "")).toString()
    : publicDueDiligenceUrl(options, token);
  if (emailHref && !url.includes(token)) {
    throw new Error(`DD email href did not contain the persisted approval token for ${String(approval.id)}`);
  }

  const response = await fetch(url);
  const html = await response.text();
  if (response.status !== 200) {
    throw new Error(`DD public review link returned HTTP ${response.status}: ${html.slice(0, 300)}`);
  }
  if (!html.includes("T Rock Construction") || !html.includes("Lead Due Diligence") || !html.includes(String(approval.lead_name))) {
    throw new Error(`DD public review link did not render the expected approval page: ${html.slice(0, 300)}`);
  }

  return {
    url,
    status: response.status,
    renderedDecisionPage: true,
    source: emailHref ? "resend_email_href" : "db_token_fallback",
  };
}

async function verifyResend(messageId: unknown) {
  if (!messageId || typeof messageId !== "string") {
    return { checked: false, reason: "approval has no email_message_id" };
  }
  if (!process.env.RESEND_API_KEY) {
    return { checked: false, reason: "RESEND_API_KEY is not available to the smoke process" };
  }
  const resend = new Resend(process.env.RESEND_API_KEY);
  const result = await resend.emails.get(messageId);
  if (result.error) {
    return { checked: false, reason: result.error.message ?? String(result.error) };
  }
  return { checked: true, email: result.data };
}

function verifyRailwayApiEmailOverride(options: CliOptions) {
  const apiHost = new URL(options.apiBaseUrl).hostname;
  const railwayPublicDomain = process.env.RAILWAY_PUBLIC_DOMAIN?.trim() ?? "";
  const railwayServiceUrl = process.env.RAILWAY_SERVICE_API_URL?.trim() ?? "";
  const runningApiService =
    process.env.RAILWAY_ENVIRONMENT_NAME === "production" &&
    process.env.RAILWAY_SERVICE_NAME === "API" &&
    (apiHost === railwayPublicDomain || apiHost === railwayServiceUrl || apiHost === "api-production-ad218.up.railway.app");

  if (!runningApiService) {
    throw new Error(
      "Refusing live DD smoke: run the script with Railway API service env (`railway run --service API --environment production ...`) so EMAIL_OVERRIDE_RECIPIENT is read from the deployed API service configuration."
    );
  }

  const overrideRecipient = process.env.EMAIL_OVERRIDE_RECIPIENT?.trim();
  if (!overrideRecipient) {
    throw new Error("Refusing live DD smoke: Railway API service env does not include EMAIL_OVERRIDE_RECIPIENT.");
  }

  return {
    checked: true,
    source: "railway API service environment",
    overrideRecipient,
  };
}

async function inspectOldRows(client: pg.Client) {
  const schemas = await client.query<{ table_schema: string }>(
    `
      SELECT table_schema
        FROM information_schema.tables
       WHERE table_name = 'lead_due_diligence_approvals'
         AND table_schema LIKE 'office_%'
       ORDER BY table_schema
    `
  );
  const results = [];
  for (const row of schemas.rows) {
    const schema = qident(row.table_schema);
    const unsent = await client.query(
      `
        SELECT $1::text AS schema_name, a.id, a.lead_id, a.status, a.requested_at,
               a.email_sent_at, a.email_message_id, l.name AS lead_name
          FROM ${schema}.lead_due_diligence_approvals a
          JOIN ${schema}.leads l ON l.id = a.lead_id
         WHERE a.email_sent_at IS NULL
         ORDER BY a.requested_at DESC
      `,
      [row.table_schema]
    );
    results.push(...unsent.rows);
  }
  return results;
}

async function main() {
  const options = readOptions();
  const client = new pg.Client({ connectionString: connectionString() });
  await client.connect();
  try {
    if (options.mode === "inspect-old") {
      console.log(JSON.stringify({ mode: options.mode, oldRows: await inspectOldRows(client) }, null, 2));
      return;
    }

    const userOffice = await client.query<{ office_slug: string }>(
      `
        SELECT o.slug AS office_slug
          FROM public.users u
          JOIN public.offices o ON o.id = u.office_id
         WHERE lower(u.email) = lower($1)
         LIMIT 1
      `,
      [options.email]
    );
    const officeSlug = userOffice.rows[0]?.office_slug;
    if (!officeSlug) {
      throw new Error(`Unable to resolve office slug for ${options.email}`);
    }
    const schemaName = `office_${officeSlug}`;
    assertSafeSchemaName(schemaName);

    if (options.mode === "cleanup") {
      console.log(JSON.stringify({ mode: options.mode, schemaName, cleanup: await cleanupSmokeRows(client, schemaName) }, null, 2));
      return;
    }

  if (!options.allowRealRecipients && !options.emailOverrideConfirmed) {
      throw new Error(
        "Refusing to create a live DD lead because EMAIL_OVERRIDE_RECIPIENT was not confirmed. Set the production API variable, then rerun with --email-override-confirmed."
      );
    }
    const session = await login(options);
    const remoteEmailOverride = options.allowRealRecipients
      ? { checked: false, reason: "real recipients explicitly allowed" }
      : verifyRailwayApiEmailOverride(options);
    const fixture = await loadFixture(client, options.email);
    let cleanup: Awaited<ReturnType<typeof cleanupSmokeRows>> | null = null;
    let lead: Awaited<ReturnType<typeof createLeadViaApi>> | null = null;
    let approval: Record<string, unknown> | null = null;
    let publicLink: Awaited<ReturnType<typeof validatePublicDueDiligenceLink>> | null = null;
    let resend: Record<string, unknown> | null = null;
    try {
      lead = await createLeadViaApi(options, session, fixture);
      approval = await pollApproval(client, fixture.schemaName, lead.id, options.timeoutMs, options.pollMs);
      resend = await verifyResend(approval.email_message_id);
      publicLink = await validatePublicDueDiligenceLink(options, approval, resend);
    } finally {
      if (!options.retain) {
        cleanup = await cleanupSmokeRows(client, fixture.schemaName);
      }
    }

    console.log(JSON.stringify({
      mode: options.mode,
      apiBaseUrl: options.apiBaseUrl,
      origin: options.origin,
      user: session.user,
      fixture,
      lead,
      approval,
      publicLink,
      resend,
      remoteEmailOverride,
      cleanup,
      retained: options.retain,
      emailOverrideConfirmed: options.emailOverrideConfirmed,
      allowRealRecipients: options.allowRealRecipients,
    }, null, 2));
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
