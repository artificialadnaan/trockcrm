import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";

/**
 * One-off backfill for the Files-tab "real names" work (PR1):
 *  1. RENAME auto-named rows to their real original_filename (documents AND genuine web/desktop photos),
 *     matching the new upload seed (deriveSeedDisplayName) and spec §5.1;
 *  2. REINDEX the non-synthetic active corpus so search_vector includes original_filename (migration 0178
 *     swapped the trigger body but deferred the full-table reindex to avoid a deploy-time lock).
 *
 * ONE synthetic-photo sentinel is shared with the seed and the search trigger: a row is a SYNTHETIC photo
 * iff category='photo' AND original_filename ~ '^(field-photo-<ts>|companycam_)'. Synthetic rows are NEVER
 * renamed (their download filename stays sane) and index their machine name as '' (0178) — everything else
 * (docs + real web photos) is renamed + reindexed so display and search never diverge for the photo class.
 *
 * Safety invariants (mirrors scripts/backfill-file-categories.ts):
 *  - dry-run by default; --commit writes. Dry-run prints the full per-office census.
 *  - per-office: schemas discovered at runtime (pg_namespace LIKE 'office\_%'); a drifted/broken office is
 *    skipped, not fatal.
 *  - historical-name guard is VERSION-AGNOSTIC: eligibility compares display_name to the name DERIVED FROM
 *    the stored system_filename (pre/post the Fix-3 shortId), not the current generator — so the oldest
 *    rows are not silently skipped.
 *  - idempotent: the rename UPDATE re-checks the full eligibility predicate at write time, so a name edited
 *    mid-run is never clobbered and a second run is a no-op.
 *  - reindex is batched across transactions (bounded lock); the set_files_updated_at bump on touched rows
 *    is accepted (updated_at is not a display sort key; created_at is preserved).
 *  - auditable/reversible: every APPLIED rename (id, category, from, to) is echoed AND written to an
 *    owner-only JSON snapshot per office.
 *
 * Usage — run from the repo root (build shared first so @trock-crm/shared resolves; not registered in
 * run-script.ts, so invoke directly with tsx):
 *   npm run build --workspace=shared && node --import tsx scripts/backfill-file-display-names.ts            # dry-run census
 *   npm run build --workspace=shared && node --import tsx scripts/backfill-file-display-names.ts --commit   # Adnaan applies
 */

const OFFICE_SCHEMA_PATTERN = /^office_[a-z0-9_]+$/;
const REINDEX_BATCH = 2000;

export const REQUIRED_FILE_COLUMNS = [
  "id",
  "display_name",
  "system_filename",
  "original_filename",
  "file_extension",
  "category",
  "is_active",
  "updated_at",
  "search_vector",
] as const;

export type Mode = "dry-run" | "commit";

export function parseArgs(argv = process.argv): { mode: Mode } {
  const a = argv.slice(2);
  if (a.includes("--commit") && a.includes("--dry-run")) {
    throw new Error("Choose exactly one of --dry-run or --commit");
  }
  return { mode: a.includes("--commit") ? "commit" : "dry-run" };
}

// ─── Pure planner / guards (unit-tested) ─────────────────────────────────────

export interface FileRow {
  id: string;
  displayName: string;
  systemFilename: string;
  originalFilename: string | null;
  category: string;
}

export interface RenamePlanEntry {
  id: string;
  category: string;
  from: string;
  to: string;
  isPhoto: boolean;
}

export interface RenamePlan {
  rename: RenamePlanEntry[];
  renameDocs: number;
  renameWebPhotos: number;
  alreadyEdited: number;
  synthetic: number;
  emptyOriginal: number;
}

/** Strip a trailing extension (mirrors the SQL `regexp_replace(x, '\.[^.]*$', '')`). */
function stripExtension(name: string): string {
  return name.replace(/\.[^.]*$/, "");
}

