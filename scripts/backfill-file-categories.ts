import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { FILE_CATEGORIES } from "@trock-crm/shared/types";
import { inferFileCategory } from "../server/src/modules/files/infer-category.js";

/**
 * One-off backfill: re-categorize existing files.category='other' rows using the same inferFileCategory
 * inference as the upload path, so the Files page type-filters populate for already-uploaded documents.
 *
 * Safety invariants:
 *  - other-only: only rows with category='other' are ever considered, and the UPDATE re-checks
 *    `AND category='other'` so a concurrently/correctly-set category is never clobbered.
 *  - per-office: each tenant schema is processed independently via search_path.
 *  - dry-run by default: pass --commit to write. Dry-run prints the full plan + before census.
 *  - idempotent: a second run finds nothing to do (rows it already typed are no longer 'other'; rows
 *    that infer to 'other' are skipped).
 *  - auditable/reversible: every committed run writes a JSON snapshot (id, from, to) per office to the
 *    OS temp dir (owner-only) so changes can be reviewed or reverted.
 *
 * Usage:
 *   npm run script scripts/backfill-file-categories.ts            # dry-run (default)
 *   npm run script scripts/backfill-file-categories.ts --commit   # apply
 */

const TENANT_SCHEMAS = ["office_dallas", "office_atlanta", "office_pwauditoffice"] as const;
type TenantSchema = (typeof TENANT_SCHEMAS)[number];

const VALID_CATEGORIES = new Set<string>(FILE_CATEGORIES);

export type BackfillMode = "dry-run" | "commit";
export interface BackfillArgs {
  mode: BackfillMode;
}

export function parseBackfillArgs(argv = process.argv): BackfillArgs {
  const args = argv.slice(2);
  const hasCommit = args.includes("--commit");
  const hasDryRun = args.includes("--dry-run");
  if (hasCommit && hasDryRun) {
    throw new Error("Choose exactly one of --dry-run or --commit");
  }
  return { mode: hasCommit ? "commit" : "dry-run" };
}

/** A row fetched from files where category='other'. */
export interface OtherFileRow {
  id: string;
  originalFilename: string | null;
  mimeType: string | null;
  subcategory: string | null;
  folderPath: string | null;
  changeOrderId: string | null;
}

export interface PlannedChange {
  id: string;
  from: "other";
  to: string;
}

export interface BackfillPlan {
  willUpdate: PlannedChange[];
  skipped: number;
  /** count of planned changes per target category (for the dry-run summary) */
  byTarget: Record<string, number>;
}

/**
 * Pure planner: maps each category='other' row through inferFileCategory and keeps only the rows that
 * infer to a different (and valid, non-'other') category. Defensive: ignores any non-enum result.
 */
export function buildBackfillPlan(rows: OtherFileRow[]): BackfillPlan {
  const willUpdate: PlannedChange[] = [];
  const byTarget: Record<string, number> = {};
  let skipped = 0;
  for (const row of rows) {
    const inferred = inferFileCategory({
      filename: row.originalFilename,
      mimeType: row.mimeType,
      subcategory: row.subcategory,
      folderPath: row.folderPath,
      changeOrderId: row.changeOrderId,
    });
    // Skip when inference yields 'other' (no-op → idempotent) or — defensively — anything not a valid
    // enum member (inferFileCategory is typed to never do this, but the raw UPDATE must stay safe).
    if (inferred === "other" || !VALID_CATEGORIES.has(inferred)) {
      skipped += 1;
      continue;
    }
    willUpdate.push({ id: row.id, from: "other", to: inferred });
    byTarget[inferred] = (byTarget[inferred] ?? 0) + 1;
  }
  return { willUpdate, skipped, byTarget };
}

