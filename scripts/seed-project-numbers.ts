/**
 * Dry-run-first project_number seed for the confirmed Dallas deals.
 *
 * Source of truth:
 *   .reviews/seed-baseline/seed-crosscheck.csv
 *
 * Scope:
 *   - Rows classified SAFE_TO_SEED in the cross-check CSV, except explicit Stage 3 exclusions.
 *   - One confirmed clean discrepancy row: Tides Park Lane -> 2-TPL5-010726.
 *
 * Safety:
 *   - Targets office_dallas.deals by UUID primary key only.
 *   - Revalidates live state before planning; rows whose current project_number is no longer
 *     NULL are excluded from the write plan.
 *   - Commit updates are guarded with WHERE project_number IS NULL, so this script never
 *     overwrites an existing project_number.
 *   - Commit mode requires SKIP_PROJECT_NUMBER_EMAIL=true and sets the transaction-local
 *     app.skip_project_number_email GUC before the first UPDATE.
 *   - A rollback/pre-state snapshot is written to <os-tmpdir>/seed-project-numbers-<ts>.json
 *     before any commit-mode updates are issued. Dry-run writes the same snapshot for review.
 *
 * Usage:
 *   node --import tsx scripts/seed-project-numbers.ts             # dry-run (default)
 *   node --import tsx scripts/seed-project-numbers.ts --dry-run   # dry-run
 *   SKIP_PROJECT_NUMBER_EMAIL=true node --import tsx scripts/seed-project-numbers.ts --commit
 */
import dotenv from "dotenv";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "pg";
import {
  applyProjectNumberEmailSkipSetting,
  shouldSkipProjectNumberEmail,
} from "./lib/project-number-notification.js";

