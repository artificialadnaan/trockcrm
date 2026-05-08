import "dotenv/config";

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";

const OUTPUT_DIR = "migration-snapshot";

async function writeJson(path: string, data: unknown) {
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  console.log(`[crm:migration-reference] wrote ${path}`);
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const stages = await client.query(`
      SELECT
        id,
        name,
        slug,
        workflow_family,
        display_order,
        is_active_pipeline,
        is_terminal,
        required_fields,
        required_documents,
        required_approvals
      FROM public.pipeline_stage_config
      WHERE is_active_pipeline = true
      ORDER BY workflow_family, display_order, slug
    `);

    const users = await client.query(`
      SELECT
        id,
        display_name,
        first_name,
        last_name,
        email,
        role,
        office_id,
        is_active
      FROM public.users
      WHERE is_active = true
      ORDER BY display_name, email
    `);

    await mkdir(OUTPUT_DIR, { recursive: true });
    await writeJson(join(OUTPUT_DIR, "crm-stages.json"), {
      exportedAt: new Date().toISOString(),
      source: "crm",
      stageCount: stages.rowCount,
      stages: stages.rows,
    });
    await writeJson(join(OUTPUT_DIR, "crm-users.json"), {
      exportedAt: new Date().toISOString(),
      source: "crm",
      userCount: users.rowCount,
      users: users.rows,
    });
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