/** Minimal query interface so the planner/runner can be unit-tested with a fake client. */
export interface QueryClient {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

async function setSchema(client: QueryClient, schema: TenantSchema): Promise<void> {
  // schema is from a fixed allowlist (TENANT_SCHEMAS) — safe to interpolate as a quoted identifier.
  await client.query(`SET search_path TO "${schema}", public`);
}

export async function censusByCategory(
  client: QueryClient,
  schema: TenantSchema
): Promise<Record<string, number>> {
  await setSchema(client, schema);
  const { rows } = await client.query(
    "SELECT category, count(*)::int AS count FROM files WHERE is_active = true GROUP BY category ORDER BY count DESC"
  );
  const census: Record<string, number> = {};
  for (const row of rows) census[row.category] = Number(row.count);
  return census;
}

export async function fetchOtherFiles(client: QueryClient, schema: TenantSchema): Promise<OtherFileRow[]> {
  await setSchema(client, schema);
  const { rows } = await client.query(
    `SELECT id,
            original_filename AS "originalFilename",
            mime_type        AS "mimeType",
            subcategory,
            folder_path      AS "folderPath",
            change_order_id  AS "changeOrderId"
       FROM files
      WHERE category = 'other' AND is_active = true`
  );
  return rows as OtherFileRow[];
}

export interface SchemaResult {
  schema: TenantSchema;
  before: Record<string, number>;
  plan: BackfillPlan;
  applied: number;
  after?: Record<string, number>;
}

export async function runBackfillForSchema(
  client: QueryClient,
  schema: TenantSchema,
  mode: BackfillMode
): Promise<SchemaResult> {
  const before = await censusByCategory(client, schema);
  const rows = await fetchOtherFiles(client, schema);
  const plan = buildBackfillPlan(rows);

  let applied = 0;
  if (mode === "commit" && plan.willUpdate.length > 0) {
    await client.query("BEGIN");
    try {
      for (const change of plan.willUpdate) {
        // `AND category = 'other'` makes the write idempotent and guarantees we never overwrite a
        // category that has since been set to something other than 'other'.
        const res = await client.query(
          "UPDATE files SET category = $1::file_category, updated_at = now() WHERE id = $2 AND category = 'other'",
          [change.to, change.id]
        );
        applied += res.rowCount ?? 0;
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    }
  }

  const after = mode === "commit" ? await censusByCategory(client, schema) : undefined;
  return { schema, before, plan, applied, after };
}

/** Writes an owner-only JSON audit snapshot of the planned/applied changes for reversibility. */
export function writeBackupSnapshot(result: SchemaResult, mode: BackfillMode, stamp: string): string | null {
  if (result.plan.willUpdate.length === 0) return null;
  const backupPath = path.join(
    os.tmpdir(),
    `trockcrm-file-category-backfill-${mode}-${result.schema}-${stamp}.json`
  );
  fs.writeFileSync(
    backupPath,
    `${JSON.stringify({ schema: result.schema, mode, changes: result.plan.willUpdate }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
  return backupPath;
}

function resolveDatabaseUrl(): string {
  const url =
    process.env.CRM_DATABASE_URL?.trim() ||
    process.env.DATABASE_PUBLIC_URL?.trim() ||
    process.env.DATABASE_URL?.trim() ||
    "";
  if (!url) {
    throw new Error("Missing database URL. Set CRM_DATABASE_URL, DATABASE_PUBLIC_URL, or DATABASE_URL.");
  }
  return url;
}

export async function main(argv = process.argv): Promise<void> {
  const { mode } = parseBackfillArgs(argv);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  console.log(`[file-category-backfill] mode=${mode}`);

  const client = new pg.Client({
    connectionString: resolveDatabaseUrl(),
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  let totalPlanned = 0;
  let totalApplied = 0;
  try {
    for (const schema of TENANT_SCHEMAS) {
      const result = await runBackfillForSchema(client, schema, mode);
      totalPlanned += result.plan.willUpdate.length;
      totalApplied += result.applied;

      console.log(`\n=== ${schema} ===`);
      console.log("  before:", JSON.stringify(result.before));
      console.log(
        `  planned: ${result.plan.willUpdate.length} (skipped ${result.plan.skipped}) → ${JSON.stringify(result.plan.byTarget)}`
      );
      if (mode === "commit") {
        const snapshot = writeBackupSnapshot(result, mode, stamp);
        console.log(`  applied: ${result.applied}`);
        console.log("  after:", JSON.stringify(result.after));
        if (snapshot) console.log(`  audit snapshot: ${snapshot}`);
      } else {
        for (const change of result.plan.willUpdate) {
          console.log(`    ${change.id}: other → ${change.to}`);
        }
      }
    }
    console.log(
      `\n[file-category-backfill] ${mode === "commit" ? "applied" : "would update"} ${mode === "commit" ? totalApplied : totalPlanned} file(s) across ${TENANT_SCHEMAS.length} office(s).`
    );
    if (mode !== "commit") {
      console.log("[file-category-backfill] dry-run only — re-run with --commit to apply.");
    }
  } finally {
    await client.end();
  }
}

const executedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === executedPath) {
  main().catch((error) => {
    console.error("[file-category-backfill] failed:", error);
    process.exit(1);
  });
}
