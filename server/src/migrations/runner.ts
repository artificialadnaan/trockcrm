import { readdirSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import pg from "pg";
import dotenv from "dotenv";

dotenv.config({
  path: join(dirname(fileURLToPath(import.meta.url)), "../../../.env"),
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "../../../migrations");

async function runMigrations(): Promise<void> {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    // Create migrations tracking table
    await client.query(`
      CREATE TABLE IF NOT EXISTS public._migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) UNIQUE NOT NULL,
        executed_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Read migration files sorted alphabetically
    const migrationFiles = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    for (const file of migrationFiles) {
      // Check if already run
      const { rows } = await client.query(
        "SELECT id FROM public._migrations WHERE name = $1",
        [file]
      );
      if (rows.length > 0) {
        console.log(`Skipping ${file} (already executed)`);
        continue;
      }

      console.log(`Running ${file}...`);
      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf-8");
      await client.query(sql);

      await client.query(
        "INSERT INTO public._migrations (name) VALUES ($1)",
        [file]
      );
      console.log(`Completed ${file}`);
    }

    console.log("All migrations complete.");
  } catch (err) {
    console.error("Migration failed:", err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

runMigrations();
