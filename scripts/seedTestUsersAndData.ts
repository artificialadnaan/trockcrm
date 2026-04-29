import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import { cleanupMarkedTestDataInSchema, TEST_DATA_MARKER } from "./cleanupTestData.js";

dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), "../.env") });

const SCHEMA = "office_dallas";
const TEST_USERS = [
  { email: "admin@trock.dev", displayName: "Admin User", role: "admin" },
  { email: "director@trock.dev", displayName: "Director User", role: "director" },
  { email: "rep@trock.dev", displayName: "Sales Rep", role: "rep" },
] as const;

type SeedUserEmail = (typeof TEST_USERS)[number]["email"];
interface SeedContext {
  officeId: string;
  users: Record<SeedUserEmail, string>;
  stages: Record<string, string>;
  projectTypes: Array<{ id: string; name: string; slug: string; code: string }>;
  companies: string[];
  contacts: string[];
  properties: string[];
}

function connectionString(): string {
  const publicUrl = process.env.DATABASE_PUBLIC_URL?.trim();
  const privateUrl = process.env.DATABASE_URL?.trim();
  const selected = publicUrl || privateUrl;
  if (!selected) throw new Error("DATABASE_PUBLIC_URL or DATABASE_URL is required");
  if (!publicUrl && /railway\.internal/.test(selected)) {
    throw new Error("DATABASE_URL points at railway.internal. Export DATABASE_PUBLIC_URL in .env and retry.");
  }
  return selected;
}

function prefixed(value: string) {
  return `${TEST_DATA_MARKER} ${value}`;
}

function todayOffset(days: number) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function requireTestDataColumns(client: pg.Client) {
  const result = await client.query(`
    SELECT table_name
      FROM information_schema.columns
     WHERE table_schema = $1
       AND column_name = 'is_test_data'
       AND table_name = ANY($2::text[])
  `, [SCHEMA, ["companies", "contacts", "properties", "leads", "deals", "tasks"]]);
  const found = new Set(result.rows.map((row) => row.table_name));
  const missing = ["companies", "contacts", "properties", "leads", "deals", "tasks"].filter((table) => !found.has(table));
  if (missing.length) throw new Error(`Migration 0071 is required before seeding test data. Missing is_test_data on: ${missing.join(", ")}`);
}

async function seedUsers(client: pg.Client): Promise<SeedContext["users"]> {
  const office = await client.query(`
    INSERT INTO public.offices (name, slug, address, phone, is_active)
    VALUES ('Dallas Office', 'dallas', '1234 Commerce St, Dallas, TX 75201', '(214) 555-0100', true)
    ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, is_active = true
    RETURNING id
  `);
  const officeId = office.rows[0].id as string;

  const users: Partial<SeedContext["users"]> = {};
  for (const user of TEST_USERS) {
    const result = await client.query(`
      INSERT INTO public.users (email, display_name, role, office_id, is_active, notification_prefs, updated_at)
      VALUES ($1, $2, $3::user_role, $4, true, '{"testData":{"allowlisted":true}}'::jsonb, NOW())
      ON CONFLICT (email) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        role = EXCLUDED.role,
        office_id = EXCLUDED.office_id,
        is_active = true,
        notification_prefs = COALESCE(public.users.notification_prefs, '{}'::jsonb) || EXCLUDED.notification_prefs,
        updated_at = NOW()
      RETURNING id
    `, [user.email, user.displayName, user.role, officeId]);
    users[user.email] = result.rows[0].id;
  }
  return users as SeedContext["users"];
}

async function loadStageIds(client: pg.Client) {
  const rows = await client.query(`SELECT slug, id FROM public.pipeline_stage_config WHERE slug = ANY($1::text[])`, [[
    "new_lead", "qualified_lead", "sales_validation_stage",
    "opportunity", "estimate_sent_to_client", "sent_to_production", "contract_signed",
  ]]);
  const stages = Object.fromEntries(rows.rows.map((row) => [row.slug, row.id])) as Record<string, string>;
  for (const required of ["new_lead", "qualified_lead", "sales_validation_stage", "opportunity", "estimate_sent_to_client", "sent_to_production"]) {
    if (!stages[required]) throw new Error(`Missing pipeline stage ${required}`);
  }
  stages.contract_signed = stages.contract_signed ?? stages.sent_to_production;
  return stages;
}

