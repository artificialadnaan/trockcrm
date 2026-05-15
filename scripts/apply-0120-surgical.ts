import pg from "pg";
import {
  AUDIT_LOG_PERFORMANCE_MIGRATION,
  runAuditLogPerformanceIndexMigration,
} from "../server/src/migrations/audit-log-performance-indexes.js";

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
      [AUDIT_LOG_PERFORMANCE_MIGRATION]
    );
    if (existing.length > 0) {
      console.log(
        `SKIP: ${AUDIT_LOG_PERFORMANCE_MIGRATION} already recorded ` +
        `(id=${existing[0].id}, executed_at=${existing[0].executed_at})`
      );
      process.exit(0);
    }

    console.log(`Applying ${AUDIT_LOG_PERFORMANCE_MIGRATION}...`);
    await runAuditLogPerformanceIndexMigration(client);
    await client.query(
      "INSERT INTO public._migrations (name) VALUES ($1)",
      [AUDIT_LOG_PERFORMANCE_MIGRATION]
    );
    console.log(`OK: ${AUDIT_LOG_PERFORMANCE_MIGRATION} applied and recorded.`);
  } catch (err) {
    console.error("FAIL:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  } finally {
    await client.end();
  }
})();