/**
 * The historical display name for a row, derived from its STORED system_filename exactly as the SQL does:
 * `replace(regexp_replace(system_filename, '\.[^.]*$', ''), '_', ' ')`. Version-agnostic — reproduces the
 * pre- AND post-shortId formulas, so an auto-named row is recognized regardless of when it was created.
 */
export function deriveHistoricalDisplayName(systemFilename: string): string {
  return stripExtension(systemFilename).replace(/_/g, " ");
}

/**
 * The ONE sentinel shared with the seed (deriveSeedDisplayName) and the 0178 search trigger: a row is a
 * SYNTHETIC photo iff category='photo' AND its filename is a machine name (field/TRCAM or CompanyCam).
 * Case-sensitive, matching the SQL `~ '^(field-photo-[0-9]+|companycam_)'`.
 */
export function isSyntheticPhotoRow(row: { category: string; originalFilename: string | null }): boolean {
  return row.category === "photo" && /^(field-photo-\d+|companycam_)/.test(row.originalFilename ?? "");
}

/**
 * Bucket rows for the rename pass. Eligible = auto-named (display_name reproduces the historical
 * system_filename derivation), non-synthetic, real original_filename — INCLUDING genuine web/desktop
 * photos. Everything else is counted into a protected/skipped bucket for the census.
 */
export function buildRenamePlan(rows: FileRow[]): RenamePlan {
  const plan: RenamePlan = {
    rename: [],
    renameDocs: 0,
    renameWebPhotos: 0,
    alreadyEdited: 0,
    synthetic: 0,
    emptyOriginal: 0,
  };
  for (const row of rows) {
    const original = row.originalFilename ?? "";
    if (original === "") {
      plan.emptyOriginal += 1;
      continue;
    }
    if (isSyntheticPhotoRow(row)) {
      plan.synthetic += 1;
      continue;
    }
    if (row.displayName !== deriveHistoricalDisplayName(row.systemFilename)) {
      plan.alreadyEdited += 1;
      continue;
    }
    const isPhoto = row.category === "photo";
    plan.rename.push({ id: row.id, category: row.category, from: row.displayName, to: stripExtension(original), isPhoto });
    if (isPhoto) plan.renameWebPhotos += 1;
    else plan.renameDocs += 1;
  }
  return plan;
}

// ─── SQL predicates (shared sentinel, kept in lockstep with the pure guards above) ───

const SYNTHETIC_PHOTO_PREDICATE = `
  (category = 'photo' AND original_filename ~ '^(field-photo-[0-9]+|companycam_)')
`;

// Auto-named (display_name reproduces the STORED system_filename derivation — version-agnostic),
// non-synthetic, real filename. Includes genuine web/desktop photos.
const RENAME_WHERE = `
  is_active = true
  AND coalesce(original_filename, '') <> ''
  AND NOT ${SYNTHETIC_PHOTO_PREDICATE}
  AND display_name = replace(regexp_replace(system_filename, '\\.[^.]*$', ''), '_', ' ')
`;

// Every non-synthetic active row must have original_filename in its search_vector (covers already-edited
// rows the rename pass skips). Same sentinel as the seed/rename so display & search never diverge.
const REINDEX_WHERE = `
  is_active = true
  AND coalesce(original_filename, '') <> ''
  AND NOT ${SYNTHETIC_PHOTO_PREDICATE}
`;

// ─── DB plumbing ─────────────────────────────────────────────────────────────

