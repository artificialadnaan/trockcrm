import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { buildFolderPath } from "../server/src/modules/files/file-constants.js";

/**
 * One-off backfill: re-file photos into the YYYY-MM folder bucket matching their OWN capture date.
 *
 * Why these rows are wrong: the upload protocol is three steps, and `folder_path` was decided in step 1
 * (presign) from now(), while `taken_at` only arrives in step 3 (confirm). A photo taken in April but
 * imported in September was therefore filed under September. confirmUpload now re-derives the path from
 * `taken_at` before inserting; this script applies the same correction to rows created before that fix.
 *
 * Safety invariants:
 *  - metadata only: the ONLY column written is folder_path (plus updated_at). The R2 key has no month
 *    segment (buildR2Key takes no date), so folder_path is a purely virtual column and re-filing a photo
 *    moves zero stored objects — nothing to copy, nothing to orphan.
 *  - narrow: only category='photo' AND taken_at IS NOT NULL AND the stored path already differs from the
 *    derived one. A row whose path is already correct is never touched, in the SELECT or the UPDATE.
 *  - per-office: tenant schemas are discovered at runtime (pg_namespace LIKE 'office\_%') and each is
 *    processed independently via search_path; a missing/broken office is skipped, not fatal.
 *  - dry-run by default: pass --commit to write. Dry-run prints the full plan + before census.
 *  - idempotent: a second run finds nothing to do (the rows it moved now derive to their own path).
 *  - concurrency-safe: the UPDATE re-asserts the EXACT folder_path and taken_at the plan was computed
 *    from, so an edit that landed between the SELECT and the write (the edit modal re-derives the same
 *    path on a category/subcategory change) is left alone instead of clobbered.
 *  - auditable/reversible: a committed run echoes every applied change to stdout AND writes a JSON
 *    snapshot of the ACTUALLY-applied changes (id, from, to) per office to the OS temp dir (owner-only).
 *
 * Usage — run from the repo root. The leading `build --workspace=shared` is REQUIRED: the server module
 * this script imports (buildFolderPath) resolves `@trock-crm/shared` through its built `dist`, which a
 * fresh source checkout doesn't have (only Vitest aliases it to source). The script isn't registered in
 * scripts/run-script.ts, so invoke it directly with tsx:
 *   npm run build --workspace=shared && node --import tsx scripts/backfill-photo-folder-buckets.ts           # dry-run
 *   npm run build --workspace=shared && node --import tsx scripts/backfill-photo-folder-buckets.ts --commit  # apply
 */

// Office schemas are discovered at runtime (see discoverOfficeSchemas), never hardcoded, so the backfill
// self-adapts to the real set of offices and never targets a nonexistent schema. This pattern also
// guards identifier interpolation in setSchema.
const OFFICE_SCHEMA_PATTERN = /^office_[a-z0-9_]+$/;

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

/** A candidate row: an active photo that carries a capture date. */
export interface PhotoFileRow {
  id: string;
  subcategory: string | null;
  folderPath: string | null;
  takenAt: string | Date | null;
}

export interface PlannedMove {
  id: string;
  /** the row's folder_path before the change — captured so the audit snapshot can fully revert it, AND
   *  used as the optimistic guard in the UPDATE */
  from: string | null;
  to: string;
  /** the taken_at the target path was derived from — pinned in the UPDATE so a concurrent capture-date
   *  correction doesn't get a path derived from the date it replaced */
  takenAt: Date;
}

export interface BackfillPlan {
  willUpdate: PlannedMove[];
  /** already correct, or an unusable taken_at — either way a no-op */
  skipped: number;
  /** count of planned moves per target bucket path (for the dry-run summary) */
  byTarget: Record<string, number>;
}

/**
 * Pure planner: re-derives each photo's folder path from its own taken_at with the SAME buildFolderPath
 * the upload and edit paths use, and keeps only the rows whose stored path disagrees.
 *
 * A row with an unparseable taken_at is skipped rather than defaulted: buildFolderPath would call
 * toISOString() on an Invalid Date and throw, and there is no correct bucket to guess. timestamptz can't
 * normally produce one — this guards the raw driver value, which is a string under some pg type parsers.
 */