async function loadProjectTypes(client: pg.Client) {
  const result = await client.query(`
    SELECT id, lower(name) AS name, slug, code
      FROM public.project_type_config
     WHERE is_active = true AND code IS NOT NULL
     ORDER BY code::int ASC NULLS LAST, display_order ASC
  `);
  if (result.rows.length < 9) throw new Error(`Expected at least 9 active coded project types, found ${result.rows.length}`);
  return result.rows.slice(0, 9) as SeedContext["projectTypes"];
}

async function seedDirectory(client: pg.Client) {
  const companies: string[] = [];
  const contacts: string[] = [];
  const properties: string[] = [];
  for (const [index, label] of ["A", "B", "C"].entries()) {
    const company = await client.query(`
      INSERT INTO ${SCHEMA}.companies (name, slug, category, city, state, notes, is_test_data, is_active, updated_at)
      VALUES ($1, $2, 'client', 'Dallas', 'TX', $3, true, true, NOW())
      ON CONFLICT (slug) DO UPDATE SET notes = EXCLUDED.notes, is_test_data = true, is_active = true, updated_at = NOW()
      RETURNING id
    `, [`Test Customer ${label}`, `test-customer-${label.toLowerCase()}`, prefixed(`Synthetic company ${label}`)]);
    companies.push(company.rows[0].id);

    const contactEmail = `test.contact.${label.toLowerCase()}@example.invalid`;
    const existingContact = await client.query(`SELECT id FROM ${SCHEMA}.contacts WHERE lower(email) = lower($1)`, [contactEmail]);
    const contact = existingContact.rowCount
      ? await client.query(`
          UPDATE ${SCHEMA}.contacts
             SET first_name = $1,
                 last_name = $2,
                 company_name = $4,
                 company_id = $5,
                 category = 'client',
                 notes = $6,
                 is_test_data = true,
                 is_active = true,
                 updated_at = NOW()
           WHERE id = $7
           RETURNING id
        `, ["Test", `Contact ${label}`, contactEmail, `Test Customer ${label}`, company.rows[0].id, prefixed(`Synthetic contact ${label}`), existingContact.rows[0].id])
      : await client.query(`
          INSERT INTO ${SCHEMA}.contacts (first_name, last_name, email, company_name, company_id, category, notes, is_test_data, is_active, updated_at)
          VALUES ($1, $2, $3, $4, $5, 'client', $6, true, true, NOW())
          RETURNING id
        `, ["Test", `Contact ${label}`, contactEmail, `Test Customer ${label}`, company.rows[0].id, prefixed(`Synthetic contact ${label}`)]);
    contacts.push(contact.rows[0].id);

    const property = await client.query(`
      INSERT INTO ${SCHEMA}.properties (company_id, name, address, city, state, zip, notes, is_test_data, is_active, updated_at)
      VALUES ($1, $2, $3, 'Dallas', 'TX', $4, $5, true, true, NOW())
      RETURNING id
    `, [company.rows[0].id, `Test Property ${label}`, `${100 + index} Test Data Ave`, `7520${index}`, prefixed(`Synthetic property ${label}`)]);
    properties.push(property.rows[0].id);
  }
  return { companies, contacts, properties };
}

function projectType(ctx: SeedContext, index: number) {
  return ctx.projectTypes[index % ctx.projectTypes.length];
}

