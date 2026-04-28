import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import pg from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_PATH = join(__dirname, "../migrations/0062_deal_signed_commissions.sql");
const MIGRATION_NAME = "0062_deal_signed_commissions.sql";

(async () => {
  const url = process.env.DATABASE_PUBLIC_URL;
  if (!url) {
    console.error("DATABASE_PUBLIC_URL not set");
    process.exit(1);
  }

  const client = new pg.Client({ connectionString: url });
  await client.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS public._migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) UNIQUE NOT NULL,
        executed_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    const { rows: existing } = await client.query(
      "SELECT id, executed_at FROM public._migrations WHERE name = $1",
      [MIGRATION_NAME]
    );
    if (existing.length > 0) {
      console.log(`SKIP: ${MIGRATION_NAME} already recorded (id=${existing[0].id}, executed_at=${existing[0].executed_at})`);
      process.exit(0);
    }

    const sql = readFileSync(SQL_PATH, "utf-8");
    console.log(`Applying ${MIGRATION_NAME}...`);
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("INSERT INTO public._migrations (name) VALUES ($1)", [MIGRATION_NAME]);
    await client.query("COMMIT");
    console.log(`OK: ${MIGRATION_NAME} applied and recorded.`);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("FAIL:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  } finally {
    await client.end();
  }
})();
