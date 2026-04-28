import { writeFileSync } from "node:fs";
import pg from "pg";

const databaseUrl = process.env.DATABASE_PUBLIC_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_PUBLIC_URL or DATABASE_URL is required");
}

const client = new pg.Client({ connectionString: databaseUrl });
const canonicalSlugs = [
  "exterior-renovation",
  "interior-renovation",
  "roofing",
  "service",
  "commercial",
  "hospitality",
  "emergency",
  "development",
  "residential",
];

function csvCell(value: unknown) {
  const text = value == null ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

async function main() {
  await client.connect();
  const schemas = await client.query<{ nspname: string }>(
    "SELECT nspname FROM pg_namespace WHERE nspname LIKE 'office\\_%' ESCAPE '\\' ORDER BY nspname"
  );
  const rows: Array<Record<string, unknown>> = [];

  for (const { nspname } of schemas.rows) {
    const result = await client.query(
      `
        SELECT
          $1::text AS tenant_schema,
          d.id AS deal_id,
          d.deal_number,
          d.name AS deal_name,
          d.project_type_id,
          pt.name AS project_type_name,
          pt.slug AS project_type_slug
        FROM ${pg.escapeIdentifier(nspname)}.deals d
        JOIN public.project_type_config pt ON pt.id = d.project_type_id
        WHERE pt.slug <> ALL($2::text[])
        ORDER BY d.updated_at DESC
      `,
      [nspname, canonicalSlugs]
    );
    rows.push(...result.rows);
  }

  const headers = [
    "tenant_schema",
    "deal_id",
    "deal_number",
    "deal_name",
    "project_type_id",
    "project_type_name",
    "project_type_slug",
  ];
  const csv = [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(",")),
  ].join("\n");

  writeFileSync("/tmp/deals-with-deprecated-project-type.csv", `${csv}\n`);
  await client.end();
}

main().catch(async (err) => {
  await client.end().catch(() => undefined);
  console.error(err);
  process.exit(1);
});