export function buildBackfillPlan(rows: PhotoFileRow[]): BackfillPlan {
  const willUpdate: PlannedMove[] = [];
  const byTarget: Record<string, number> = {};
  let skipped = 0;
  for (const row of rows) {
    if (row.takenAt == null) {
      skipped += 1;
      continue;
    }
    const takenAt = row.takenAt instanceof Date ? row.takenAt : new Date(row.takenAt);
    if (Number.isNaN(takenAt.getTime())) {
      skipped += 1;
      continue;
    }
    const derived = buildFolderPath("photo", row.subcategory ?? undefined, takenAt);
    // Already filed correctly (including every row uploaded after the confirmUpload fix) → no-op, which
    // is what makes a second run of this script find nothing to do.
    if (derived === row.folderPath) {
      skipped += 1;
      continue;
    }
    willUpdate.push({ id: row.id, from: row.folderPath, to: derived, takenAt });
    byTarget[derived] = (byTarget[derived] ?? 0) + 1;
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
 * Every `files` column this backfill reads or writes. Offices can drift out of sync, so we pre-flight each
 * office against this list and skip any that's missing one — a clean, intentional skip instead of an
 * in-query 42703 mid-run.
 */
export const REQUIRED_FILE_COLUMNS = [
  "id",
  "category",
  "subcategory",
  "folder_path",
  "taken_at",
  "is_active",
  "updated_at",
] as const;

/**
 * Returns the REQUIRED_FILE_COLUMNS absent from an office's `files` table (empty array = schema is
 * compatible). Reads information_schema.columns by table_schema, so it never throws on a missing column
 * or a missing table (a missing table yields zero rows → every column reported missing).
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

/** How many active photos carry a capture date at all — the denominator the planned moves are read against. */
export async function censusDatedPhotos(client: QueryClient, schema: string): Promise<number> {
  await setSchema(client, schema);
  const { rows } = await client.query(
    "SELECT count(*)::int AS count FROM files WHERE category = 'photo' AND taken_at IS NOT NULL AND is_active = true"
  );
  return Number(rows[0]?.count ?? 0);
}

export async function fetchDatedPhotos(client: QueryClient, schema: string): Promise<PhotoFileRow[]> {
  await setSchema(client, schema);
  const { rows } = await client.query(
    `SELECT id,
            subcategory,
            folder_path AS "folderPath",
            taken_at    AS "takenAt"
       FROM files
      WHERE category = 'photo'
        AND taken_at IS NOT NULL
        -- Soft-deleted rows are invisible in the folder view, so re-filing them would be churn with no
        -- observable effect; matching the other file backfills, they are out of scope.
        AND is_active = true`
  );
  return rows as PhotoFileRow[];
}

export interface SchemaResult {
  schema: string;
  /** active photos with a capture date, before the run */
  datedPhotos: number;
  plan: BackfillPlan;
  /** the moves the UPDATE actually applied (rowCount > 0) — basis for the audit snapshot */
  appliedMoves: PlannedMove[];
}

export async function runBackfillForSchema(
  client: QueryClient,
  schema: string,
  mode: BackfillMode
): Promise<SchemaResult> {
  const datedPhotos = await censusDatedPhotos(client, schema);
  const rows = await fetchDatedPhotos(client, schema);
  const plan = buildBackfillPlan(rows);

  const appliedMoves: PlannedMove[] = [];
  if (mode === "commit" && plan.willUpdate.length > 0) {
    await client.query("BEGIN");
    try {
      for (const move of plan.willUpdate) {
        // The guard clause is the whole safety story: re-assert category, the EXACT folder_path the plan
        // read (IS NOT DISTINCT FROM, because a legacy row's path can be NULL) and the EXACT taken_at it
        // derived from. A row edited since the SELECT matches none of those and is silently left alone,
        // which also makes a re-run of an interrupted commit idempotent. Only rows actually changed
        // (rowCount > 0) are recorded as applied, so the audit snapshot matches what was committed.
        const res = await client.query(
          `UPDATE files SET folder_path = $1, updated_at = now()
            WHERE id = $2
              AND category = 'photo'
              AND is_active = true
              AND folder_path IS NOT DISTINCT FROM $3
              AND taken_at = $4`,
          [move.to, move.id, move.from, move.takenAt]
        );
        if ((res.rowCount ?? 0) > 0) appliedMoves.push(move);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    }
  }

  return { schema, datedPhotos, plan, appliedMoves };
}

/** Writes an owner-only JSON audit snapshot of the ACTUALLY-applied moves, for reversibility. */
export function writeBackupSnapshot(result: SchemaResult, mode: BackfillMode, stamp: string): string | null {
  if (result.appliedMoves.length === 0) return null;
  const backupPath = path.join(
    os.tmpdir(),
    `trockcrm-photo-folder-bucket-backfill-${mode}-${result.schema}-${stamp}.json`
  );
  fs.writeFileSync(
    backupPath,
    `${JSON.stringify({ schema: result.schema, mode, moves: result.appliedMoves }, null, 2)}\n`,
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
  console.log(`[photo-folder-bucket-backfill] mode=${mode}`);

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
    console.log(`[photo-folder-bucket-backfill] offices: ${schemas.join(", ") || "(none found)"}`);

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
        totalApplied += result.appliedMoves.length;

        console.log(`\n=== ${schema} ===`);
        console.log(`  dated photos: ${result.datedPhotos}`);
        console.log(
          `  planned: ${result.plan.willUpdate.length} (already correct/skipped ${result.plan.skipped}) → ${JSON.stringify(result.plan.byTarget)}`
        );
        if (mode === "commit") {
          // Echo applied moves to stdout FIRST (the durable record), then a best-effort audit file.
          for (const move of result.appliedMoves) console.log(`    ${move.id}: ${move.from ?? "(null)"} → ${move.to}`);
          console.log(`  applied: ${result.appliedMoves.length}`);
          try {
            const snapshot = writeBackupSnapshot(result, mode, stamp);
            if (snapshot) console.log(`  audit snapshot: ${snapshot}`);
          } catch (snapshotError) {
            console.warn("  audit snapshot write failed (applied moves already printed above):", snapshotError);
          }
        } else {
          for (const move of result.plan.willUpdate) console.log(`    ${move.id}: ${move.from ?? "(null)"} → ${move.to}`);
        }
      } catch (schemaError) {
        // Per-office isolation: a missing/broken schema skips only that office, not the whole run.
        console.error(`\n=== ${schema} === SKIPPED due to error:`, schemaError);
      }
    }

    const processed = schemas.length - skippedOffices.length;
    console.log(
      `\n[photo-folder-bucket-backfill] ${mode === "commit" ? "applied" : "would update"} ${mode === "commit" ? totalApplied : totalPlanned} photo(s) across ${processed} office(s).`
    );
    if (skippedOffices.length > 0) {
      console.warn(
        `[photo-folder-bucket-backfill] skipped ${skippedOffices.length} office(s) for schema drift: ${skippedOffices.join(", ")}`
      );
    }
    if (mode !== "commit") {
      console.log("[photo-folder-bucket-backfill] dry-run only — re-run with --commit to apply.");
    }
  } finally {
    await client.end();
  }
}

const executedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === executedPath) {
  main().catch((error) => {
    console.error("[photo-folder-bucket-backfill] failed:", error);
    process.exit(1);
  });
}
