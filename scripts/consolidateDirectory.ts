import pg from "pg";
import dotenv from "dotenv";
import { drizzle } from "drizzle-orm/node-postgres";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import * as schema from "../shared/src/schema/index.js";
import { scanDirectoryDuplicates } from "../server/src/services/directoryDedup.js";

dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), "../.env") });

const DATABASE_URL = process.env.DATABASE_PUBLIC_URL ?? process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const TENANT_SCHEMAS = (process.env.TENANT_SCHEMA ?? "office_atlanta,office_dallas,office_pwauditoffice")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const dryRun = process.env.DRY_RUN !== "false";
const autoMerge = process.env.AUTO_MERGE === "true";
const limit = Number(process.env.LIMIT ?? 1000);

async function main() {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();

  try {
    console.log(`Directory consolidation ${dryRun ? "dry-run" : "apply"} start`);
    console.log(`Tenants: ${TENANT_SCHEMAS.join(", ")}`);
    console.log(`Auto-merge: ${autoMerge ? "enabled" : "disabled"}`);

    for (const tenantSchema of TENANT_SCHEMAS) {
      await client.query("BEGIN");
      await client.query("SELECT set_config('search_path', $1, true)", [`${tenantSchema},public`]);
      const tenantDb = drizzle(client, { schema });
      const summary = await scanDirectoryDuplicates(tenantDb, { autoMerge: autoMerge && !dryRun, limit });
      console.log(`${tenantSchema}:`, summary);
      if (dryRun) {
        await client.query("ROLLBACK");
      } else {
        await client.query("COMMIT");
      }
    }
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
