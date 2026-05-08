import "dotenv/config";

import crypto from "node:crypto";
import { promisify } from "node:util";
import pg from "pg";
import { assertSafeIdentifier, assertWriteAllowed } from "./lib/db-safety.js";

const scryptAsync = promisify(crypto.scrypt);
const DEFAULT_TENANT = "office_dallas";
const DEFAULT_OFFICE_SLUG = "dallas";
const TEST_PASSWORD = "TrockTest123!";
const TEST_OWNER_ID = "smoke-test-owner";
const TEST_SOURCE = "cleanup_smoke_test";

type TestUser = {
  id: string;
  email: string;
  displayName: string;
  firstName: string;
  lastName: string;
  role: "admin" | "director" | "rep";
};

const TEST_USERS: TestUser[] = [
  {
    id: stableUuid("trock-smoke-user:test-admin"),
    email: "test-admin@trock.test",
    displayName: "Smoke Test Admin",
    firstName: "Smoke",
    lastName: "Admin",
    role: "admin",
  },
  {
    id: stableUuid("trock-smoke-user:test-director"),
    email: "test-director@trock.test",
    displayName: "Smoke Test Director",
    firstName: "Smoke",
    lastName: "Director",
    role: "director",
  },
  {
    id: stableUuid("trock-smoke-user:test-sales"),
    email: "test-sales@trock.test",
    displayName: "Smoke Test Sales",
    firstName: "Smoke",
    lastName: "Sales",
    role: "rep",
  },
];

const TEST_SALES_USER = TEST_USERS.find((user) => user.email === "test-sales@trock.test")!;

const TEST_RECORD_IDS = {
  company: stableUuid("trock-smoke-record:company:1"),
  contacts: [
    stableUuid("trock-smoke-record:contact:1"),
    stableUuid("trock-smoke-record:contact:2"),
  ],
  deals: [
    stableUuid("trock-smoke-record:deal:1"),
    stableUuid("trock-smoke-record:deal:2"),
    stableUuid("trock-smoke-record:deal:3"),
  ],
};

function stableUuid(seed: string) {
  const hex = crypto.createHash("sha256").update(seed).digest("hex").slice(0, 32);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    ((Number.parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, "0") + hex.slice(18, 20),
    hex.slice(20, 32),
  ].join("-");
}

async function hashPassword(password: string) {
  const salt = crypto.randomBytes(16);
  const derivedKey = (await scryptAsync(password, salt, 64)) as Buffer;
  return `scrypt$${salt.toString("hex")}$${derivedKey.toString("hex")}`;
}

function tenantFromArgs() {
  const tenantArg = process.argv.find((arg) => arg.startsWith("--tenant="));
  return assertSafeIdentifier(tenantArg?.split("=")[1] ?? DEFAULT_TENANT, "tenant schema");
}

async function tableExists(client: pg.Client, schema: string, table: string) {
  const result = await client.query<{ exists: boolean }>(
    `SELECT to_regclass($1) IS NOT NULL AS exists`,
    [`${schema}.${table}`],
  );
  return Boolean(result.rows[0]?.exists);
}

async function columnExists(client: pg.Client, schema: string, table: string, column: string) {
  const result = await client.query<{ exists: boolean }>(
    `
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = $1
          AND table_name = $2
          AND column_name = $3
      ) AS exists
    `,
    [schema, table, column],
  );
  return Boolean(result.rows[0]?.exists);
}

async function getOfficeId(client: pg.Client) {
  const result = await client.query<{ id: string }>(
    `
      SELECT id
      FROM public.offices
      WHERE slug = $1 AND is_active = true
      LIMIT 1
    `,
    [DEFAULT_OFFICE_SLUG],
  );
  const officeId = result.rows[0]?.id;
  if (!officeId) throw new Error(`No active office found for slug ${DEFAULT_OFFICE_SLUG}`);
  return officeId;
}

async function getStageId(client: pg.Client, slug: string) {
  const result = await client.query<{ id: string }>(
    `
      SELECT id
      FROM public.pipeline_stage_config
      WHERE slug = $1
      ORDER BY display_order ASC
      LIMIT 1
    `,
    [slug],
  );
  const stageId = result.rows[0]?.id;
  if (!stageId) throw new Error(`No active pipeline stage found for slug ${slug}`);
  return stageId;
}

