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
      ["0062_deal_signed_commissions.sql"]
    );
    console.table(trackRows);

    for (const schema of TENANTS) {
      console.log(`\n=== ${schema} ===`);

      const { rows: tableRows } = await client.query(
        `SELECT table_schema, table_name
         FROM information_schema.tables
         WHERE table_schema = $1 AND table_name = 'deal_signed_commissions'`,
        [schema]
      );
      if (tableRows.length === 0) {
        console.log(`  TABLE MISSING in ${schema}`);
        continue;
      }
      console.log(`  Table exists: ${schema}.deal_signed_commissions`);

      const { rows: cols } = await client.query(
        `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'deal_signed_commissions'
         ORDER BY ordinal_position`,
        [schema]
      );
      console.table(cols);

      const { rows: constraints } = await client.query(
        `SELECT conname, contype
         FROM pg_constraint
         WHERE conrelid = ($1 || '.deal_signed_commissions')::regclass
         ORDER BY contype, conname`,
        [schema]
      );
      console.log("  Constraints:");
      console.table(constraints);

      const { rows: idx } = await client.query(
        `SELECT indexname, indexdef
         FROM pg_indexes
         WHERE schemaname = $1 AND tablename = 'deal_signed_commissions'
         ORDER BY indexname`,
        [schema]
      );
      console.log("  Indexes:");
      console.table(idx);
    }
  } catch (err) {
    console.error("FAIL:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }
})();
