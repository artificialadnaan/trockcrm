import pg from "pg";

const TENANTS = ["office_atlanta", "office_dallas", "office_pwauditoffice"];

const DEAL_COLUMNS = [
  "bid_board_estimator",
  "bid_board_office",
  "bid_board_status",
  "bid_board_sales_price_per_area",
  "bid_board_project_cost",
  "bid_board_profit_margin_pct",
  "bid_board_total_sales",
  "bid_board_created_at",
  "bid_board_due_date",
  "bid_board_customer_name",
  "bid_board_customer_contact_raw",
  "bid_board_project_number",
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
    console.log("=== Migration tracking row ===");
    const { rows: trackRows } = await client.query(
      "SELECT name, executed_at FROM public._migrations WHERE name = $1",
      ["0063_bid_board_project_ingestion.sql"]
    );
    console.table(trackRows);
    if (trackRows.length !== 1) throw new Error("0063 migration tracking row missing");

    for (const schema of TENANTS) {
      console.log(`\n=== ${schema} ===`);

      const { rows: cols } = await client.query(
        `SELECT column_name, data_type
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'deals'
           AND column_name = ANY($2)
         ORDER BY column_name`,
        [schema, DEAL_COLUMNS]
      );
      console.table(cols);
      if (cols.length !== DEAL_COLUMNS.length) {
        throw new Error(`${schema}.deals is missing Bid Board ingestion columns`);
      }

      const { rows: runTable } = await client.query(
        `SELECT table_schema, table_name
         FROM information_schema.tables
         WHERE table_schema = $1 AND table_name = 'bid_board_sync_runs'`,
        [schema]
      );
      if (runTable.length !== 1) throw new Error(`${schema}.bid_board_sync_runs missing`);
      console.log(`  Table exists: ${schema}.bid_board_sync_runs`);

      const { rows: idx } = await client.query(
        `SELECT indexname
         FROM pg_indexes
         WHERE schemaname = $1
           AND tablename IN ('deals', 'bid_board_sync_runs')
           AND indexname IN (
             'deals_bid_board_project_number_idx',
             'deals_bid_board_name_created_idx',
             'bid_board_sync_runs_created_idx',
             'bid_board_sync_runs_payload_hash_idx'
           )
         ORDER BY indexname`,
        [schema]
      );
      console.table(idx);
      if (idx.length !== 4) throw new Error(`${schema} is missing one or more 0063 indexes`);
    }
  } catch (err) {
    console.error("FAIL:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }
})();
