import pg from "pg";

const TENANTS = ["office_atlanta", "office_dallas", "office_pwauditoffice"];
const MIGRATIONS = [
  "0060_company_verification_rejected.sql",
  "0061_deal_contract_signed_date.sql",
  "0062_deal_signed_commissions.sql",
];

(async () => {
  const url = process.env.DATABASE_PUBLIC_URL;
  if (!url) {
    console.error("DATABASE_PUBLIC_URL not set");
    process.exit(1);
  }
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();

    console.log("=== Migration tracking rows ===");
    const { rows: tracking } = await client.query(
      `SELECT name, executed_at FROM public._migrations
       WHERE name = ANY($1::text[])
       ORDER BY name`,
      [MIGRATIONS]
    );
    console.table(tracking);

    const missing = MIGRATIONS.filter(
      (m) => !tracking.find((row: any) => row.name === m)
    );
    if (missing.length > 0) {
      console.error(`MISSING tracking rows: ${missing.join(", ")}`);
      process.exit(1);
    }

    console.log("\n=== Per-tenant column/table existence checks ===");
    for (const schema of TENANTS) {
      console.log(`\n[${schema}]`);

      // 0060: companies.company_verification_status enum should accept 'rejected' value
      // (we check via the per-tenant rejection columns, since 0060 added those too)
      const { rows: rejColumns } = await client.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = $1
           AND table_name = 'companies'
           AND column_name IN ('company_verification_rejected_at', 'company_verification_rejected_by')
         ORDER BY column_name`,
        [schema]
      );
      console.log(
        `  0060: companies.company_verification_rejected_{at,by} columns: ${rejColumns.length}/2 present` +
          (rejColumns.length === 2 ? " ✓" : " ✗")
      );

      // 0061: deals.contract_signed_date column should exist
      const { rows: csdColumn } = await client.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = $1
           AND table_name = 'deals'
           AND column_name = 'contract_signed_date'`,
        [schema]
      );
      console.log(
        `  0061: deals.contract_signed_date column: ${csdColumn.length === 1 ? "present ✓" : "MISSING ✗"}`
      );

      // 0062: deal_signed_commissions table should exist
      const { rows: dscTable } = await client.query(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = $1 AND table_name = 'deal_signed_commissions'`,
        [schema]
      );
      console.log(
        `  0062: deal_signed_commissions table: ${dscTable.length === 1 ? "present ✓" : "MISSING ✗"}`
      );
    }
  } catch (err) {
    console.error("FAIL:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }
})();
