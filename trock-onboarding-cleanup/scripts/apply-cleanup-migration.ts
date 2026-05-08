import "dotenv/config";

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";
import { assertWriteAllowed } from "../../scripts/lib/db-safety.js";

const migrationPath = resolve("trock-onboarding-cleanup/migrations/20260507_cleanup_onboarding_support.sql");

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  assertWriteAllowed(process.env.DATABASE_URL, process.argv, "cleanup:migrate");
  const sql = await readFile(migrationPath, "utf8");
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("COMMIT");
    console.log(`[cleanup:migrate] applied ${migrationPath}`);
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
