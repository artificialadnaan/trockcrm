import "dotenv/config";

import crypto from "node:crypto";
import pg from "pg";
import { assertSafeIdentifier, assertWriteAllowed } from "./lib/db-safety.js";

const DEFAULT_TENANT = "office_dallas";

const TEST_USER_IDS = [
  stableUuid("trock-smoke-user:test-admin"),
  stableUuid("trock-smoke-user:test-director"),
  stableUuid("trock-smoke-user:test-sales"),
];

const TEST_USER_EMAILS = [
  "test-admin@trock.test",
  "test-director@trock.test",
  "test-sales@trock.test",
];

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

async function deleteIfTableExists(
  client: pg.Client,
  schema: string,
  table: string,
  sql: string,
  params: unknown[],
) {
  if (!(await tableExists(client, schema, table))) return 0;
  const result = await client.query(sql, params);
  return result.rowCount ?? 0;
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  const dryRun = process.argv.includes("--dry-run");
  assertWriteAllowed(databaseUrl, process.argv, dryRun ? "teardown-test-users:dry-run" : "teardown-test-users");
  const tenant = tenantFromArgs();

  const allRecordIds = [
    ...TEST_RECORD_IDS.deals,
    ...TEST_RECORD_IDS.contacts,
    TEST_RECORD_IDS.company,
  ];

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();

  const deleted: Record<string, number> = {};
  try {
    await client.query("BEGIN");

    deleted.cleanupSkips = await deleteIfTableExists(
      client,
      tenant,
      "cleanup_skips",
      `
        DELETE FROM ${tenant}.cleanup_skips
        WHERE skipped_by = ANY($1::uuid[])
           OR record_id = ANY($2::uuid[])
      `,
      [TEST_USER_IDS, allRecordIds],
    );

    deleted.cleanupAssignments = await deleteIfTableExists(
      client,
      tenant,
      "cleanup_assignments",
      `
        DELETE FROM ${tenant}.cleanup_assignments
        WHERE assigned_to = ANY($1::uuid[])
           OR record_id = ANY($2::uuid[])
           OR assignment_reason LIKE 'smoke_test_%'
      `,
      [TEST_USER_IDS, allRecordIds],
    );

    deleted.deals = await deleteIfTableExists(
      client,
      tenant,
      "deals",
      `
        DELETE FROM ${tenant}.deals
        WHERE id = ANY($1::uuid[])
           OR deal_number LIKE 'SMOKE-TEST-%'
           OR name LIKE 'SMOKE TEST DELETE%'
      `,
      [TEST_RECORD_IDS.deals],
    );

    deleted.contacts = await deleteIfTableExists(
      client,
      tenant,
      "contacts",
      `
        DELETE FROM ${tenant}.contacts
        WHERE id = ANY($1::uuid[])
           OR (first_name = 'Smoke' AND last_name LIKE 'Contact %')
      `,
      [TEST_RECORD_IDS.contacts],
    );

    deleted.companies = await deleteIfTableExists(
      client,
      tenant,
      "companies",
      `
        DELETE FROM ${tenant}.companies
        WHERE id = $1::uuid
           OR slug = 'smoke-test-delete-example-company'
           OR name LIKE 'SMOKE TEST DELETE%'
      `,
      [TEST_RECORD_IDS.company],
    );

    deleted.localAuthEvents = await deleteIfTableExists(
      client,
      "public",
      "user_local_auth_events",
      `
        DELETE FROM public.user_local_auth_events
        WHERE user_id = ANY($1::uuid[])
           OR actor_user_id = ANY($1::uuid[])
      `,
      [TEST_USER_IDS],
    );

    deleted.localAuth = await deleteIfTableExists(
      client,
      "public",
      "user_local_auth",
      `
        DELETE FROM public.user_local_auth
        WHERE user_id = ANY($1::uuid[])
      `,
      [TEST_USER_IDS],
    );

    deleted.userOnboardingRefsCleared = await deleteIfTableExists(
      client,
      "public",
      "users",
      `
        UPDATE public.users
        SET
          onboarding_completed_by = NULL,
          onboarding_completed_at = CASE
            WHEN id = ANY($1::uuid[]) THEN NULL
            ELSE onboarding_completed_at
          END,
          onboarding_override_reason = CASE
            WHEN id = ANY($1::uuid[]) THEN NULL
            ELSE onboarding_override_reason
          END,
          updated_at = now()
        WHERE id = ANY($1::uuid[])
           OR onboarding_completed_by = ANY($1::uuid[])
      `,
      [TEST_USER_IDS],
    );

    deleted.users = await deleteIfTableExists(
      client,
      "public",
      "users",
      `
        DELETE FROM public.users
        WHERE id = ANY($1::uuid[])
           OR email = ANY($2::text[])
      `,
      [TEST_USER_IDS, TEST_USER_EMAILS],
    );

    if (dryRun) {
      await client.query("ROLLBACK");
      console.log("[teardown-test-users] dry run deletion counts; rolled back.");
    } else {
      await client.query("COMMIT");
      console.log("[teardown-test-users] smoke-test users and synthetic records removed.");
    }

    console.log(JSON.stringify({ tenant, deleted }, null, 2));
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