async function seedUsers(client: pg.Client, officeId: string) {
  const passwordHash = await hashPassword(TEST_PASSWORD);

  for (const user of TEST_USERS) {
    await client.query(
      `
        INSERT INTO public.users (
          id,
          email,
          display_name,
          first_name,
          last_name,
          role,
          office_id,
          is_active,
          notification_prefs,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, true, '{}'::jsonb, now(), now())
        ON CONFLICT (email) DO UPDATE
        SET
          id = EXCLUDED.id,
          display_name = EXCLUDED.display_name,
          first_name = EXCLUDED.first_name,
          last_name = EXCLUDED.last_name,
          role = EXCLUDED.role,
          office_id = EXCLUDED.office_id,
          is_active = true,
          updated_at = now()
      `,
      [
        user.id,
        user.email,
        user.displayName,
        user.firstName,
        user.lastName,
        user.role,
        officeId,
      ],
    );

    await client.query(
      `
        INSERT INTO public.user_local_auth (
          user_id,
          password_hash,
          must_change_password,
          is_enabled,
          invite_sent_at,
          invite_expires_at,
          last_login_at,
          failed_login_attempts,
          password_changed_at,
          revoked_at,
          created_at,
          updated_at
        )
        VALUES ($1, $2, false, true, now(), now() + interval '30 days', NULL, 0, now(), NULL, now(), now())
        ON CONFLICT (user_id) DO UPDATE
        SET
          password_hash = EXCLUDED.password_hash,
          must_change_password = false,
          is_enabled = true,
          invite_sent_at = now(),
          invite_expires_at = now() + interval '30 days',
          last_login_at = NULL,
          failed_login_attempts = 0,
          last_failed_login_at = NULL,
          locked_until = NULL,
          password_changed_at = now(),
          revoked_at = NULL,
          revoked_by_user_id = NULL,
          updated_at = now()
      `,
      [user.id, passwordHash],
    );
  }

  if (await columnExists(client, "public", "users", "onboarding_completed_at")) {
    await client.query(
      `
        UPDATE public.users
        SET
          onboarding_completed_at = NULL,
          onboarding_completed_by = NULL,
          onboarding_override_reason = NULL,
          updated_at = now()
        WHERE id = ANY($1::uuid[])
      `,
      [TEST_USERS.map((user) => user.id)],
    );
  }
}

