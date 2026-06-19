import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { FILE_CATEGORIES, type FileCategory } from "@trock-crm/shared/types";
import { inferFileCategory } from "../server/src/modules/files/infer-category.js";
import { buildFolderPath } from "../server/src/modules/files/file-constants.js";

/**
 * One-off backfill: re-categorize existing files.category='other' rows using the same inferFileCategory
 * inference as the upload path, so the Files page type-filters populate for already-uploaded documents.
 *
 * Safety invariants:
 *  - other-only: only rows with category='other' are ever considered, and the UPDATE re-checks
 *    `AND category='other'` so a concurrently/correctly-set category is never clobbered.
 *  - per-office: tenant schemas are discovered at runtime (pg_namespace LIKE 'office\_%') and each is
 *    processed independently via search_path; a missing/broken office is skipped, not fatal.
 *  - dry-run by default: pass --commit to write. Dry-run prints the full plan + before census.
 *  - idempotent: a second run finds nothing to do (rows it already typed are no longer 'other'; rows
 *    that infer to 'other' are skipped).
 *  - auditable/reversible: a committed run echoes every applied change to stdout AND writes a JSON
 *    snapshot of the ACTUALLY-applied changes (id, from, to) per office to the OS temp dir (owner-only).
 *
 * Usage — run from the repo root. The leading `build --workspace=shared` is REQUIRED: the server
 * modules this script imports (inferFileCategory, buildFolderPath) resolve `@trock-crm/shared` through
 * its built `dist`, which a fresh source checkout doesn't have (only Vitest aliases it to source). The
 * script isn't registered in scripts/run-script.ts, so invoke it directly with tsx:
 *   npm run build --workspace=shared && node --import tsx scripts/backfill-file-categories.ts            # dry-run
 *   npm run build --workspace=shared && node --import tsx scripts/backfill-file-categories.ts --commit   # apply
 */

// Office schemas are discovered at runtime (see discoverOfficeSchemas), never hardcoded, so the backfill
// self-adapts to the real set of offices and never targets a nonexistent schema. This pattern also
// guards identifier interpolation in setSchema.
const OFFICE_SCHEMA_PATTERN = /^office_[a-z0-9_]+$/;

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
  createdAt: string | Date | null;
}

export interface PlannedChange {
  id: string;
  from: "other";
  /** the row's folder_path before the change — captured so the audit snapshot can fully revert it */
  fromFolderPath: string | null;
  to: string;
  /** new folder_path matching the inferred category, so the file leaves the catch-all folder */
  newFolderPath: string;
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
    // folderPath is intentionally omitted: for category='other' rows it is always the catch-all folder
    // ("Correspondence"), which would poison every row to `correspondence`. subcategory is the real hint.
    const inferred = inferFileCategory({
      filename: row.originalFilename,
      mimeType: row.mimeType,
      subcategory: row.subcategory,
      changeOrderId: row.changeOrderId,
    });
    // Skip when inference yields 'other' (no-op → idempotent) or — defensively — anything not a valid
    // enum member (inferFileCategory is typed to never do this, but the raw UPDATE must stay safe).
    if (inferred === "other" || !VALID_CATEGORIES.has(inferred)) {
      skipped += 1;
      continue;
    }
    // Move the file into the folder matching its new category (same buildFolderPath as the upload path)
    // so the folder view and the type filter agree.
    const bucketDate = row.createdAt ? new Date(row.createdAt) : undefined;
    const newFolderPath = buildFolderPath(inferred, row.subcategory ?? undefined, bucketDate);
    willUpdate.push({ id: row.id, from: "other", fromFolderPath: row.folderPath, to: inferred, newFolderPath });
    byTarget[inferred] = (byTarget[inferred] ?? 0) + 1;
  }
  return { willUpdate, skipped, byTarget };
}

