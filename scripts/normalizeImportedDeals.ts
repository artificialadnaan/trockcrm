import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), "../.env") });

const DEAL_SHAPE_FIELDS = [
  "deal_number",
  "source",
  "hubspot_deal_id",
  "bid_board_project_number",
  "workflow_route",
  "pipeline_type_snapshot",
  "pipeline_disposition",
  "office_code",
  "project_type",
  "project_type_id",
  "intended_project_number",
  "is_bid_board_owned",
  "is_read_only_mirror",
] as const;

const PLAN_CTE = `
  WITH project_type_by_code AS (
    SELECT id, code, lower(name) AS project_type
      FROM public.project_type_config
     WHERE is_active = true
       AND code IS NOT NULL
  ), parseable AS (
    SELECT d.id,
           d.deal_number,
           d.name,
           d.bid_board_project_number,
           substring(d.bid_board_project_number from '^DFW-([0-9]+)-') AS inferred_code,
           d.project_type AS current_project_type,
           d.project_type_id AS current_project_type_id,
           p.project_type AS next_project_type,
           p.id AS next_project_type_id
      FROM office_dallas.deals d
      JOIN project_type_by_code p
        ON p.code = substring(d.bid_board_project_number from '^DFW-([0-9]+)-')
     WHERE d.is_active = true
       AND d.deal_number ~ '^TR-[0-9]{4}$'
       AND d.bid_board_project_number IS NOT NULL
  )
`;

function connectionString(): string {
  const selected = process.env.DATABASE_PUBLIC_URL?.trim() || process.env.DATABASE_URL?.trim();
  if (!selected) throw new Error("DATABASE_PUBLIC_URL or DATABASE_URL is required");
  return selected;
}

function formatSampleRow(row: Record<string, unknown>) {
  return DEAL_SHAPE_FIELDS.map((field) => `${field}=${row[field] ?? "null"}`).join(" | ");
}

function csvEscape(value: unknown): string {
  const raw = String(value ?? "");
  return /[",\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
}

function writeAuditCsv(pathname: string, rows: Array<Record<string, unknown>>) {
  const header = [
    "timestamp",
    "action",
    "dealId",
    "dealNumber",
    "name",
    "reason",
    "currentProjectType",
    "currentProjectTypeId",
    "nextProjectType",
    "nextProjectTypeId",
    "bidBoardProjectNumber",
  ];
  const lines = [header.join(",")];
  for (const row of rows) lines.push(header.map((key) => csvEscape(row[key])).join(","));
  fs.writeFileSync(pathname, `${lines.join("\n")}\n`);
}

async function main() {
  const apply = process.argv.includes("--apply");
  const auditPathArg = process.argv.find((arg) => arg.startsWith("--audit-file="));
  const auditPath = auditPathArg?.split("=").slice(1).join("=") || `/tmp/imported-deal-normalization-${new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14)}.csv`;
  const client = new pg.Client({ connectionString: connectionString() });
  await client.connect();
  try {
    const newDeals = await client.query(`
      SELECT ${DEAL_SHAPE_FIELDS.join(", ")}, name, created_at
        FROM office_dallas.deals
       WHERE is_active = true
         AND deal_number LIKE 'TR-2026-%'
       ORDER BY created_at DESC
       LIMIT 5
    `);

    const importedDeals = await client.query(`
      SELECT ${DEAL_SHAPE_FIELDS.join(", ")}, name, created_at
        FROM office_dallas.deals
       WHERE is_active = true
         AND deal_number ~ '^TR-[0-9]{4}$'
       ORDER BY created_at DESC
       LIMIT 5
    `);

    const plan = await client.query(`${PLAN_CTE}
      SELECT *
        FROM parseable
       WHERE current_project_type IS NULL
         AND current_project_type_id IS NULL
       ORDER BY deal_number
    `);

    const skippedExisting = await client.query(`${PLAN_CTE}
      SELECT *
        FROM parseable
       WHERE current_project_type IS NOT NULL
          OR current_project_type_id IS NOT NULL
       ORDER BY deal_number
    `);

    const breakdown = await client.query(`${PLAN_CTE}
      SELECT next_project_type, inferred_code, count(*)::int AS count
        FROM parseable
       WHERE current_project_type IS NULL
         AND current_project_type_id IS NULL
       GROUP BY next_project_type, inferred_code
       ORDER BY inferred_code::int
    `);

    const totals = await client.query(`
      SELECT count(*)::int AS imported_active_total,
             count(*) FILTER (WHERE project_type_id IS NULL)::int AS missing_project_type_id,
             count(*) FILTER (WHERE project_type IS NULL)::int AS missing_project_type_text,
             count(*) FILTER (WHERE bid_board_project_number IS NULL)::int AS missing_bid_board_number,
             count(*) FILTER (WHERE bid_board_project_number IS NOT NULL AND substring(bid_board_project_number from '^DFW-([0-9]+)-') IS NULL)::int AS unparseable_bid_board_number,
             count(*) FILTER (WHERE bid_board_project_number IS NOT NULL AND substring(bid_board_project_number from '^DFW-([0-9]+)-') IS NOT NULL)::int AS parseable_bid_board_number
        FROM office_dallas.deals
       WHERE is_active = true
         AND deal_number ~ '^TR-[0-9]{4}$'
    `);

    const auditRows = [
      ...skippedExisting.rows.map((row) => ({
        timestamp: new Date().toISOString(),
        action: "skip",
        dealId: row.id,
        dealNumber: row.deal_number,
        name: row.name,
        reason: "skip_existing_value",
        currentProjectType: row.current_project_type,
        currentProjectTypeId: row.current_project_type_id,
        nextProjectType: row.next_project_type,
        nextProjectTypeId: row.next_project_type_id,
        bidBoardProjectNumber: row.bid_board_project_number,
      })),
    ];
    writeAuditCsv(auditPath, auditRows);

    console.log("IMPORTED DEAL NORMALIZATION DRY RUN");
    console.log(`apply=${apply}`);
    console.log(`auditCsv=${auditPath}`);
    console.log("");
    console.log("5 newest active new-shape deals:");
    newDeals.rows.forEach((row, index) => console.log(`  ${index + 1}. ${row.name} :: ${formatSampleRow(row)}`));
    console.log("");
    console.log("5 newest active imported deals:");
    importedDeals.rows.forEach((row, index) => console.log(`  ${index + 1}. ${row.name} :: ${formatSampleRow(row)}`));
    console.log("");
    console.log("Imported active totals:");
    console.table(totals.rows);
    console.log(`Normalization candidates: ${plan.rowCount}`);
    console.table(plan.rows.slice(0, 20));
    console.log(`Skipped existing project-type values: ${skippedExisting.rowCount}`);
    console.table(skippedExisting.rows);
    console.log("Breakdown:");
    console.table(breakdown.rows);

    if (apply) {
      await client.query("BEGIN");
      try {
        const result = await client.query(`${PLAN_CTE}
          UPDATE office_dallas.deals d
             SET project_type_id = p.next_project_type_id,
                 project_type = p.next_project_type,
                 updated_at = NOW()
            FROM parseable p
           WHERE d.id = p.id
             AND p.current_project_type IS NULL
             AND p.current_project_type_id IS NULL
           RETURNING d.id, d.deal_number
        `);
        await client.query("COMMIT");
        console.log(`APPLIED rows=${result.rowCount}`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