async function seedSyntheticQueue(client: pg.Client, tenant: string, stageId: string) {
  await client.query(
    `
      INSERT INTO ${tenant}.companies (
        id,
        name,
        slug,
        category,
        phone,
        source_refs,
        notes,
        is_test_data,
        is_active,
        cleanup_status,
        hubspot_extra_properties,
        created_at,
        updated_at
      )
      VALUES (
        $1,
        'SMOKE TEST DELETE - Example Company',
        'smoke-test-delete-example-company',
        'other',
        NULL,
        $2::jsonb,
        'Synthetic cleanup smoke-test company. Safe to delete with scripts/teardown-test-users.ts.',
        true,
        true,
        'pending',
        $3::jsonb,
        now(),
        now()
      )
      ON CONFLICT (id) DO UPDATE
      SET
        name = EXCLUDED.name,
        slug = EXCLUDED.slug,
        phone = EXCLUDED.phone,
        source_refs = EXCLUDED.source_refs,
        notes = EXCLUDED.notes,
        is_test_data = true,
        is_active = true,
        cleanup_status = 'pending',
        cleanup_completed_at = NULL,
        cleanup_completed_by = NULL,
        skip_reason = NULL,
        skip_notes = NULL,
        needs_leadership_review = false,
        hubspot_extra_properties = EXCLUDED.hubspot_extra_properties,
        updated_at = now()
    `,
    [
      TEST_RECORD_IDS.company,
      JSON.stringify({ source: TEST_SOURCE, smoke_test: true }),
      JSON.stringify({ source: TEST_SOURCE, missing_fields: ["phone", "domain"] }),
    ],
  );

  const contacts = [
    {
      id: TEST_RECORD_IDS.contacts[0],
      firstName: "Smoke",
      lastName: "Contact One",
      email: "",
      phone: "",
      companyName: "SMOKE TEST DELETE - Example Company",
    },
    {
      id: TEST_RECORD_IDS.contacts[1],
      firstName: "Smoke",
      lastName: "Contact Two",
      email: "smoke-contact-two@example.invalid",
      phone: "",
      companyName: "SMOKE TEST DELETE - Example Company",
    },
  ];

  for (const contact of contacts) {
    await client.query(
      `
        INSERT INTO ${tenant}.contacts (
          id,
          first_name,
          last_name,
          email,
          phone,
          company_name,
          company_id,
          category,
          source_refs,
          is_test_data,
          is_active,
          cleanup_status,
          hubspot_extra_properties,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, NULLIF($4, ''), NULLIF($5, ''), $6, $7, 'other', $8::jsonb, true, true, 'pending', $9::jsonb, now(), now())
        ON CONFLICT (id) DO UPDATE
        SET
          first_name = EXCLUDED.first_name,
          last_name = EXCLUDED.last_name,
          email = EXCLUDED.email,
          phone = EXCLUDED.phone,
          company_name = EXCLUDED.company_name,
          company_id = EXCLUDED.company_id,
          source_refs = EXCLUDED.source_refs,
          is_test_data = true,
          is_active = true,
          cleanup_status = 'pending',
          cleanup_completed_at = NULL,
          cleanup_completed_by = NULL,
          skip_reason = NULL,
          skip_notes = NULL,
          needs_leadership_review = false,
          hubspot_extra_properties = EXCLUDED.hubspot_extra_properties,
          updated_at = now()
      `,
      [
        contact.id,
        contact.firstName,
        contact.lastName,
        contact.email,
        contact.phone,
        contact.companyName,
        TEST_RECORD_IDS.company,
        JSON.stringify({ source: TEST_SOURCE, smoke_test: true }),
        JSON.stringify({ source: TEST_SOURCE, missing_fields: ["email", "phone"] }),
      ],
    );
  }

  const deals = [
    {
      id: TEST_RECORD_IDS.deals[0],
      dealNumber: "SMOKE-TEST-001",
      name: "SMOKE TEST DELETE - Missing Amount",
      contactId: TEST_RECORD_IDS.contacts[0],
      companyId: TEST_RECORD_IDS.company,
      amount: null,
    },
    {
      id: TEST_RECORD_IDS.deals[1],
      dealNumber: "SMOKE-TEST-002",
      name: "SMOKE TEST DELETE - Missing Contact",
      contactId: null,
      companyId: TEST_RECORD_IDS.company,
      amount: "12500.00",
    },
    {
      id: TEST_RECORD_IDS.deals[2],
      dealNumber: "SMOKE-TEST-003",
      name: "SMOKE TEST DELETE - Missing Company",
      contactId: TEST_RECORD_IDS.contacts[1],
      companyId: null,
      amount: "0.00",
    },
  ];

  for (const deal of deals) {
    await client.query(
      `
        INSERT INTO ${tenant}.deals (
          id,
          deal_number,
          name,
          stage_id,
          assigned_rep_id,
          primary_contact_id,
          company_id,
          bid_estimate,
          source,
          hubspot_owner_id,
          hubspot_owner_email,
          ownership_sync_status,
          expected_close_date,
          is_test_data,
          is_active,
          cleanup_status,
          hubspot_extra_properties,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::numeric, $9, $10, $11, 'mapped', current_date + interval '14 days', true, true, 'pending', $12::jsonb, now(), now())
        ON CONFLICT (id) DO UPDATE
        SET
          deal_number = EXCLUDED.deal_number,
          name = EXCLUDED.name,
          stage_id = EXCLUDED.stage_id,
          assigned_rep_id = EXCLUDED.assigned_rep_id,
          primary_contact_id = EXCLUDED.primary_contact_id,
          company_id = EXCLUDED.company_id,
          bid_estimate = EXCLUDED.bid_estimate,
          source = EXCLUDED.source,
          hubspot_owner_id = EXCLUDED.hubspot_owner_id,
          hubspot_owner_email = EXCLUDED.hubspot_owner_email,
          ownership_sync_status = 'mapped',
          expected_close_date = EXCLUDED.expected_close_date,
          is_test_data = true,
          is_active = true,
          cleanup_status = 'pending',
          cleanup_completed_at = NULL,
          cleanup_completed_by = NULL,
          skip_reason = NULL,
          skip_notes = NULL,
          needs_leadership_review = false,
          hubspot_extra_properties = EXCLUDED.hubspot_extra_properties,
          updated_at = now()
      `,
      [
        deal.id,
        deal.dealNumber,
        deal.name,
        stageId,
        TEST_SALES_USER.id,
        deal.contactId,
        deal.companyId,
        deal.amount,
        TEST_SOURCE,
        TEST_OWNER_ID,
        TEST_SALES_USER.email,
        JSON.stringify({ source: TEST_SOURCE, missing_fields: ["amount", "contact", "company"] }),
      ],
    );
  }

  const assignmentRows = [
    ...TEST_RECORD_IDS.deals.map((id) => ({ type: "deal", id, reason: "smoke_test_deal" })),
    ...TEST_RECORD_IDS.contacts.map((id) => ({ type: "contact", id, reason: "smoke_test_contact" })),
    { type: "company", id: TEST_RECORD_IDS.company, reason: "smoke_test_company" },
  ];

  for (const row of assignmentRows) {
    await client.query(
      `
        INSERT INTO ${tenant}.cleanup_assignments (
          record_type,
          record_id,
          assigned_to,
          assignment_reason,
          source_hubspot_owner_id,
          source_hubspot_owner_email,
          status,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, 'pending', now(), now())
        ON CONFLICT (record_type, record_id) DO UPDATE
        SET
          assigned_to = EXCLUDED.assigned_to,
          assignment_reason = EXCLUDED.assignment_reason,
          source_hubspot_owner_id = EXCLUDED.source_hubspot_owner_id,
          source_hubspot_owner_email = EXCLUDED.source_hubspot_owner_email,
          status = 'pending',
          updated_at = now()
      `,
      [row.type, row.id, TEST_SALES_USER.id, row.reason, TEST_OWNER_ID, TEST_SALES_USER.email],
    );
  }
}