const OFFICE_SCHEMA = "office_dallas";
const DEFAULT_CSV_RELATIVE_PATH = ".reviews/seed-baseline/seed-crosscheck.csv";
export const TIDES_PARK_LANE_DEAL_ID = "6d6d03b9-3f8b-5ded-9b32-342b1e39f635";
export const TIDES_PARK_LANE_PROJECT_NUMBER = "2-TPL5-010726";
export const EXCLUDED_STAGE3_DEAL_IDS = new Map<string, string>([
  [
    "9d43ff52-4791-5d8d-bad3-0606f7bd1425",
    "Stage 3 Carson consolidation excluded from this seed by operator instruction",
  ],
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface SeedProjectNumbersArgs {
  commit: boolean;
  csvPath: string | null;
}

export interface SeedCsvRow {
  rep: string;
  source_record_id: string;
  confirmed_project_number: string;
  deal_name: string;
  classification: string;
  crm_deal_id: string;
  crm_deal_number: string;
  crm_stage: string;
  crm_current_project_number: string;
  notes: string;
}

export interface SeedTarget {
  dealId: string;
  sourceRecordId: string;
  dealName: string;
  crmDealNumber: string;
  crmStage: string;
  rep: string;
  proposedProjectNumber: string;
  source: "SAFE_TO_SEED" | "TIDES_DISCREPANCY";
}

export interface SourceExcludedRow {
  dealId: string;
  dealName: string;
  proposedProjectNumber: string | null;
  classification: string;
  reason: string;
}

export interface LiveDealRow {
  id: string;
  deal_number: string | null;
  name: string | null;
  project_number: string | null;
}

export interface ExistingProjectNumberRow {
  id: string;
  deal_number: string | null;
  name: string | null;
  project_number: string;
}

export type PlanStatus =
  | "TO_WRITE"
  | "SKIP_NOT_FOUND"
  | "SKIP_EXISTING_PROJECT_NUMBER"
  | "SKIP_PROJECT_NUMBER_COLLISION";

export interface PlanRow {
  status: PlanStatus;
  target: SeedTarget;
  liveDeal: LiveDealRow | null;
  currentProjectNumber: string | null;
  collision: ExistingProjectNumberRow | null;
  reason: string | null;
}

export interface SeedPlan {
  mode: "DRY-RUN" | "COMMIT";
  csvPath: string;
  targetCount: number;
  toWrite: PlanRow[];
  skipped: PlanRow[];
  sourceExcluded: SourceExcludedRow[];
  rows: PlanRow[];
  snapshotPath: string;
}

export interface QueryableClient {
  query: (text: string, values?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }>;
}

export interface SeedProjectNumbersDeps {
  client: QueryableClient;
  argv: string[];
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  logger?: Pick<Console, "log" | "warn" | "error">;
  tmpDir?: string;
  readFile?: (filePath: string) => string;
  writeSnapshot?: (filePath: string, contents: string) => void;
}

function findFileFromWorktreeOrMain(startDir: string, relativePath: string): string | null {
  let dir = startDir;
  for (let depth = 0; depth < 10; depth += 1) {
    const candidate = path.join(dir, relativePath);
    if (fs.existsSync(candidate)) return candidate;

    const parts = dir.split(path.sep);
    const worktreesIndex = parts.lastIndexOf(".worktrees");
    if (worktreesIndex > 0) {
      const mainCheckout = parts.slice(0, worktreesIndex).join(path.sep) || path.sep;
      const mainCandidate = path.join(mainCheckout, relativePath);
      if (fs.existsSync(mainCandidate)) return mainCandidate;
    }

    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function loadEnvFromNearestFile(): void {
  const envFile = findFileFromWorktreeOrMain(path.dirname(fileURLToPath(import.meta.url)), ".env");
  if (envFile) dotenv.config({ path: envFile });
}

function connectionString(): string {
  const publicUrl = process.env.DATABASE_PUBLIC_URL?.trim();
  const privateUrl = process.env.DATABASE_URL?.trim();
  const selected = publicUrl || privateUrl;
  if (!selected) throw new Error("DATABASE_PUBLIC_URL or DATABASE_URL is required");
  if (!publicUrl && /railway\.internal/.test(selected)) {
    throw new Error("DATABASE_URL points at railway.internal. Set DATABASE_PUBLIC_URL in .env and retry.");
  }
  return selected;
}

export function parseSeedProjectNumbersArgs(argv: string[]): SeedProjectNumbersArgs {
  let commit = false;
  let dryRun = false;
  let csvPath: string | null = null;

  for (const arg of argv) {
    if (arg === "--commit") {
      commit = true;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg.startsWith("--csv=")) {
      csvPath = arg.slice("--csv=".length);
      if (!csvPath.trim()) throw new Error("--csv must not be empty");
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (commit && dryRun) {
    throw new Error("Use either --dry-run or --commit, not both");
  }

  return { commit, csvPath };
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const ch = line[index]!;
    if (ch === '"') {
      if (inQuotes && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === "," && !inQuotes) {
      cells.push(current);
      current = "";
      continue;
    }
    current += ch;
  }

  if (inQuotes) {
    throw new Error("Malformed CSV: unterminated quoted field");
  }

  cells.push(current);
  return cells;
}

export function parseSeedCrosscheckCsv(contents: string): SeedCsvRow[] {
  const lines = contents.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) return [];

  const headers = parseCsvLine(lines[0]!).map((header) => header.trim());
  const required = [
    "rep",
    "source_record_id",
    "confirmed_project_number",
    "deal_name",
    "classification",
    "crm_deal_id",
    "crm_deal_number",
    "crm_stage",
    "crm_current_project_number",
    "notes",
  ];
  for (const header of required) {
    if (!headers.includes(header)) {
      throw new Error(`CSV is missing required column: ${header}`);
    }
  }

  return lines.slice(1).map((line, rowIndex) => {
    const cells = parseCsvLine(line);
    const row: Record<string, string> = {};
    headers.forEach((header, index) => {
      row[header] = cells[index] ?? "";
    });
    if (cells.length > headers.length) {
      throw new Error(`CSV row ${rowIndex + 2} has more cells than headers`);
    }
    return row as unknown as SeedCsvRow;
  });
}

function normalizeProjectNumber(value: string): string {
  return value.trim();
}

function normalizedProjectNumberKey(value: string): string {
  return normalizeProjectNumber(value).toLowerCase();
}

export function buildSeedSelection(rows: SeedCsvRow[]): { targets: SeedTarget[]; excluded: SourceExcludedRow[] } {
  const targets = new Map<string, SeedTarget>();
  const excluded: SourceExcludedRow[] = [];

  for (const row of rows) {
    const classification = row.classification.trim();
    const isSafe = classification === "SAFE_TO_SEED";
    const isTides =
      row.crm_deal_id.trim().toLowerCase() === TIDES_PARK_LANE_DEAL_ID &&
      /2-TPL5-010726/i.test(row.notes ?? "");

    if (!isSafe && !isTides) continue;

    const dealId = row.crm_deal_id.trim();
    if (!UUID_RE.test(dealId)) {
      throw new Error(`Seed row has invalid UUID crm_deal_id: ${dealId || "(blank)"}`);
    }

    const proposedProjectNumber = isTides
      ? TIDES_PARK_LANE_PROJECT_NUMBER
      : normalizeProjectNumber(row.confirmed_project_number);
    if (!proposedProjectNumber) {
      throw new Error(`Seed row ${dealId} has no proposed project number`);
    }

    const explicitExclusionReason = EXCLUDED_STAGE3_DEAL_IDS.get(dealId.toLowerCase());
    if (explicitExclusionReason) {
      excluded.push({
        dealId,
        dealName: row.deal_name.trim(),
        proposedProjectNumber,
        classification,
        reason: explicitExclusionReason,
      });
      continue;
    }

    const target: SeedTarget = {
      dealId,
      sourceRecordId: row.source_record_id.trim(),
      dealName: row.deal_name.trim(),
      crmDealNumber: row.crm_deal_number.trim(),
      crmStage: row.crm_stage.trim(),
      rep: row.rep.trim(),
      proposedProjectNumber,
      source: isTides ? "TIDES_DISCREPANCY" : "SAFE_TO_SEED",
    };

    const existing = targets.get(dealId);
    if (existing && existing.proposedProjectNumber !== target.proposedProjectNumber) {
      throw new Error(
        `Duplicate seed target ${dealId} has conflicting project numbers: ` +
          `${existing.proposedProjectNumber} vs ${target.proposedProjectNumber}`
      );
    }
    targets.set(dealId, target);
  }

  return { targets: [...targets.values()], excluded };
}

export function buildSeedTargets(rows: SeedCsvRow[]): SeedTarget[] {
  return buildSeedSelection(rows).targets;
}

export function buildProjectNumberPlan(input: {
  mode: "DRY-RUN" | "COMMIT";
  csvPath: string;
  targets: SeedTarget[];
  liveDeals: LiveDealRow[];
  existingProjectNumbers: ExistingProjectNumberRow[];
  sourceExcluded?: SourceExcludedRow[];
  snapshotPath: string;
}): SeedPlan {
  const liveById = new Map(input.liveDeals.map((row) => [row.id.toLowerCase(), row]));
  const targetIds = new Set(input.targets.map((target) => target.dealId.toLowerCase()));
  const collisionsByProjectNumber = new Map<string, ExistingProjectNumberRow>();

  for (const row of input.existingProjectNumbers) {
    if (targetIds.has(row.id.toLowerCase())) continue;
    collisionsByProjectNumber.set(normalizedProjectNumberKey(row.project_number), row);
  }

  const rows: PlanRow[] = input.targets.map((target) => {
    const liveDeal = liveById.get(target.dealId.toLowerCase()) ?? null;
    if (!liveDeal) {
      return {
        status: "SKIP_NOT_FOUND",
        target,
        liveDeal: null,
        currentProjectNumber: null,
        collision: null,
        reason: "deal id not found in office_dallas.deals",
      };
    }

    const currentProjectNumber = liveDeal.project_number;
    if (currentProjectNumber !== null) {
      return {
        status: "SKIP_EXISTING_PROJECT_NUMBER",
        target,
        liveDeal,
        currentProjectNumber,
        collision: null,
        reason: "current project_number is no longer NULL",
      };
    }

    const collision = collisionsByProjectNumber.get(normalizedProjectNumberKey(target.proposedProjectNumber)) ?? null;
    if (collision) {
      return {
        status: "SKIP_PROJECT_NUMBER_COLLISION",
        target,
        liveDeal,
        currentProjectNumber,
        collision,
        reason: `proposed project_number already exists on deal ${collision.id}`,
      };
    }

    return {
      status: "TO_WRITE",
      target,
      liveDeal,
      currentProjectNumber,
      collision: null,
      reason: null,
    };
  });

  return {
    mode: input.mode,
    csvPath: input.csvPath,
    targetCount: input.targets.length,
    toWrite: rows.filter((row) => row.status === "TO_WRITE"),
    skipped: rows.filter((row) => row.status !== "TO_WRITE"),
    sourceExcluded: input.sourceExcluded ?? [],
    rows,
    snapshotPath: input.snapshotPath,
  };
}

const SELECT_LIVE_DEALS_SQL = `
  SELECT
    id::text AS id,
    deal_number,
    name,
    project_number
  FROM office_dallas.deals
  WHERE id = ANY($1::uuid[])
`;

const SELECT_EXISTING_PROJECT_NUMBERS_SQL = `
  SELECT
    id::text AS id,
    deal_number,
    name,
    project_number
  FROM office_dallas.deals
  WHERE project_number IS NOT NULL
    AND lower(btrim(project_number)) = ANY($1::text[])
`;

export const UPDATE_PROJECT_NUMBER_SQL = `
  UPDATE office_dallas.deals
     SET project_number = $2,
         updated_at = NOW()
   WHERE id = $1::uuid
     AND project_number IS NULL
   RETURNING id::text AS id, deal_number, name, project_number
`;

function defaultReadFile(filePath: string): string {
  return fs.readFileSync(filePath, "utf8");
}

function defaultWriteSnapshot(filePath: string, contents: string): void {
  fs.writeFileSync(filePath, contents);
}

function resolveCsvPath(explicitPath: string | null): string {
  if (explicitPath) return path.resolve(explicitPath);
  const found = findFileFromWorktreeOrMain(path.dirname(fileURLToPath(import.meta.url)), DEFAULT_CSV_RELATIVE_PATH);
  if (!found) {
    throw new Error(
      `Could not find ${DEFAULT_CSV_RELATIVE_PATH}. Pass --csv=/absolute/path/to/seed-crosscheck.csv.`
    );
  }
  return found;
}

function snapshotContents(input: {
  ranAt: string;
  csvPath: string;
  mode: "DRY-RUN" | "COMMIT";
  plan: SeedPlan;
}): string {
  return JSON.stringify(
    {
      ranAt: input.ranAt,
      mode: input.mode,
      officeSchema: OFFICE_SCHEMA,
      csvPath: input.csvPath,
      targetCount: input.plan.targetCount,
      toWriteCount: input.plan.toWrite.length,
      skippedCount: input.plan.skipped.length,
      sourceExcludedCount: input.plan.sourceExcluded.length,
      sourceExcluded: input.plan.sourceExcluded,
      rows: input.plan.rows.map((row) => ({
        status: row.status,
        reason: row.reason,
        dealId: row.target.dealId,
        dealNameFromCsv: row.target.dealName,
        liveDealName: row.liveDeal?.name ?? null,
        crmDealNumber: row.liveDeal?.deal_number ?? row.target.crmDealNumber,
        sourceRecordId: row.target.sourceRecordId,
        source: row.target.source,
        currentProjectNumber: row.currentProjectNumber,
        proposedProjectNumber: row.target.proposedProjectNumber,
        collisionDealId: row.collision?.id ?? null,
        collisionProjectNumber: row.collision?.project_number ?? null,
      })),
    },
    null,
    2
  );
}

async function buildLivePlan(input: {
  client: QueryableClient;
  csvPath: string;
  csvContents: string;
  mode: "DRY-RUN" | "COMMIT";
  snapshotPath: string;
}): Promise<SeedPlan> {
  const selection = buildSeedSelection(parseSeedCrosscheckCsv(input.csvContents));
  const { targets } = selection;
  if (targets.length === 0) {
    throw new Error("No seed targets found in CSV");
  }

  const dealIds = targets.map((target) => target.dealId);
  const proposedProjectNumbers = [...new Set(targets.map((target) => normalizedProjectNumberKey(target.proposedProjectNumber)))];

  const liveDeals = (await input.client.query(SELECT_LIVE_DEALS_SQL, [dealIds])).rows as LiveDealRow[];
  const existingProjectNumbers = (
    await input.client.query(SELECT_EXISTING_PROJECT_NUMBERS_SQL, [proposedProjectNumbers])
  ).rows as ExistingProjectNumberRow[];

  return buildProjectNumberPlan({
    mode: input.mode,
    csvPath: input.csvPath,
    targets,
    liveDeals,
    existingProjectNumbers,
    sourceExcluded: selection.excluded,
    snapshotPath: input.snapshotPath,
  });
}

function logPlan(logger: Pick<Console, "log" | "warn">, plan: SeedPlan): void {
  logger.log(`[${plan.mode}] seed-project-numbers`);
  logger.log(`CSV: ${plan.csvPath}`);
  logger.log(`Targets from CSV: ${plan.targetCount}`);
  logger.log(`Planned NULL -> project_number writes: ${plan.toWrite.length}`);
  logger.log(`Excluded/skipped on live revalidation: ${plan.skipped.length}`);
  logger.log(`Excluded by prompt scope before live validation: ${plan.sourceExcluded.length}`);

  for (const row of plan.rows) {
    const current = row.currentProjectNumber === null ? "NULL" : JSON.stringify(row.currentProjectNumber);
    const name = row.liveDeal?.name ?? row.target.dealName;
    const dealNumber = (row.liveDeal?.deal_number ?? row.target.crmDealNumber) || "NULL";
    const prefix = row.status === "TO_WRITE" ? "TO_WRITE" : row.status;
    logger.log(
      `${prefix} deal_id=${row.target.dealId} deal_number=${dealNumber} ` +
        `deal_name=${JSON.stringify(name)} current=${current} proposed=${row.target.proposedProjectNumber}` +
        (row.reason ? ` reason=${JSON.stringify(row.reason)}` : "")
    );
  }

  if (plan.skipped.length > 0) {
    logger.warn("Excluded rows must be reviewed before any separate write run:");
    for (const row of plan.skipped) {
      logger.warn(
        `  ${row.status}: deal_id=${row.target.dealId} proposed=${row.target.proposedProjectNumber} reason=${row.reason}`
      );
    }
  }
  if (plan.sourceExcluded.length > 0) {
    logger.warn("Rows excluded by explicit prompt scope:");
    for (const row of plan.sourceExcluded) {
      logger.warn(
        `  ${row.classification}: deal_id=${row.dealId} proposed=${row.proposedProjectNumber ?? "NULL"} ` +
          `deal_name=${JSON.stringify(row.dealName)} reason=${JSON.stringify(row.reason)}`
      );
    }
  }
  logger.log(`Snapshot: ${plan.snapshotPath}`);
}

export async function runSeedProjectNumbers(deps: SeedProjectNumbersDeps): Promise<SeedPlan> {
  const logger = deps.logger ?? console;
  const now = deps.now ?? (() => new Date());
  const tmpDir = deps.tmpDir ?? os.tmpdir();
  const readFile = deps.readFile ?? defaultReadFile;
  const writeSnapshot = deps.writeSnapshot ?? defaultWriteSnapshot;
  const env = deps.env ?? process.env;

  const args = parseSeedProjectNumbersArgs(deps.argv);
  const mode: "DRY-RUN" | "COMMIT" = args.commit ? "COMMIT" : "DRY-RUN";
  const csvPath = resolveCsvPath(args.csvPath);
  const csvContents = readFile(csvPath);
  const ranAt = now();
  const ts = ranAt.toISOString().replace(/[:.]/g, "-");
  const snapshotPath = path.join(tmpDir, `seed-project-numbers-${ts}.json`);

  const buildPlan = () =>
    buildLivePlan({
      client: deps.client,
      csvPath,
      csvContents,
      mode,
      snapshotPath,
    });

  if (mode === "DRY-RUN") {
    const plan = await buildPlan();
    writeSnapshot(snapshotPath, snapshotContents({ ranAt: ranAt.toISOString(), csvPath, mode, plan }));
    logPlan(logger, plan);
    logger.log("DRY-RUN complete. No database writes performed. Re-run with --commit only after operator approval.");
    logger.log("Commit mode requires SKIP_PROJECT_NUMBER_EMAIL=true so the project-number email trigger is suppressed.");
    return plan;
  }

  if (!shouldSkipProjectNumberEmail(env)) {
    throw new Error(
      "Commit mode requires SKIP_PROJECT_NUMBER_EMAIL=true. Refusing to write because the project-number email trigger would fire."
    );
  }

  await deps.client.query("BEGIN");
  try {
    await applyProjectNumberEmailSkipSetting(deps.client as never, env);
    const plan = await buildPlan();
    writeSnapshot(snapshotPath, snapshotContents({ ranAt: ranAt.toISOString(), csvPath, mode, plan }));
    logPlan(logger, plan);

    let updated = 0;
    for (const row of plan.toWrite) {
      const result = await deps.client.query(UPDATE_PROJECT_NUMBER_SQL, [
        row.target.dealId,
        row.target.proposedProjectNumber,
      ]);
      updated += result.rowCount ?? 0;
      if ((result.rowCount ?? 0) !== 1) {
        throw new Error(
          `Expected to update exactly one row for deal ${row.target.dealId}; updated ${result.rowCount ?? 0}. Rolling back.`
        );
      }
    }

    await deps.client.query("COMMIT");
    logger.log(`COMMIT complete. Updated ${updated} project_number values.`);
    logger.log(`Rollback/pre-state snapshot: ${snapshotPath}`);
    return plan;
  } catch (error) {
    try {
      await deps.client.query("ROLLBACK");
    } catch (rollbackError) {
      logger.error(
        `ROLLBACK failed after error: ${
          rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
        }`
      );
    }
    throw error;
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  loadEnvFromNearestFile();
  const client = new Client({
    connectionString: connectionString(),
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    await runSeedProjectNumbers({ client, argv });
  } finally {
    await client.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