async function insertLead(client: pg.Client, ctx: SeedContext, ownerEmail: SeedUserEmail, index: number, stageSlug: string, status: "open" | "converted" | "disqualified") {
  const pt = projectType(ctx, index);
  const companyId = ctx.companies[index % ctx.companies.length];
  const contactId = ctx.contacts[index % ctx.contacts.length];
  const propertyId = ctx.properties[index % ctx.properties.length];
  await client.query(`
    INSERT INTO ${SCHEMA}.leads (
      company_id, property_id, primary_contact_id, name, stage_id, assigned_rep_id, sales_rep_id,
      pipeline_type, status, source, description, office_code, project_type, project_type_id,
      pre_qual_value, is_test_data, is_active, stage_entered_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $6, 'normal', $7::lead_status, 'test-data', $8, 'dfw', $9, $10, $11, true, true, NOW() - ($12::int * INTERVAL '1 day'), NOW())
  `, [companyId, propertyId, contactId, prefixed(`${ownerEmail} lead ${index + 1}`), ctx.stages[stageSlug], ctx.users[ownerEmail], status, prefixed(`Seeded lead for ${ownerEmail}; stage=${stageSlug}; type=${pt.name}`), pt.name, pt.id, 25000 + index * 2500, index]);
}

async function insertDeal(client: pg.Client, ctx: SeedContext, ownerEmail: SeedUserEmail, index: number, stageSlug: string, opts: { validProjectNumber?: boolean; contractSigned?: boolean } = {}) {
  const pt = projectType(ctx, index + 4);
  const companyId = ctx.companies[index % ctx.companies.length];
  const contactId = ctx.contacts[index % ctx.contacts.length];
  const propertyId = ctx.properties[index % ctx.properties.length];
  const dealPrefix = ownerEmail.startsWith("director") ? "TEST-DIR" : ownerEmail.startsWith("rep") ? "TEST-REP" : "TEST-ADM";
  const dealNumber = `${dealPrefix}-${String(index + 1).padStart(3, "0")}`;
  const projectNumber = opts.validProjectNumber ? `dfw-${pt.code}-${String(90000 + index).padStart(5, "0")}-aa` : null;
  await client.query(`
    INSERT INTO ${SCHEMA}.deals (
      deal_number, name, stage_id, assigned_rep_id, primary_contact_id, company_id, property_id,
      bid_estimate, awarded_amount, description, property_address, property_city, property_state, property_zip,
      project_type, project_type_id, source, win_probability, expected_close_date, contract_signed_date,
      bid_board_project_number, intended_project_number, workflow_route, is_test_data, is_active, stage_entered_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, '100 Test Data Ave', 'Dallas', 'TX', '75201',
      $11, $12, 'test-data', $13, $14::date, $15::date, $16, $16, 'normal', true, true, NOW() - ($17::int * INTERVAL '1 day'), NOW())
  `, [dealNumber, prefixed(`${ownerEmail} deal ${index + 1}`), ctx.stages[stageSlug], ctx.users[ownerEmail], contactId, companyId, propertyId, 50000 + index * 15000, opts.contractSigned ? 65000 + index * 15000 : null, prefixed(`Seeded deal for ${ownerEmail}; stage=${stageSlug}; type=${pt.name}`), pt.name, pt.id, Math.max(20, 80 - index * 5), todayOffset(14 + index), opts.contractSigned ? todayOffset(-2) : null, projectNumber, index]);
}

async function insertTask(client: pg.Client, ctx: SeedContext, ownerEmail: SeedUserEmail, index: number) {
  const states = [
    { status: "pending", due: 0, completed: null, overdue: false, label: "due today" },
    { status: "pending", due: -3, completed: null, overdue: true, label: "overdue" },
    { status: "completed", due: -1, completed: todayOffset(-1), overdue: false, label: "completed" },
    { status: "scheduled", due: 7, completed: null, overdue: false, label: "upcoming" },
  ] as const;
  const state = states[index % states.length];
  await client.query(`
    INSERT INTO ${SCHEMA}.tasks (title, description, type, priority, status, assigned_to, created_by, due_date, completed_at, is_overdue, is_test_data, updated_at)
    VALUES ($1, $2, 'follow_up', $3::task_priority, $4::task_status, $5, $5, $6::date, $7::timestamptz, $8, true, NOW())
  `, [prefixed(`${ownerEmail} ${state.label} task ${index + 1}`), prefixed(`Synthetic ${state.label} task for ${ownerEmail}`), index % 5 === 0 ? "high" : "normal", state.status, ctx.users[ownerEmail], todayOffset(state.due), state.completed, state.overdue]);
}

