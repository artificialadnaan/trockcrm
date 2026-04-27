import pg from "pg";

(async () => {
  const url = process.env.DATABASE_PUBLIC_URL;
  if (!url) { console.error("missing url"); process.exit(1); }
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
    const { rows } = await client.query(`
      SELECT n.nspname AS schema, c.conname, c.confdeltype,
        (SELECT a.attname FROM pg_attribute a WHERE a.attrelid = c.conrelid AND a.attnum = c.conkey[1]) AS local_col,
        (SELECT a.attname FROM pg_attribute a WHERE a.attrelid = c.confrelid AND a.attnum = c.confkey[1]) AS foreign_col,
        cf.relname AS foreign_table
      FROM pg_constraint c
      JOIN pg_namespace n ON n.oid = c.connamespace
      JOIN pg_class cf ON cf.oid = c.confrelid
      WHERE c.contype = 'f'
        AND c.conrelid::regclass::text LIKE '%.deal_signed_commissions'
      ORDER BY n.nspname, c.conname
    `);
    console.log("FK delete actions (a=NO ACTION, r=RESTRICT, c=CASCADE, n=SET NULL, d=SET DEFAULT):");
    console.table(rows);
  } catch (err) {
    console.error("FAIL:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }
})();
