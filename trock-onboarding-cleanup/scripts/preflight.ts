import "dotenv/config";

import { readFile } from "node:fs/promises";
import pg from "pg";
import { printDbTarget } from "../../scripts/lib/db-safety.js";

type SeedUser = {
  id: string;
  email: string;
  displayName: string;
  role: string;
  officeSlug: string;
  hubspotOwnerIds: string[];
};

type UserSeed = {
  users: SeedUser[];
};

const REQUIRED_STAGE_SLUGS = [
  "new_lead",
  "qualified_lead",
  "sales_validation",
  "opportunity",
  "estimating",
  "service_estimating",
  "estimate_under_review",
  "estimate_sent_to_client",
  "contract",
  "won",
  "lost",
];

const REQUIRED_TENANT_TABLE_COLUMNS: Record<string, string[]> = {
  deals: [
    "cleanup_status",
    "cleanup_completed_at",
    "cleanup_completed_by",
    "skip_reason",
    "skip_notes",
    "needs_leadership_review",
    "hubspot_extra_properties",
  ],
  leads: [
    "cleanup_status",
    "cleanup_completed_at",
    "cleanup_completed_by",
    "skip_reason",
    "skip_notes",
    "needs_leadership_review",
    "hubspot_extra_properties",
  ],
  contacts: [
    "cleanup_status",
    "cleanup_completed_at",
    "cleanup_completed_by",
    "skip_reason",
    "skip_notes",
    "needs_leadership_review",
    "hubspot_extra_properties",
  ],
  companies: [
    "cleanup_status",
    "cleanup_completed_at",
    "cleanup_completed_by",
    "skip_reason",
    "skip_notes",
    "needs_leadership_review",
    "hubspot_extra_properties",
  ],
  activities: ["hubspot_extra_properties"],
};

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  printDbTarget(process.env.DATABASE_URL, "cleanup:preflight:read-only");
  const seed = JSON.parse(await readFile("migration-snapshot/import-ready/user-seed.json", "utf8")) as UserSeed;

  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    const stages = await client.query<{
      id: string;
      slug: string;
      name: string;
      workflow_family: string | null;
      is_active_pipeline: boolean;
    }>(
      `
        SELECT id, slug, name, workflow_family, is_active_pipeline
        FROM public.pipeline_stage_config
        WHERE slug = ANY($1::text[])
        ORDER BY workflow_family, display_order, slug
      `,
      [REQUIRED_STAGE_SLUGS],
    );
    const foundStageSlugs = new Set(stages.rows.map((row) => row.slug));
    const missingStages = REQUIRED_STAGE_SLUGS.filter((slug) => !foundStageSlugs.has(slug));

    const userConflicts = await client.query<{
      seed_id: string;
      seed_email: string;
      existing_id: string | null;
      existing_email: string | null;
      conflict_type: string;
    }>(
      `
        WITH seed_users(seed_id, seed_email) AS (
          SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(seed_id uuid, seed_email text)
        )
        SELECT
          seed_users.seed_id::text,
          seed_users.seed_email,
          users.id::text AS existing_id,
          users.email AS existing_email,
          CASE
            WHEN users.email = seed_users.seed_email AND users.id = seed_users.seed_id THEN 'same_email_same_id'
            WHEN users.email = seed_users.seed_email AND users.id <> seed_users.seed_id THEN 'same_email_different_id'
            WHEN users.id = seed_users.seed_id AND users.email <> seed_users.seed_email THEN 'same_id_different_email'
            ELSE 'none'
          END AS conflict_type
        FROM seed_users
        LEFT JOIN public.users
          ON users.email = seed_users.seed_email OR users.id = seed_users.seed_id
        WHERE users.id IS NOT NULL
        ORDER BY seed_users.seed_email
      `,
      [
        JSON.stringify(
          seed.users.map((user) => ({
            seed_id: user.id,
            seed_email: user.email.toLowerCase(),
          })),
        ),
      ],
    );

    const officeCheck = await client.query<{ slug: string }>(
      `
        SELECT slug
        FROM public.offices
        WHERE slug = ANY($1::text[]) AND is_active = true
      `,
      [[...new Set(seed.users.map((user) => user.officeSlug))]],
    );
    const foundOffices = new Set(officeCheck.rows.map((row) => row.slug));
    const missingOffices = [...new Set(seed.users.map((user) => user.officeSlug))].filter((slug) => !foundOffices.has(slug));

    const tenantSchemas = await client.query<{ schema_name: string }>(
      `
        SELECT schema_name
        FROM information_schema.schemata
        WHERE schema_name LIKE 'office\\_%' ESCAPE '\\'
        ORDER BY schema_name
      `,
    );

    const missingColumns: Array<{ schema: string; table: string; column: string }> = [];
    for (const { schema_name: schemaName } of tenantSchemas.rows) {
      for (const [tableName, columns] of Object.entries(REQUIRED_TENANT_TABLE_COLUMNS)) {
        const existingColumns = await client.query<{ column_name: string }>(
          `
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = $1 AND table_name = $2 AND column_name = ANY($3::text[])
          `,
          [schemaName, tableName, columns],
        );
        const foundColumns = new Set(existingColumns.rows.map((row) => row.column_name));
        for (const column of columns) {
          if (!foundColumns.has(column)) missingColumns.push({ schema: schemaName, table: tableName, column });
        }
      }
    }

    const cleanupTables = await client.query<{ table_schema: string; table_name: string }>(
      `
        SELECT table_schema, table_name
        FROM information_schema.tables
        WHERE table_schema LIKE 'office\\_%' ESCAPE '\\'
          AND table_name IN ('cleanup_skips', 'cleanup_assignments')
        ORDER BY table_schema, table_name
      `,
    );

    const hardUserConflicts = userConflicts.rows.filter((row) =>
      ["same_email_different_id", "same_id_different_email"].includes(row.conflict_type),
    );

    console.log(
      JSON.stringify(
        {
          stages: {
            required: REQUIRED_STAGE_SLUGS.length,
            found: stages.rows.length,
            missing: missingStages,
            rows: stages.rows,
          },
          users: {
            seedCount: seed.users.length,
            existingMatchesOrConflicts: userConflicts.rows,
            hardConflicts: hardUserConflicts,
            dryRunWouldPass: hardUserConflicts.length === 0 && missingOffices.length === 0,
            missingOffices,
          },
          cleanupSchema: {
            tenantSchemas: tenantSchemas.rows.map((row) => row.schema_name),
            missingColumns,
            cleanupTables: cleanupTables.rows,
          },
        },
        null,
        2,
      ),
    );

    if (missingStages.length > 0 || hardUserConflicts.length > 0 || missingOffices.length > 0 || missingColumns.length > 0) {
      process.exitCode = 2;
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
