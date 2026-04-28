import pg from "pg";

const TENANTS = ["office_atlanta", "office_dallas", "office_pwauditoffice"];

(async () => {
  const url = process.env.DATABASE_PUBLIC_URL;
  if (!url) {
    console.error("DATABASE_PUBLIC_URL not set");
    process.exit(1);
  }

  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
    console.log("=== Migration tracking row ===");
    const { rows: trackRows } = await client.query(
      "SELECT name, executed_at FROM public._migrations WHERE name = $1",
      ["0064_hubspot_refresh_audit.sql"]
    );
    console.table(trackRows);
    if (trackRows.length !== 1) throw new Error("0064 migration tracking row missing");

    for (const schema of TENANTS) {
      console.log(`\n=== ${schema} ===`);
      const { rows: cols } = await client.query(
        `SELECT column_name, data_type
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'deals'
           AND column_name = 'last_synced_from_hubspot_at'`,
        [schema]
      );
      console.table(cols);
      if (cols.length !== 1) throw new Error(`${schema}.deals.last_synced_from_hubspot_at missing`);

      const { rows: idx } = await client.query(
        `SELECT indexname
         FROM pg_indexes
         WHERE schemaname = $1
           AND tablename = 'deals'
           AND indexname = 'deals_last_synced_from_hubspot_idx'`,
        [schema]
      );
      console.table(idx);
      if (idx.length !== 1) throw new Error(`${schema} is missing deals_last_synced_from_hubspot_idx`);
    }

    const { rows: auditTable } = await client.query(
      `SELECT table_schema, table_name
       FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'hubspot_refresh_log'`
    );
    if (auditTable.length !== 1) throw new Error("public.hubspot_refresh_log missing");
    console.log("\nTable exists: public.hubspot_refresh_log");

    const { rows: auditIndexes } = await client.query(
      `SELECT indexname
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename = 'hubspot_refresh_log'
         AND indexname IN ('hubspot_refresh_log_run_idx', 'hubspot_refresh_log_created_idx')
       ORDER BY indexname`
    );
    console.table(auditIndexes);
    if (auditIndexes.length !== 2) throw new Error("public.hubspot_refresh_log is missing indexes");
  } catch (err) {
    console.error("FAIL:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }
})();
