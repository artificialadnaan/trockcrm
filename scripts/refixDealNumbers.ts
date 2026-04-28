import "dotenv/config";
import { writeFileSync } from "node:fs";
import pg from "pg";
import {
  buildProjectNumber,
  generateJulianDate,
  getNextSuffix,
  parseProjectNumberSuffix,
  resolveOfficeCode,
  resolveProjectTypeCode,
} from "../server/src/services/projectNumber.js";

const DEFAULT_TENANTS = ["office_atlanta", "office_dallas", "office_pwauditoffice"];
const NEEDS_INPUT_PATH = "/tmp/deal-number-backfill-needs-input.csv";

type Candidate = {
  id: string;
  deal_number: string;
  created_at: Date | string | null;
  workflow_route: "normal" | "service";
  source_lead_id: string | null;
  lead_office_code: string | null;
  lead_project_type: string | null;
};

type PlannedUpdate = Candidate & {
  newDealNumber: string;
};

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

async function listTenantSchemas(client: pg.Client): Promise<string[]> {
  if (process.env.TENANT_SCHEMA) return [process.env.TENANT_SCHEMA];
  const { rows } = await client.query<{ schema_name: string }>(
    `SELECT schema_name
       FROM information_schema.schemata
      WHERE schema_name = ANY($1::text[])
      ORDER BY schema_name`,
    [DEFAULT_TENANTS]
  );
  return rows.map((row) => row.schema_name);
}

async function existingDealNumbers(client: pg.Client, schema: string): Promise<string[]> {
  const { rows } = await client.query<{ deal_number: string }>(
    `SELECT deal_number
       FROM ${quoteIdent(schema)}.deals
      WHERE deal_number IS NOT NULL
        AND deal_number !~ '^TR-[0-9]{4}-[0-9]{4}$'`
  );
  return rows.map((row) => row.deal_number);
}

function csvCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function needsInput(candidate: Candidate): boolean {
  return !candidate.source_lead_id || !candidate.lead_office_code || !candidate.lead_project_type;
}

function nextDealNumber(candidate: Candidate, existing: Set<string>): string {
  const createdAt = candidate.created_at ? new Date(candidate.created_at) : new Date();
  const julianDate = generateJulianDate(createdAt);
  const highestSuffix =
    [...existing]
      .map((dealNumber) => parseProjectNumberSuffix(dealNumber, julianDate))
      .filter((value): value is string => Boolean(value))
      .sort((left, right) => right.localeCompare(left))[0] ?? null;
  const dealNumber = buildProjectNumber({
    officeCode: resolveOfficeCode(candidate.lead_office_code),
    projectTypeCode: resolveProjectTypeCode({
      projectType: candidate.lead_project_type,
      workflowRoute: candidate.workflow_route,
    }),
    createdAt,
    suffix: getNextSuffix(highestSuffix),
  });
  existing.add(dealNumber);
  return dealNumber;
}

function highestSuffixByDay(existing: Set<string>): Map<string, string> {
  const result = new Map<string, string>();
  for (const dealNumber of existing) {
    const match = dealNumber.match(/^(?:dfw|atl)-[1-9]-(\d{5})-([a-z]+)$/i);
    if (!match) continue;
    const [, julianDate, suffix] = match;
    const current = result.get(julianDate);
    if (!current || suffix.localeCompare(current) > 0) {
      result.set(julianDate, suffix);
    }
  }
  return result;
}

async function main() {
  const connectionString = process.env.DATABASE_PUBLIC_URL ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_PUBLIC_URL or DATABASE_URL is required");
  }

  const dryRun = process.env.DRY_RUN !== "false";
  const client = new pg.Client({ connectionString });
  await client.connect();

  const needsInputRows: Candidate[] = [];
  const summary: Array<{ schema: string; candidates: number; planned: number; skipped: number }> = [];

  try {
    const schemas = await listTenantSchemas(client);
    const globalExisting = new Set<string>();
    for (const schema of schemas) {
      for (const dealNumber of await existingDealNumbers(client, schema)) {
        globalExisting.add(dealNumber);
      }
    }

    for (const schema of schemas) {
      const quotedSchema = quoteIdent(schema);
      const { rows } = await client.query<Candidate>(
        `SELECT d.id,
                d.deal_number,
                d.created_at,
                d.workflow_route,
                d.source_lead_id,
                l.office_code AS lead_office_code,
                l.project_type AS lead_project_type
           FROM ${quotedSchema}.deals d
      LEFT JOIN ${quotedSchema}.leads l ON l.id = d.source_lead_id
          WHERE d.deal_number ~ '^TR-[0-9]{4}-[0-9]{4}$'
          ORDER BY d.created_at ASC, d.id ASC`
      );

      const planned: PlannedUpdate[] = [];
      for (const candidate of rows) {
        if (needsInput(candidate)) {
          needsInputRows.push(candidate);
          continue;
        }
        planned.push({ ...candidate, newDealNumber: nextDealNumber(candidate, globalExisting) });
      }

      summary.push({
        schema,
        candidates: rows.length,
        planned: planned.length,
        skipped: rows.length - planned.length,
      });

      console.log(`\n[${schema}] ${dryRun ? "would update" : "updating"} ${planned.length} old deal numbers`);
      console.table(
        planned.map((row) => ({
          id: row.id,
          oldDealNumber: row.deal_number,
          newDealNumber: row.newDealNumber,
          officeCode: row.lead_office_code,
          projectType: row.lead_project_type,
        }))
      );

      if (!dryRun && planned.length > 0) {
        await client.query("BEGIN");
        try {
          for (const row of planned) {
            await client.query(
              `UPDATE ${quotedSchema}.deals
                  SET deal_number = $1,
                      office_code = $2,
                      updated_at = NOW()
                WHERE id = $3::uuid
                  AND deal_number = $4`,
              [row.newDealNumber, resolveOfficeCode(row.lead_office_code), row.id, row.deal_number]
            );
          }
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK").catch(() => {});
          throw error;
        }
      }
    }

    if (!dryRun) {
      for (const [julianDate, suffix] of highestSuffixByDay(globalExisting)) {
        await client.query(
          `INSERT INTO public.deal_number_daily_sequences (day_key, last_suffix)
           VALUES ($1, $2)
           ON CONFLICT (day_key) DO UPDATE
             SET last_suffix = EXCLUDED.last_suffix,
                 updated_at = NOW()`,
          [julianDate, suffix]
        );
      }
    }
  } finally {
    await client.end();
  }

  const csv = [
    [
      "id",
      "deal_number",
      "source_lead_id",
      "lead_office_code",
      "lead_project_type",
      "created_at",
    ].join(","),
    ...needsInputRows.map((row) =>
      [
        row.id,
        row.deal_number,
        row.source_lead_id,
        row.lead_office_code,
        row.lead_project_type,
        row.created_at,
      ].map(csvCell).join(",")
    ),
  ].join("\n");
  writeFileSync(NEEDS_INPUT_PATH, `${csv}\n`, "utf8");

  console.log("\nSummary");
  console.table(summary);
  console.log(`Needs input CSV: ${NEEDS_INPUT_PATH} (${needsInputRows.length} rows)`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