/** Minimal query interface so the runner can be unit-tested with a fake client. */
export interface QueryClient {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

async function setSchema(client: QueryClient, schema: string): Promise<void> {
  if (!OFFICE_SCHEMA_PATTERN.test(schema)) {
    throw new Error(`Unsafe schema name: ${schema}`);
  }
  await client.query(`SET search_path TO "${schema}", public`);
}

export async function discoverOfficeSchemas(client: QueryClient): Promise<string[]> {
  const { rows } = await client.query(
    "SELECT nspname FROM pg_namespace WHERE nspname LIKE 'office\\_%' ESCAPE '\\' ORDER BY nspname",
  );
  return rows.map((row) => String(row.nspname)).filter((name) => OFFICE_SCHEMA_PATTERN.test(name));
}

export async function missingFileColumns(client: QueryClient, schema: string): Promise<string[]> {
  if (!OFFICE_SCHEMA_PATTERN.test(schema)) {
    throw new Error(`Unsafe schema name: ${schema}`);
  }
  const { rows } = await client.query(
    "SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'files'",
    [schema],
  );
  const present = new Set(rows.map((row) => String(row.column_name)));
  return REQUIRED_FILE_COLUMNS.filter((column) => !present.has(column));
}

export interface OfficeCensus {
  renameDocs: number;
  renameWebPhotos: number;
  alreadyEdited: number;
  synthetic: number;
  emptyOriginal: number;
  reindexTotal: number;
}

async function countWhere(client: QueryClient, where: string): Promise<number> {
  const { rows } = await client.query(`SELECT count(*)::int AS n FROM files WHERE ${where}`);
  return Number(rows[0]?.n ?? 0);
}

export async function censusForSchema(client: QueryClient, schema: string): Promise<OfficeCensus> {
  await setSchema(client, schema);
  return {
    renameDocs: await countWhere(client, `${RENAME_WHERE} AND category <> 'photo'`),
    renameWebPhotos: await countWhere(client, `${RENAME_WHERE} AND category = 'photo'`),
    alreadyEdited: await countWhere(
      client,
      `is_active = true AND coalesce(original_filename, '') <> '' AND NOT ${SYNTHETIC_PHOTO_PREDICATE}
       AND display_name <> replace(regexp_replace(system_filename, '\\.[^.]*$', ''), '_', ' ')`,
    ),
    synthetic: await countWhere(client, `is_active = true AND ${SYNTHETIC_PHOTO_PREDICATE}`),
    emptyOriginal: await countWhere(client, `is_active = true AND coalesce(original_filename, '') = ''`),
    reindexTotal: await countWhere(client, REINDEX_WHERE),
  };
}

export interface AppliedRename {
  id: string;
  category: string;
  from: string;
  to: string;
}

export interface SchemaResult {
  schema: string;
  census: OfficeCensus;
  applied: AppliedRename[];
  reindexed: number;
}

export async function runBackfillForSchema(client: QueryClient, schema: string, mode: Mode): Promise<SchemaResult> {
  const census = await censusForSchema(client, schema);
  const applied: AppliedRename[] = [];
  let reindexed = 0;

  if (mode === "commit") {
    await setSchema(client, schema);

    // Rename pass — the value is computed IN-DB and the full eligibility predicate re-checked at write
    // time (idempotent + never clobbers a name edited during the run). Re-firing the trigger also indexes
    // original_filename for these rows.
    const candidates = await client.query(
      `SELECT id, display_name, category FROM files WHERE ${RENAME_WHERE} ORDER BY id`,
    );
    await client.query("BEGIN");
    try {
      for (const row of candidates.rows) {
        const res = await client.query(
          `UPDATE files
              SET display_name = regexp_replace(original_filename, '\\.[^.]*$', ''), updated_at = now()
            WHERE id = $1 AND ${RENAME_WHERE}
            RETURNING display_name`,
          [row.id],
        );
        if ((res.rowCount ?? 0) > 0) {
          applied.push({ id: String(row.id), category: String(row.category), from: String(row.display_name), to: String(res.rows[0].display_name) });
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    }

    // Reindex pass — batched, each batch its OWN transaction to bound lock duration. Covers rows the
    // rename pass skipped (already-edited names) so the whole non-synthetic corpus is searchable by name.
    let lastId: string | null = null;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const batch = await client.query(
        `SELECT id FROM files WHERE ${REINDEX_WHERE} ${lastId ? "AND id > $1" : ""} ORDER BY id LIMIT ${REINDEX_BATCH}`,
        lastId ? [lastId] : [],
      );
      if (batch.rows.length === 0) break;
      const ids = batch.rows.map((r) => String(r.id));
      await client.query("BEGIN");
      try {
        await client.query(`UPDATE files SET search_vector = search_vector WHERE id = ANY($1::uuid[])`, [ids]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      }
      reindexed += ids.length;
      lastId = ids[ids.length - 1];
      if (batch.rows.length < REINDEX_BATCH) break;
    }
  }

  return { schema, census, applied, reindexed };
}

/** Owner-only JSON snapshot of the ACTUALLY-applied renames, for reversibility. */
export function writeBackupSnapshot(result: SchemaResult, mode: Mode, stamp: string): string | null {
  if (result.applied.length === 0) return null;
  const backupPath = path.join(os.tmpdir(), `trockcrm-file-display-name-backfill-${mode}-${result.schema}-${stamp}.json`);
  fs.writeFileSync(
    backupPath,
    `${JSON.stringify({ schema: result.schema, mode, changes: result.applied }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  return backupPath;
}

function buildSslConfig(): false | { rejectUnauthorized: boolean } {
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
  const { mode } = parseArgs(argv);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  console.log(`[file-display-name-backfill] mode=${mode}`);

  const client = new pg.Client({ connectionString: resolveDatabaseUrl(), ssl: buildSslConfig() });
  await client.connect();

  let totalRenamed = 0;
  let totalReindexed = 0;
  const skippedOffices: string[] = [];
  try {
    const schemas = await discoverOfficeSchemas(client);
    console.log(`[file-display-name-backfill] offices: ${schemas.join(", ") || "(none found)"}`);

    for (const schema of schemas) {
      try {
        const missing = await missingFileColumns(client, schema);
        if (missing.length > 0) {
          skippedOffices.push(schema);
          console.warn(`\n=== ${schema} === SKIPPED (schema drift): files is missing column(s): ${missing.join(", ")}`);
          continue;
        }

        const result = await runBackfillForSchema(client, schema, mode);
        totalRenamed += result.applied.length;
        totalReindexed += result.reindexed;

        console.log(`\n=== ${schema} ===`);
        console.log(
          `  census: rename-docs=${result.census.renameDocs} rename-web-photos=${result.census.renameWebPhotos} ` +
            `already-edited=${result.census.alreadyEdited} synthetic(protected)=${result.census.synthetic} ` +
            `empty-original=${result.census.emptyOriginal} reindex-total=${result.census.reindexTotal}`,
        );
        if (mode === "commit") {
          for (const change of result.applied) console.log(`    ${change.id} (${change.category}): "${change.from}" -> "${change.to}"`);
          console.log(`  renamed: ${result.applied.length}; reindexed: ${result.reindexed}`);
          try {
            const snapshot = writeBackupSnapshot(result, mode, stamp);
            if (snapshot) console.log(`  audit snapshot: ${snapshot}`);
          } catch (snapshotError) {
            console.warn("  audit snapshot write failed (applied renames already printed above):", snapshotError);
          }
        }
      } catch (schemaError) {
        console.error(`\n=== ${schema} === SKIPPED due to error:`, schemaError);
      }
    }

    const processed = schemas.length - skippedOffices.length;
    if (mode === "commit") {
      console.log(`\n[file-display-name-backfill] renamed ${totalRenamed} + reindexed ${totalReindexed} row(s) across ${processed} office(s).`);
    } else {
      console.log(`\n[file-display-name-backfill] dry-run only — re-run with --commit to apply (Adnaan runs the prod write).`);
    }
    if (skippedOffices.length > 0) {
      console.warn(`[file-display-name-backfill] skipped ${skippedOffices.length} office(s) for schema drift: ${skippedOffices.join(", ")}`);
    }
  } finally {
    await client.end();
  }
}

const executedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === executedPath) {
  main().catch((error) => {
    console.error("[file-display-name-backfill] failed:", error);
    process.exit(1);
  });
}
