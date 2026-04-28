import pg from "pg";
import {
  buildProjectNumber,
  generateJulianDate,
  getNextSuffix,
  resolveOfficeCode,
  resolveProjectTypeCode,
} from "../server/src/services/projectNumber.js";

const DEFAULT_TENANTS = ["office_atlanta", "office_dallas", "office_pwauditoffice"];

type Candidate = {
  id: string;
  name: string;
  workflow_route: "normal" | "service";
  bid_board_office: string | null;
  region_classification: string | null;
  property_state: string | null;
  created_at: Date | string | null;
};

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function parseSuffix(projectNumber: string, julianDate: string): string | null {
  const match = projectNumber.match(new RegExp(`^[A-Z]{2,4}-[1-9]-${julianDate}-([a-z]+)$`, "i"));
  return match?.[1]?.toLowerCase() ?? null;
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

async function existingProjectNumbers(client: pg.Client, schema: string): Promise<string[]> {
  const { rows } = await client.query<{ bid_board_project_number: string }>(
    `SELECT bid_board_project_number
       FROM ${quoteIdent(schema)}.deals
      WHERE bid_board_project_number IS NOT NULL`
  );
  return rows.map((row) => row.bid_board_project_number);
}

function nextProjectNumber(candidate: Candidate, existing: Set<string>): string {
  const createdAt = candidate.created_at ? new Date(candidate.created_at) : new Date();
  const julianDate = generateJulianDate(createdAt);
  const highestSuffix =
    [...existing]
      .map((projectNumber) => parseSuffix(projectNumber, julianDate))
      .filter((value): value is string => Boolean(value))
      .sort((left, right) => right.localeCompare(left))[0] ?? null;
  const suffix = getNextSuffix(highestSuffix);
  const projectNumber = buildProjectNumber({
    officeCode: resolveOfficeCode(
      candidate.bid_board_office ?? candidate.region_classification ?? candidate.property_state
    ),
    projectTypeCode: resolveProjectTypeCode({ workflowRoute: candidate.workflow_route }),
    createdAt,
    suffix,
  });
  existing.add(projectNumber);
  return projectNumber;
}

async function main() {
  const connectionString = process.env.DATABASE_PUBLIC_URL ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_PUBLIC_URL or DATABASE_URL is required");
  }

  const dryRun = process.env.DRY_RUN !== "false";
  const client = new pg.Client({ connectionString });
  await client.connect();

  try {
    const schemas = await listTenantSchemas(client);
    for (const schema of schemas) {
      const quotedSchema = quoteIdent(schema);
      const { rows } = await client.query<Candidate>(
        `SELECT d.id,
                d.name,
                d.workflow_route,
                d.bid_board_office,
                d.region_classification,
                d.property_state,
                d.created_at
           FROM ${quotedSchema}.deals d
           JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
          WHERE d.bid_board_project_number IS NULL
            AND psc.slug = 'opportunity'
          ORDER BY d.created_at ASC, d.id ASC`
      );

      const existing = new Set(await existingProjectNumbers(client, schema));
      const plan = rows.map((candidate) => ({
        ...candidate,
        projectNumber: nextProjectNumber(candidate, existing),
      }));

      console.log(`\n[${schema}] ${dryRun ? "would backfill" : "backfilling"} ${plan.length} deal project numbers`);
      console.table(
        plan.map((row) => ({
          id: row.id,
          name: row.name,
          workflowRoute: row.workflow_route,
          projectNumber: row.projectNumber,
        }))
      );

      if (!dryRun && plan.length > 0) {
        await client.query("BEGIN");
        try {
          for (const row of plan) {
            await client.query(
              `UPDATE ${quotedSchema}.deals
                  SET bid_board_project_number = $1,
                      updated_at = NOW()
                WHERE id = $2::uuid
                  AND bid_board_project_number IS NULL`,
              [row.projectNumber, row.id]
            );
          }
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK").catch(() => {});
          throw error;
        }
      }
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