async function seedWork(client: pg.Client, ctx: SeedContext) {
  const directorLeadStages = ["new_lead", "qualified_lead", "sales_validation_stage", "new_lead", "qualified_lead"];
  const directorLeadStatuses = ["open", "open", "open", "disqualified", "open"] as const;
  for (let i = 0; i < 5; i++) await insertLead(client, ctx, "director@trock.dev", i, directorLeadStages[i], directorLeadStatuses[i]);
  for (const [i, stage] of ["opportunity", "estimate_sent_to_client", "contract_signed"].entries()) await insertDeal(client, ctx, "director@trock.dev", i, stage, { contractSigned: stage === "contract_signed" });
  for (let i = 0; i < 10; i++) await insertTask(client, ctx, "director@trock.dev", i);

  const repLeadStages = ["new_lead", "new_lead", "qualified_lead", "sales_validation_stage", "qualified_lead", "new_lead", "sales_validation_stage", "qualified_lead"];
  const repLeadStatuses = ["open", "open", "open", "open", "disqualified", "open", "converted", "open"] as const;
  for (let i = 0; i < 8; i++) await insertLead(client, ctx, "rep@trock.dev", i + 5, repLeadStages[i], repLeadStatuses[i]);
  const repDealStages = ["opportunity", "opportunity", "estimate_sent_to_client", "contract_signed", "estimate_sent_to_client"];
  for (let i = 0; i < 5; i++) await insertDeal(client, ctx, "rep@trock.dev", i + 3, repDealStages[i], { validProjectNumber: i < 2, contractSigned: repDealStages[i] === "contract_signed" });
  for (let i = 0; i < 15; i++) await insertTask(client, ctx, "rep@trock.dev", i);

  await insertLead(client, ctx, "admin@trock.dev", 13, "new_lead", "open");
  await insertDeal(client, ctx, "admin@trock.dev", 8, "opportunity");
  for (let i = 0; i < 3; i++) await insertTask(client, ctx, "admin@trock.dev", i);
}

async function countSeeded(client: pg.Client) {
  const result = await client.query(`
    SELECT 'companies' AS table_name, count(*)::int AS count FROM ${SCHEMA}.companies WHERE is_test_data = true
    UNION ALL SELECT 'contacts', count(*)::int FROM ${SCHEMA}.contacts WHERE is_test_data = true
    UNION ALL SELECT 'properties', count(*)::int FROM ${SCHEMA}.properties WHERE is_test_data = true
    UNION ALL SELECT 'leads', count(*)::int FROM ${SCHEMA}.leads WHERE is_test_data = true
    UNION ALL SELECT 'deals', count(*)::int FROM ${SCHEMA}.deals WHERE is_test_data = true
    UNION ALL SELECT 'tasks', count(*)::int FROM ${SCHEMA}.tasks WHERE is_test_data = true
  `);
  return Object.fromEntries(result.rows.map((row) => [row.table_name, row.count]));
}

export async function seedTestUsersAndData(client: pg.Client) {
  await requireTestDataColumns(client);
  await cleanupMarkedTestDataInSchema(client, SCHEMA, true);
  await client.query("BEGIN");
  try {
    const users = await seedUsers(client);
    const office = await client.query(`SELECT id FROM public.offices WHERE slug = 'dallas'`);
    const stages = await loadStageIds(client);
    const projectTypes = await loadProjectTypes(client);
    const directory = await seedDirectory(client);
    const ctx: SeedContext = { officeId: office.rows[0].id, users, stages, projectTypes, ...directory };
    await seedWork(client, ctx);
    await client.query("COMMIT");
    return countSeeded(client);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function main() {
  const client = new pg.Client({ connectionString: connectionString() });
  await client.connect();
  try {
    const counts = await seedTestUsersAndData(client);
    console.log("SEEDED TEST USERS AND TEST DATA");
    for (const [table, count] of Object.entries(counts)) console.log(`${table}: ${count}`);
  } finally {
    await client.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
