import { randomUUID } from "node:crypto";
import pg from "pg";

type FileCategory = "other" | "photo" | "contract" | "invoice" | "estimate" | "permit";

const LEAD_PREFIX = "SMOKE TEST DELETE - File Attachments";
const FIXTURE_COMPANY_SLUG = "smoke-test-delete-file-attachments-company";
const FIXTURE_CONTACT_EMAIL = "smoke.file.attachments@example.invalid";
const CLIENT_PROVIDED_DOCS_TAG = "client_provided_docs";

type CliOptions = {
  apiBaseUrl: string;
  origin: string;
  email: string;
  password: string;
  retain: boolean;
  skipBrowser: boolean;
};

type Session = {
  cookies: string;
  csrf: string;
  user: { id: string; email: string; role: string; activeOfficeId?: string | null; officeId?: string | null };
};

type Fixture = {
  schemaName: string;
  officeSlug: string;
  officeCode: string;
  userId: string;
  officeId: string | null;
  projectTypeId: string;
  projectTypeName: string;
  salesValidationStageId: string;
  opportunityStageId: string;
  companyId: string;
  propertyId: string;
  contactId: string;
  leadId: string;
  emailId: string;
};

type UploadedFile = {
  id: string;
  originalFilename: string;
  mimeType: string;
  fileSizeBytes: number;
  category: FileCategory;
  leadId: string | null;
  dealId: string | null;
  intakeRequirementKey: string | null;
};

type ApiFileList = {
  files: UploadedFile[];
  pagination?: { total?: number };
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
    email: readArg("--email") ?? process.env.SMOKE_EMAIL ?? "test-sales@trock.test",
    password: readArg("--password") ?? process.env.SMOKE_PASSWORD ?? "TrockTest123!",
    retain: hasFlag("--retain"),
    skipBrowser: hasFlag("--skip-browser") || process.env.SMOKE_SKIP_BROWSER === "1",
  };
}

function connectionString() {
  const selected = process.env.DATABASE_PUBLIC_URL?.trim() || process.env.DATABASE_URL?.trim();
  if (!selected) throw new Error("DATABASE_PUBLIC_URL or DATABASE_URL is required for smoke setup/cleanup.");
  if (!process.env.DATABASE_PUBLIC_URL && /railway\.internal/.test(selected)) {
    throw new Error("DATABASE_URL points at railway.internal; use DATABASE_PUBLIC_URL from the Postgres Railway service.");
  }
  return selected;
}

function assertSafeSchemaName(schemaName: string) {
  if (!/^office_[a-z0-9_]+$/.test(schemaName)) throw new Error(`Unsafe office schema name: ${schemaName}`);
}

function qident(value: string) {
  assertSafeSchemaName(value);
  return `"${value}"`;
}

function officeCodeFromSlug(slug: string) {
  if (slug === "dallas") return "dfw";
  if (slug === "atlanta") return "atl";
  return slug.slice(0, 3).toLowerCase();
}

function baseApi(options: CliOptions) {
  return options.apiBaseUrl.replace(/\/$/, "");
}

function baseOrigin(options: CliOptions) {
  return options.origin.replace(/\/$/, "");
}

function setCookieValues(headers: Headers) {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.();
  if (getSetCookie?.length) return getSetCookie;
  const single = headers.get("set-cookie");
  return single ? [single] : [];
}

function cookieHeaderFrom(headers: Headers) {
  return setCookieValues(headers).map((entry) => entry.split(";")[0]).join("; ");
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
  const expected = Array.isArray(init.expectedStatus) ? init.expectedStatus : [init.expectedStatus ?? 200];
  const text = await response.text();
  let body: T;
  try {
    body = text ? JSON.parse(text) as T : ({} as T);
  } catch {
    body = { raw: text } as T;
  }
  if (!expected.includes(response.status)) {
    throw new Error(`HTTP ${response.status} for ${url}: ${text.slice(0, 800)}`);
  }
  return { status: response.status, headers: response.headers, body };
}

function authHeaders(options: CliOptions, session: Session, extra: Record<string, string> = {}) {
  return {
    cookie: session.cookies,
    origin: baseOrigin(options),
    "x-csrf-token": session.csrf,
    ...extra,
  };
}