/** Minimal query interface so the planner/runner can be unit-tested with a fake client. */
export interface QueryClient {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

async function setSchema(client: QueryClient, schema: string): Promise<void> {
  // schema originates from pg_namespace (LIKE 'office\_%'); validate before interpolating it as a
  // quoted identifier (defense-in-depth, no user input).
  if (!OFFICE_SCHEMA_PATTERN.test(schema)) {
    throw new Error(`Unsafe schema name: ${schema}`);
  }
  await client.query(`SET search_path TO "${schema}", public`);
}

/** Discover tenant office schemas at runtime (mirrors the established per-office backfill pattern). */
export async function discoverOfficeSchemas(client: QueryClient): Promise<string[]> {
  const { rows } = await client.query(
    "SELECT nspname FROM pg_namespace WHERE nspname LIKE 'office\\_%' ESCAPE '\\' ORDER BY nspname"
  );
  return rows.map((row) => String(row.nspname)).filter((name) => OFFICE_SCHEMA_PATTERN.test(name));
}

/**
 * Every `files` column this backfill reads or writes. Offices can drift out of sync (e.g. the near-empty
 * audit office lacks the newer intake_* columns), so we pre-flight each office against this list and skip
 * any that's missing one — a clean, intentional skip instead of an in-query 42703 mid-run.
 */
export const REQUIRED_FILE_COLUMNS = [
  "id",
  "original_filename",
  "mime_type",
  "subcategory",
  "folder_path",
  "change_order_id",
  "created_at",
  "category",
  "is_active",
  "intake_source",
  "intake_requirement_key",
  "updated_at",
] as const;

/**
 * Returns the REQUIRED_FILE_COLUMNS absent from an office's `files` table (empty array = schema is
 * compatible). Reads information_schema.columns by table_schema, so it never throws on a missing column
 * or a missing table (a missing table yields zero rows → every column reported missing). This is the
 * graceful schema-drift guard: an office that returns a non-empty list is skipped with a logged notice
 * and never has its rows queried with columns it doesn't have.
 */
export async function missingFileColumns(client: QueryClient, schema: string): Promise<string[]> {
  if (!OFFICE_SCHEMA_PATTERN.test(schema)) {
    throw new Error(`Unsafe schema name: ${schema}`);
  }
  const { rows } = await client.query(
    "SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'files'",
    [schema]
  );
  const present = new Set(rows.map((row) => String(row.column_name)));
  return REQUIRED_FILE_COLUMNS.filter((column) => !present.has(column));
}

export async function censusByCategory(client: QueryClient, schema: string): Promise<Record<string, number>> {
  await setSchema(client, schema);
  const { rows } = await client.query(
    "SELECT category, count(*)::int AS count FROM files WHERE is_active = true GROUP BY category ORDER BY count DESC"
  );
  const census: Record<string, number> = {};
  for (const row of rows) census[row.category] = Number(row.count);
  return census;
}

export async function fetchOtherFiles(client: QueryClient, schema: string): Promise<OtherFileRow[]> {
  await setSchema(client, schema);
  const { rows } = await client.query(
    `SELECT id,
            original_filename AS "originalFilename",
            mime_type        AS "mimeType",
            subcategory,
            folder_path      AS "folderPath",
            change_order_id  AS "changeOrderId",
            created_at       AS "createdAt"
       FROM files
      WHERE category = 'other'
        AND is_active = true
        -- Preserve stage-gate-linked docs: a verified scoping-intake document satisfies a stage's
        -- required category via files.category (stage-gate isVerifiedLinkedStageDocument), so re-typing
        -- it would break that gate. Skip those.
        AND NOT (intake_source = 'scoping_intake' AND coalesce(intake_requirement_key, '') <> '')`
  );
  return rows as OtherFileRow[];
}

export interface SchemaResult {
  schema: string;
  before: Record<string, number>;
  plan: BackfillPlan;
  /** the changes the UPDATE actually applied (rowCount > 0) — basis for the audit snapshot */
  appliedChanges: PlannedChange[];
  after?: Record<string, number>;
}

export async function runBackfillForSchema(
  client: QueryClient,
  schema: string,
  mode: BackfillMode
): Promise<SchemaResult> {
  const before = await censusByCategory(client, schema);
  const rows = await fetchOtherFiles(client, schema);
  const plan = buildBackfillPlan(rows);

  const appliedChanges: PlannedChange[] = [];
  if (mode === "commit" && plan.willUpdate.length > 0) {
    await client.query("BEGIN");
    try {
      for (const change of plan.willUpdate) {
        // `AND category = 'other'` makes the write idempotent and never overwrites a category that has
        // since changed. The scoping-intake exclusion is repeated here (not just in the SELECT) so a row
        // that becomes a verified stage-gate document DURING the run — the scoping link sets intake_*
        // while leaving category='other' — is still protected at write time. Only rows actually changed
        // (rowCount > 0) are recorded as applied, so the audit snapshot matches what was committed.
        const res = await client.query(
          `UPDATE files SET category = $1::file_category, folder_path = $2, updated_at = now()
            WHERE id = $3 AND category = 'other'
              AND NOT (intake_source = 'scoping_intake' AND coalesce(intake_requirement_key, '') <> '')`,
          [change.to, change.newFolderPath, change.id]
        );
        if ((res.rowCount ?? 0) > 0) appliedChanges.push(change);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    }
  }

  const after = mode === "commit" ? await censusByCategory(client, schema) : undefined;
  return { schema, before, plan, appliedChanges, after };
}

/** Writes an owner-only JSON audit snapshot of the ACTUALLY-applied changes, for reversibility. */
export function writeBackupSnapshot(result: SchemaResult, mode: BackfillMode, stamp: string): string | null {
  if (result.appliedChanges.length === 0) return null;
  const backupPath = path.join(
    os.tmpdir(),
    `trockcrm-file-category-backfill-${mode}-${result.schema}-${stamp}.json`
  );
  fs.writeFileSync(
    backupPath,
    `${JSON.stringify({ schema: result.schema, mode, changes: result.appliedChanges }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
  return backupPath;
}

function buildSslConfig(): false | { rejectUnauthorized: boolean } {
  // Railway/managed Postgres serves certs that aren't in the default CA bundle, so verification is off
  // by default (matching the other backfill scripts). Set DATABASE_SSL_VERIFY=true to enforce it where
  // the CA is trusted.
  return process.env.DATABASE_SSL_VERIFY === "true" ? { rejectUnauthorized: true } : { rejectUnauthorized: false };
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
    ssl: buildSslConfig(),
  });
  await client.connect();

  let totalPlanned = 0;
  let totalApplied = 0;
  const skippedOffices: string[] = [];
  try {
    const schemas = await discoverOfficeSchemas(client);
    console.log(`[file-category-backfill] offices: ${schemas.join(", ") || "(none found)"}`);

    for (const schema of schemas) {
      try {
        // Pre-flight: an office whose files table has drifted (missing a column we read/write) is skipped
        // cleanly with a notice rather than throwing a raw 42703 mid-query. The loop continues either way.
        const missing = await missingFileColumns(client, schema);
        if (missing.length > 0) {
          skippedOffices.push(schema);
          console.warn(
            `\n=== ${schema} === SKIPPED (schema drift): files is missing column(s): ${missing.join(", ")}`
          );
          continue;
        }

        const result = await runBackfillForSchema(client, schema, mode);
        totalPlanned += result.plan.willUpdate.length;
        totalApplied += result.appliedChanges.length;

        console.log(`\n=== ${schema} ===`);
        console.log("  before:", JSON.stringify(result.before));
        console.log(
          `  planned: ${result.plan.willUpdate.length} (skipped ${result.plan.skipped}) → ${JSON.stringify(result.plan.byTarget)}`
        );
        if (mode === "commit") {
          // Echo applied changes to stdout FIRST (the durable record), then a best-effort audit file.
          for (const change of result.appliedChanges) console.log(`    ${change.id}: other → ${change.to}`);
          console.log(`  applied: ${result.appliedChanges.length}`);
          console.log("  after:", JSON.stringify(result.after));
          try {
            const snapshot = writeBackupSnapshot(result, mode, stamp);
            if (snapshot) console.log(`  audit snapshot: ${snapshot}`);
          } catch (snapshotError) {
            console.warn("  audit snapshot write failed (applied changes already printed above):", snapshotError);
          }
        } else {
          for (const change of result.plan.willUpdate) console.log(`    ${change.id}: other → ${change.to}`);
        }
      } catch (schemaError) {
        // Per-office isolation: a missing/broken schema skips only that office, not the whole run.
        console.error(`\n=== ${schema} === SKIPPED due to error:`, schemaError);
      }
    }

    const processed = schemas.length - skippedOffices.length;
    console.log(
      `\n[file-category-backfill] ${mode === "commit" ? "applied" : "would update"} ${mode === "commit" ? totalApplied : totalPlanned} file(s) across ${processed} office(s).`
    );
    if (skippedOffices.length > 0) {
      console.warn(
        `[file-category-backfill] skipped ${skippedOffices.length} office(s) for schema drift: ${skippedOffices.join(", ")}`
      );
    }
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
