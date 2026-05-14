import pg from "pg";

const connectionString = process.env.DATABASE_PUBLIC_URL ?? process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_PUBLIC_URL or DATABASE_URL is required");
}

const client = new pg.Client({
  connectionString,
  ssl: connectionString.includes("localhost") ? undefined : { rejectUnauthorized: false },
});

function ident(name) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Unsafe identifier: ${name}`);
  }
  return `"${name.replaceAll('"', '""')}"`;
}

await client.connect();
try {
  const schemasResult = await client.query(`
    SELECT nspname
    FROM pg_namespace
    WHERE nspname = 'public' OR nspname LIKE 'office\\_%' ESCAPE '\\'
    ORDER BY nspname
  `);
  const schemas = schemasResult.rows.map((row) => row.nspname);
  const output = [];

  for (const schema of schemas) {
    const hasProperties = await client.query("SELECT to_regclass($1) AS regclass", [`${schema}.properties`]);
    if (!hasProperties.rows[0]?.regclass) continue;

    const qSchema = ident(schema);
    const counts = await client.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE is_active = true)::int AS active,
        COUNT(*) FILTER (WHERE NULLIF(BTRIM(COALESCE(address, '')), '') IS NOT NULL)::int AS with_street,
        COUNT(*) FILTER (WHERE NULLIF(BTRIM(COALESCE(address, '')), '') IS NULL)::int AS missing_street,
        COUNT(*) FILTER (
          WHERE NULLIF(BTRIM(COALESCE(address, '')), '') IS NULL
            AND NULLIF(BTRIM(COALESCE(city, '')), '') IS NOT NULL
            AND NULLIF(BTRIM(COALESCE(state, '')), '') IS NOT NULL
        )::int AS city_state_only,
        COUNT(*) FILTER (
          WHERE is_active = true
            AND NULLIF(BTRIM(COALESCE(address, '')), '') IS NULL
        )::int AS active_missing_street
      FROM ${qSchema}.properties
    `);
    const samples = await client.query(`
      SELECT
        p.id,
        p.name,
        p.address,
        p.city,
        p.state,
        p.zip,
        p.company_id AS "companyId",
        c.name AS "companyName",
        p.is_active AS "isActive",
        p.hubspot_property_id AS "hubspotPropertyId",
        p.updated_at AS "updatedAt"
      FROM ${qSchema}.properties p
      LEFT JOIN ${qSchema}.companies c ON c.id = p.company_id
      WHERE NULLIF(BTRIM(COALESCE(p.address, '')), '') IS NULL
      ORDER BY p.is_active DESC, c.name NULLS LAST, p.city NULLS LAST, p.state NULLS LAST, p.name
      LIMIT 10
    `);
    output.push({
      schema,
      counts: counts.rows[0],
      incompleteSamples: samples.rows,
    });
  }

  console.log(JSON.stringify(output, null, 2));
} finally {
  await client.end();
}