async function login(options: CliOptions): Promise<Session> {
  const result = await apiJson<{ user: Session["user"] }>(`${baseApi(options)}/api/auth/local/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseOrigin(options) },
    body: JSON.stringify({ email: options.email, password: options.password }),
    expectedStatus: 200,
  });
  const cookies = cookieHeaderFrom(result.headers);
  if (!cookies.includes("token=")) throw new Error("Login succeeded but no token cookie was returned.");
  const csrf = cookieValue(cookies, "csrf_token");
  if (!csrf) throw new Error("Login succeeded but no csrf_token cookie was returned.");
  return { cookies, csrf, user: result.body.user };
}

async function cleanupSmokeRows(client: pg.Client, schemaName: string) {
  const schema = qident(schemaName);
  await client.query("BEGIN");
  try {
    const leadIds = (await client.query<{ id: string }>(
      `SELECT id FROM ${schema}.leads WHERE name ILIKE $1`,
      [`${LEAD_PREFIX}%`]
    )).rows.map((row) => row.id);
    const dealIds = (await client.query<{ id: string }>(
      `SELECT id FROM ${schema}.deals WHERE name ILIKE $1 OR source_lead_id = ANY($2::uuid[])`,
      [`${LEAD_PREFIX}%`, leadIds]
    )).rows.map((row) => row.id);
    const fileRows = (await client.query<{ id: string; r2_key: string }>(
      `
        SELECT id, r2_key
          FROM ${schema}.files
         WHERE original_filename ILIKE 'smoke-attachment-%'
            OR display_name ILIKE 'smoke-attachment-%'
            OR lead_id = ANY($1::uuid[])
            OR deal_id = ANY($2::uuid[])
      `,
      [leadIds, dealIds]
    )).rows;
    const fileIds = fileRows.map((row) => row.id);

    if (fileIds.length) {
      await client.query(`DELETE FROM ${schema}.user_starred_files WHERE file_id = ANY($1::uuid[])`, [fileIds]);
      await client.query(`DELETE FROM ${schema}.file_links WHERE file_id = ANY($1::uuid[])`, [fileIds]);
      await client.query(`DELETE FROM ${schema}.photo_audit_log WHERE photo_id = ANY($1::uuid[])`, [fileIds]);
      await client.query(`DELETE FROM ${schema}.files WHERE id = ANY($1::uuid[])`, [fileIds]);
    }

    if (dealIds.length) {
      await client.query(`DELETE FROM ${schema}.deal_history WHERE deal_id = ANY($1::uuid[])`, [dealIds]);
      await client.query(`DELETE FROM ${schema}.deal_stage_history WHERE deal_id = ANY($1::uuid[])`, [dealIds]);
      await client.query(`DELETE FROM ${schema}.deal_team_members WHERE deal_id = ANY($1::uuid[])`, [dealIds]);
      await client.query(`DELETE FROM ${schema}.deal_approvals WHERE deal_id = ANY($1::uuid[])`, [dealIds]);
      await client.query(`DELETE FROM ${schema}.activities WHERE deal_id = ANY($1::uuid[])`, [dealIds]);
      await client.query(`DELETE FROM ${schema}.tasks WHERE deal_id = ANY($1::uuid[]) OR entity_snapshot ->> 'dealId' = ANY($2::text[])`, [dealIds, dealIds]);
      await client.query(`DELETE FROM ${schema}.audit_log WHERE record_id = ANY($1::uuid[])`, [dealIds]);
      await client.query(`DELETE FROM ${schema}.deals WHERE id = ANY($1::uuid[])`, [dealIds]);
    }

    if (leadIds.length) {
      await client.query(`DELETE FROM ${schema}.email_links WHERE entity_type = 'lead' AND entity_id = ANY($1::uuid[])`, [leadIds]);
      await client.query(`DELETE FROM ${schema}.emails WHERE assigned_entity_type = 'lead' AND assigned_entity_id = ANY($1::uuid[])`, [leadIds]);
      await client.query(`DELETE FROM ${schema}.lead_question_answer_history WHERE lead_id = ANY($1::uuid[])`, [leadIds]);
      await client.query(`DELETE FROM ${schema}.lead_question_answers WHERE lead_id = ANY($1::uuid[])`, [leadIds]);
      await client.query(`DELETE FROM ${schema}.lead_stage_history WHERE lead_id = ANY($1::uuid[])`, [leadIds]);
      await client.query(`DELETE FROM ${schema}.lead_due_diligence_approvals WHERE lead_id = ANY($1::uuid[])`, [leadIds]);
      await client.query(`DELETE FROM ${schema}.lead_scoping_intake WHERE lead_id = ANY($1::uuid[])`, [leadIds]);
      await client.query(`DELETE FROM ${schema}.activities WHERE lead_id = ANY($1::uuid[])`, [leadIds]);
      await client.query(`DELETE FROM ${schema}.tasks WHERE entity_snapshot ->> 'leadId' = ANY($1::text[])`, [leadIds]);
      await client.query(`DELETE FROM ${schema}.audit_log WHERE record_id = ANY($1::uuid[])`, [leadIds]);
      await client.query(`DELETE FROM ${schema}.leads WHERE id = ANY($1::uuid[])`, [leadIds]);
    }

    await client.query(`DELETE FROM ${schema}.contacts WHERE email = $1 AND is_test_data = true`, [FIXTURE_CONTACT_EMAIL]);
    await client.query(
      `
        DELETE FROM ${schema}.properties
         WHERE name ILIKE $1
           AND is_test_data = true
           AND NOT EXISTS (SELECT 1 FROM ${schema}.leads l WHERE l.property_id = properties.id)
           AND NOT EXISTS (SELECT 1 FROM ${schema}.deals d WHERE d.property_id = properties.id)
      `,
      [`${LEAD_PREFIX}%`]
    );
    await client.query(
      `
        DELETE FROM ${schema}.companies
         WHERE slug = $1
           AND is_test_data = true
           AND NOT EXISTS (SELECT 1 FROM ${schema}.properties p WHERE p.company_id = companies.id)
           AND NOT EXISTS (SELECT 1 FROM ${schema}.contacts c WHERE c.company_id = companies.id)
           AND NOT EXISTS (SELECT 1 FROM ${schema}.leads l WHERE l.company_id = companies.id)
           AND NOT EXISTS (SELECT 1 FROM ${schema}.deals d WHERE d.company_id = companies.id)
      `,
      [FIXTURE_COMPANY_SLUG]
    );

    await client.query("COMMIT");
    return { deletedLeadCount: leadIds.length, deletedDealCount: dealIds.length, deletedFileCount: fileIds.length, r2Keys: fileRows.map((row) => row.r2_key) };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

async function loadFixture(client: pg.Client, options: CliOptions, session: Session): Promise<Fixture> {
  const user = await client.query<{ id: string; office_id: string | null; office_slug: string }>(
    `
      SELECT u.id, u.office_id, o.slug AS office_slug
        FROM public.users u
        JOIN public.offices o ON o.id = u.office_id
       WHERE lower(u.email) = lower($1)
       LIMIT 1
    `,
    [options.email]
  );
  const userRow = user.rows[0];
  if (!userRow?.office_slug) throw new Error(`Unable to resolve office slug for ${options.email}`);
  const schemaName = `office_${userRow.office_slug}`;
  const schema = qident(schemaName);
  const officeCode = officeCodeFromSlug(userRow.office_slug);

  await cleanupSmokeRows(client, schemaName);

  const stages = await client.query<{ id: string; slug: string }>(
    `
      SELECT id, slug
        FROM public.pipeline_stage_config
       WHERE slug IN ('sales_validation_stage', 'opportunity')
         AND workflow_family IN ('lead', 'standard_deal')
    `
  );
  const salesValidationStageId = stages.rows.find((row) => row.slug === "sales_validation_stage")?.id;
  const opportunityStageId = stages.rows.find((row) => row.slug === "opportunity")?.id;
  if (!salesValidationStageId || !opportunityStageId) throw new Error("Missing canonical sales validation or opportunity stage config.");

  const projectType = (await client.query<{ id: string; name: string }>(
    `
      SELECT id, name
        FROM public.project_type_config
       WHERE is_active = true
       ORDER BY code::int ASC NULLS LAST, display_order ASC, name ASC
       LIMIT 1
    `
  )).rows[0];
  if (!projectType) throw new Error("No active project type is configured.");

  const companyId = randomUUID();
  const propertyId = randomUUID();
  const contactId = randomUUID();
  const leadId = randomUUID();
  const emailId = randomUUID();
  const now = new Date();
  const leadName = `${LEAD_PREFIX} ${now.toISOString()}`;

  await client.query("BEGIN");
  try {
    await client.query(
      `
        INSERT INTO ${schema}.companies (id, name, slug, category, city, state, notes, is_test_data, is_active, created_at, updated_at)
        VALUES ($1, $2, $3, 'client', 'Dallas', 'TX', $4, true, true, NOW(), NOW())
      `,
      [companyId, `${LEAD_PREFIX} Company`, FIXTURE_COMPANY_SLUG, "SMOKE TEST DELETE fixture for file attachment smoke"]
    );
    await client.query(
      `
        INSERT INTO ${schema}.properties (id, company_id, name, address, city, state, zip, build_year, unit_count, notes, is_test_data, is_active, created_at, updated_at)
        VALUES ($1, $2, $3, '502 Smoke Test Way', 'Dallas', 'TX', '75201', 2001, 120, $4, true, true, NOW(), NOW())
      `,
      [propertyId, companyId, `${LEAD_PREFIX} Property`, "SMOKE TEST DELETE fixture property for file attachment smoke"]
    );
    await client.query(
      `
        INSERT INTO ${schema}.contacts (id, first_name, last_name, email, company_name, company_id, category, notes, is_test_data, is_active, created_at, updated_at)
        VALUES ($1, 'Smoke', 'Files', $2, $3, $4, 'client', $5, true, true, NOW(), NOW())
      `,
      [contactId, FIXTURE_CONTACT_EMAIL, `${LEAD_PREFIX} Company`, companyId, "SMOKE TEST DELETE fixture contact for file attachment smoke"]
    );
    await client.query(
      `
        INSERT INTO ${schema}.leads (
          id, company_id, property_id, primary_contact_id, primary_contact_role, name,
          stage_id, assigned_rep_id, status, source_category, source_detail, description,
          office_code, office, project_type, project_type_id, bid_due_date, budget_status,
          qualification_payload, project_type_question_payload, verification_status,
          stage_entered_at, is_test_data, is_active, created_at, updated_at
        )
        VALUES (
          $1, $2, $3, $4, 'property_manager', $5,
          $6, $7, 'open', 'Referral', 'SMOKE TEST DELETE file attachment flow', $8,
          $9::text, $9::${schema}.lead_office, lower($10), $11, (CURRENT_DATE + INTERVAL '14 days')::date, 'budgeted_q2',
          $12::jsonb, $13::jsonb, 'not_required',
          NOW(), true, true, NOW(), NOW()
        )
      `,
      [
        leadId,
        companyId,
        propertyId,
        contactId,
        leadName,
        salesValidationStageId,
        userRow.id,
        "SMOKE TEST DELETE - verifies lead/deal file attachment conversion flow",
        officeCode,
        projectType.name,
        projectType.id,
        JSON.stringify({ estimated_value: 125000, timeline_status: "ready_for_bid" }),
        JSON.stringify({ projectTypeId: projectType.id, answers: {} }),
      ]
    );

    const requiredNodes = await client.query<{ id: string; key: string; input_type: string | null }>(
      `
        SELECT id, key, input_type
          FROM public.project_type_question_nodes
         WHERE is_active = true
           AND project_type_id IS NULL
           AND node_type = 'question'
           AND is_required = true
      `
    );
    for (const node of requiredNodes.rows) {
      if (node.key === CLIENT_PROVIDED_DOCS_TAG) {
        continue;
      }
      const value = node.input_type === "multiselect" ? ["smoke"] : "smoke";
      await client.query(
        `
          INSERT INTO ${schema}.lead_question_answers (lead_id, question_id, value_json, updated_by, created_at, updated_at)
          VALUES ($1, $2, $3::jsonb, $4, NOW(), NOW())
          ON CONFLICT (lead_id, question_id) DO UPDATE SET
            value_json = EXCLUDED.value_json,
            updated_by = EXCLUDED.updated_by,
            updated_at = NOW()
        `,
        [leadId, node.id, JSON.stringify(value), userRow.id]
      );
    }

    await client.query(
      `
        INSERT INTO ${schema}.emails (
          id, graph_message_id, graph_conversation_id, direction, from_address, to_addresses,
          subject, body_preview, body_html, has_attachments, contact_id, assigned_entity_type,
          assigned_entity_id, assignment_confidence, user_id, sent_at, synced_at
        )
        VALUES (
          $1, $2, $3, 'inbound', 'customer@example.invalid', ARRAY[$4]::text[],
          $5, 'SMOKE TEST DELETE lead email correspondence', '<p>SMOKE TEST DELETE lead email correspondence</p>',
          false, $6, 'lead', $7, 'exact', $8, NOW(), NOW()
        )
      `,
      [
        emailId,
        `smoke-file-attachments-${leadId}`,
        `smoke-file-attachments-thread-${leadId}`,
        session.user.email,
        `${LEAD_PREFIX} Email`,
        contactId,
        leadId,
        userRow.id,
      ]
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }

  return {
    schemaName,
    officeSlug: userRow.office_slug,
    officeCode,
    userId: userRow.id,
    officeId: userRow.office_id,
    projectTypeId: projectType.id,
    projectTypeName: projectType.name,
    salesValidationStageId,
    opportunityStageId,
    companyId,
    propertyId,
    contactId,
    leadId,
    emailId,
  };
}

const smokeFiles = {
  pdf: {
    filename: "smoke-attachment-client-doc.pdf",
    mimeType: "application/pdf",
    bytes: Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n"),
  },
  jpg: {
    filename: "smoke-attachment-site-photo.jpg",
    mimeType: "image/jpeg",
    bytes: Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0x00, 0xff, 0xd9]),
  },
  docx: {
    filename: "smoke-attachment-scope.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    bytes: Buffer.from("PK\u0003\u0004 SMOKE TEST DELETE docx fixture"),
  },
  eml: {
    filename: "smoke-attachment-message.eml",
    mimeType: "message/rfc822",
    bytes: Buffer.from("From: smoke@example.invalid\r\nTo: test@example.invalid\r\nSubject: Smoke EML\r\n\r\nSMOKE TEST DELETE\r\n"),
  },
  msg: {
    filename: "smoke-attachment-message.msg",
    mimeType: "application/vnd.ms-outlook",
    bytes: Buffer.from("SMOKE TEST DELETE MSG fixture bytes"),
  },
  leadPhoto: {
    filename: "smoke-attachment-lead-photo.jpg",
    mimeType: "image/jpeg",
    bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]),
  },
};

async function uploadDirect(
  options: CliOptions,
  session: Session,
  input: {
    filename: string;
    mimeType: string;
    bytes: Buffer;
    category: FileCategory;
    leadId?: string;
    dealId?: string;
    tags?: string[];
  }
) {
  const headers: Record<string, string> = authHeaders(options, session, {
    "content-type": input.mimeType,
    "x-original-filename": encodeURIComponent(input.filename),
    "x-file-category": input.category,
    "content-length": String(input.bytes.length),
  });
  if (input.leadId) headers["x-lead-id"] = input.leadId;
  if (input.dealId) headers["x-deal-id"] = input.dealId;
  if (input.tags?.length) headers["x-file-tags"] = input.tags.join(",");

  const result = await apiJson<{ file: UploadedFile }>(`${baseApi(options)}/api/files/upload-direct`, {
    method: "POST",
    headers,
    body: input.bytes as unknown as BodyInit,
    expectedStatus: 201,
  });
  return result.body.file;
}

async function listFiles(options: CliOptions, session: Session, params: Record<string, string>) {
  const url = new URL(`${baseApi(options)}/api/files`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  url.searchParams.set("limit", "100");
  const result = await apiJson<ApiFileList>(url.toString(), {
    headers: authHeaders(options, session),
  });
  return result.body.files;
}

async function downloadAndAssertSize(options: CliOptions, session: Session, file: UploadedFile, expectedBytes: Buffer) {
  const result = await apiJson<{ url: string; filename: string }>(`${baseApi(options)}/api/files/${file.id}/download`, {
    headers: authHeaders(options, session),
  });
  const download = await fetch(result.body.url);
  const body = Buffer.from(await download.arrayBuffer());
  if (!download.ok) throw new Error(`Download for ${file.originalFilename} returned HTTP ${download.status}`);
  if (body.length !== expectedBytes.length) {
    throw new Error(`Downloaded ${file.originalFilename} size mismatch: expected ${expectedBytes.length}, got ${body.length}`);
  }
  return { filename: result.body.filename, size: body.length };
}

function requireFile(files: UploadedFile[], filename: string) {
  const file = files.find((candidate) => candidate.originalFilename === filename);
  if (!file) throw new Error(`Expected file ${filename} was not returned. Saw: ${files.map((f) => f.originalFilename).join(", ")}`);
  return file;
}

function assertIntake(file: UploadedFile, expectedKey: string) {
  if (file.intakeRequirementKey !== expectedKey) {
    throw new Error(`${file.originalFilename} expected intakeRequirementKey=${expectedKey}, got ${file.intakeRequirementKey ?? "null"}`);
  }
}

async function convertLead(options: CliOptions, session: Session, fixture: Fixture) {
  const result = await apiJson<{ deal: { id: string; name: string; sourceLeadId: string } }>(
    `${baseApi(options)}/api/leads/${fixture.leadId}/convert`,
    {
      method: "POST",
      headers: authHeaders(options, session, { "content-type": "application/json" }),
      body: JSON.stringify({ dealStageId: fixture.opportunityStageId, projectTypeId: fixture.projectTypeId }),
      expectedStatus: 201,
    }
  );
  return result.body.deal;
}

async function verifyLeadEmails(options: CliOptions, session: Session, leadId: string, expectedEmailId: string) {
  const result = await apiJson<{ emails: Array<{ id: string; assignedEntityType: string; assignedEntityId: string }> }>(
    `${baseApi(options)}/api/email/lead/${leadId}`,
    { headers: authHeaders(options, session) }
  );
  if (!result.body.emails.some((email) => email.id === expectedEmailId)) {
    throw new Error("Lead Emails tab API did not include the synthetic lead email.");
  }
  return result.body.emails.length;
}

async function verifyDealEmails(options: CliOptions, session: Session, dealId: string, expectedEmailId: string) {
  const result = await apiJson<{ emails: Array<{ id: string; assignedEntityType: string; assignedEntityId: string }> }>(
    `${baseApi(options)}/api/email/deal/${dealId}`,
    { headers: authHeaders(options, session) }
  );
  if (!result.body.emails.some((email) => email.id === expectedEmailId)) {
    throw new Error("Converted deal Emails tab API did not include the source-lead email.");
  }
  return result.body.emails.length;
}

async function verifyLeadTabsInBrowser(options: CliOptions, fixture: Fixture) {
  if (options.skipBrowser) {
    return { checked: false, reason: "Skipped by --skip-browser / SMOKE_SKIP_BROWSER=1" };
  }

  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.goto(`${baseOrigin(options)}/login`, { waitUntil: "domcontentloaded" });
    await page.getByLabel(/email/i).fill(options.email);
    await page.getByLabel(/password/i).fill(options.password);
    await page.getByRole("button", { name: /sign in|log in/i }).click();
    await page.waitForURL(/\/(dashboard|leads|deals|pipeline|$)/, { timeout: 30_000 }).catch(() => {});
    await page.goto(`${baseOrigin(options)}/leads/${fixture.leadId}`, { waitUntil: "networkidle" });
    for (const tabName of ["Files", "Photos", "Emails"]) {
      await page.getByRole("tab", { name: tabName }).waitFor({ timeout: 20_000 });
    }
    return { checked: true, tabsVisible: ["Files", "Photos", "Emails"] };
  } finally {
    await browser.close();
  }
}

async function deleteR2Objects(keys: string[]) {
  if (!keys.length) return { attempted: false, deleted: 0, reason: "no keys" };
  if (!process.env.R2_ACCOUNT_ID || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
    return { attempted: false, deleted: 0, reason: "R2 credentials not available to smoke process" };
  }
  const { deleteObject } = await import("../server/src/lib/r2-client.js");
  for (const key of keys) await deleteObject(key);
  return { attempted: true, deleted: keys.length };
}

async function main() {
  const options = readOptions();
  const client = new pg.Client({ connectionString: connectionString() });
  await client.connect();

  let cleanup: Awaited<ReturnType<typeof cleanupSmokeRows>> | null = null;
  let r2Cleanup: Awaited<ReturnType<typeof deleteR2Objects>> | null = null;
  const evidence: Record<string, unknown> = {};

  try {
    const session = await login(options);
    const fixture = await loadFixture(client, options, session);
    evidence.fixture = fixture;

    const clientDocs = [
      smokeFiles.pdf,
      smokeFiles.jpg,
      smokeFiles.docx,
      smokeFiles.eml,
      smokeFiles.msg,
    ];
    const leadUploads = [];
    for (const file of clientDocs) {
      leadUploads.push(await uploadDirect(options, session, {
        filename: file.filename,
        mimeType: file.mimeType,
        bytes: file.bytes,
        category: file.mimeType.startsWith("image/") ? "photo" : "other",
        leadId: fixture.leadId,
        tags: [CLIENT_PROVIDED_DOCS_TAG],
      }));
    }
    const leadPhoto = await uploadDirect(options, session, {
      filename: smokeFiles.leadPhoto.filename,
      mimeType: smokeFiles.leadPhoto.mimeType,
      bytes: smokeFiles.leadPhoto.bytes,
      category: "photo",
      leadId: fixture.leadId,
    });

    const leadFileList = await listFiles(options, session, { leadId: fixture.leadId });
    const leadPhotoList = await listFiles(options, session, { leadId: fixture.leadId, category: "photo" });
    requireFile(leadFileList, smokeFiles.eml.filename);
    requireFile(leadFileList, smokeFiles.msg.filename);
    requireFile(leadPhotoList, smokeFiles.leadPhoto.filename);
    const leadEmailCount = await verifyLeadEmails(options, session, fixture.leadId, fixture.emailId);
    const browserTabs = await verifyLeadTabsInBrowser(options, fixture);

    const deal = await convertLead(options, session, fixture);
    const dealFiles = await listFiles(options, session, { dealId: deal.id });
    const dealPhotos = await listFiles(options, session, { dealId: deal.id, category: "photo" });

    const pdf = requireFile(dealFiles, smokeFiles.pdf.filename);
    const jpg = requireFile(dealFiles, smokeFiles.jpg.filename);
    const docx = requireFile(dealFiles, smokeFiles.docx.filename);
    const eml = requireFile(dealFiles, smokeFiles.eml.filename);
    const msg = requireFile(dealFiles, smokeFiles.msg.filename);
    const convertedLeadPhoto = requireFile(dealPhotos, smokeFiles.leadPhoto.filename);
    requireFile(dealPhotos, smokeFiles.jpg.filename);

    assertIntake(pdf, "scope_docs");
    assertIntake(docx, "scope_docs");
    assertIntake(eml, "scope_docs");
    assertIntake(msg, "scope_docs");
    assertIntake(jpg, "site_photos");

    const leadEmlRoundTrip = await downloadAndAssertSize(options, session, eml, smokeFiles.eml.bytes);
    const leadMsgRoundTrip = await downloadAndAssertSize(options, session, msg, smokeFiles.msg.bytes);

    const dealEml = await uploadDirect(options, session, {
      filename: "smoke-attachment-deal-message.eml",
      mimeType: smokeFiles.eml.mimeType,
      bytes: smokeFiles.eml.bytes,
      category: "other",
      dealId: deal.id,
    });
    const dealMsg = await uploadDirect(options, session, {
      filename: "smoke-attachment-deal-message.msg",
      mimeType: smokeFiles.msg.mimeType,
      bytes: smokeFiles.msg.bytes,
      category: "other",
      dealId: deal.id,
    });
    const dealEmlRoundTrip = await downloadAndAssertSize(options, session, dealEml, smokeFiles.eml.bytes);
    const dealMsgRoundTrip = await downloadAndAssertSize(options, session, dealMsg, smokeFiles.msg.bytes);
    const dealEmailCount = await verifyDealEmails(options, session, deal.id, fixture.emailId);

    evidence.checks = {
      clientProvidedDocsUploadedToLead: leadUploads.map((file) => file.originalFilename),
      leadFilesIncludedEmlMsg: [smokeFiles.eml.filename, smokeFiles.msg.filename],
      leadPhotosIncluded: [leadPhoto.originalFilename],
      leadEmailCount,
      browserTabs,
      convertedDealId: deal.id,
      dealFiles: dealFiles.map((file) => ({
        originalFilename: file.originalFilename,
        category: file.category,
        intakeRequirementKey: file.intakeRequirementKey,
      })),
      dealPhotos: dealPhotos.map((file) => file.originalFilename),
      convertedLeadPhoto: convertedLeadPhoto.originalFilename,
      downloads: { leadEmlRoundTrip, leadMsgRoundTrip, dealEmlRoundTrip, dealMsgRoundTrip },
      dealEmailCount,
    };

    if (!options.retain) {
      cleanup = await cleanupSmokeRows(client, fixture.schemaName);
      r2Cleanup = await deleteR2Objects(cleanup.r2Keys);
    }

    console.log(JSON.stringify({
      ok: true,
      apiBaseUrl: options.apiBaseUrl,
      origin: options.origin,
      user: session.user,
      evidence,
      cleanup,
      r2Cleanup,
      retained: options.retain,
    }, null, 2));
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