async function printVerification(client: pg.Client, tenant: string) {
  const queueResult = await client.query<{ record_type: string; count: string }>(
    `
      SELECT record_type, COUNT(*)::text AS count
      FROM ${tenant}.cleanup_assignments
      WHERE assigned_to = $1
      GROUP BY record_type
      ORDER BY record_type
    `,
    [TEST_SALES_USER.id],
  );

  const adminDirectorResult = await client.query<{ email: string; assignments: string }>(
    `
      SELECT u.email, COUNT(a.id)::text AS assignments
      FROM public.users u
      LEFT JOIN ${tenant}.cleanup_assignments a ON a.assigned_to = u.id
      WHERE u.id = ANY($1::uuid[])
      GROUP BY u.email
      ORDER BY u.email
    `,
    [TEST_USERS.filter((user) => user.role !== "rep").map((user) => user.id)],
  );

  console.log(
    JSON.stringify(
      {
        testPassword: TEST_PASSWORD,
        users: TEST_USERS.map(({ id, email, role }) => ({ id, email, role })),
        testSalesQueue: queueResult.rows,
        adminAndDirectorAssignments: adminDirectorResult.rows,
      },
      null,
      2,
    ),
  );
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  const dryRun = process.argv.includes("--dry-run");
  assertWriteAllowed(databaseUrl, process.argv, dryRun ? "seed-test-users:dry-run" : "seed-test-users");
  const tenant = tenantFromArgs();

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    if (!(await tableExists(client, tenant, "cleanup_assignments"))) {
      throw new Error(`${tenant}.cleanup_assignments does not exist. Run the cleanup onboarding migration first.`);
    }

    await client.query("BEGIN");
    const officeId = await getOfficeId(client);
    const stageId = await getStageId(client, "opportunity");
    await seedUsers(client, officeId);
    await seedSyntheticQueue(client, tenant, stageId);

    if (dryRun) {
      await printVerification(client, tenant);
      await client.query("ROLLBACK");
      console.log("[seed-test-users] dry run passed and rolled back.");
    } else {
      await client.query("COMMIT");
      console.log("[seed-test-users] smoke-test users and synthetic cleanup queue seeded.");
      await printVerification(client, tenant);
    }
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
