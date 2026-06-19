import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import {
  DEAL_REGION_DEFINITIONS,
  getDealRegionForState,
  normalizeUsStateCode,
  type DealRegionSlug,
} from "../shared/src/types/deal-regions.js";

/**
 * One-off backfill: populate deals.region_id for deals where it IS NULL by deriving the region from the
 * deal's own property_state — using the EXACT logic the deal EDIT form's auto-select uses
 * (resolveRegionIdForState -> getDealRegionForState over the active region_config rows). This reconciles
 * the surfaces that read the stored region_id (deal detail, Reports-by-Region, the deal/contact Region
 * filter, the Monday-Showcase region drill) with the region the form has been showing-but-not-persisting.
 *
 * Why this and not scripts/backfill-deal-regions.ts: that earlier (#486) script derives state from the
 * joined property (p.state ?? d.property_state) and also remaps legacy texas/southeast rows and can
 * overwrite already-set regions. The FORM derives from d.property_state ONLY and only ever fills a blank.
 * To stay byte-for-byte consistent with the form, this backfill: (a) reads d.property_state, never the
 * property join, and (b) only ever fills a NULL region_id — it never overwrites or remaps an existing one.
 *
 * Safety invariants (mirrors scripts/backfill-file-categories.ts):
 *  - null-only: only deals with region_id IS NULL are fetched, and the UPDATE re-checks
 *    `AND region_id IS NULL`, so a concurrently/manually-set region is never clobbered.
 *  - form-exact: region is derived from d.property_state via getDealRegionForState against the active
 *    region_config rows (is_active=true), exactly like the form's useRegions()+resolveRegionIdForState.
 *  - leaves-blank: a deal with no usable / unmapped state stays NULL (Unassigned), never guessed.
 *  - per-office: tenant schemas discovered at runtime (pg_namespace LIKE 'office\_%'); each processed
 *    independently; a drifted/broken office is skipped, not fatal.
 *  - dry-run by default: pass --commit to write. Dry-run prints the full plan + before census.
 *  - idempotent: a second run finds nothing (the rows it filled are no longer NULL).
 *  - transactional: each office's writes run in a single BEGIN/COMMIT (ROLLBACK on error).
 *  - auditable/reversible: a committed run echoes every applied change AND writes an owner-only JSON
 *    snapshot of the ACTUALLY-applied changes (id, from:null, to) per office to the OS temp dir. Revert =
 *    set region_id = NULL where id in (snapshot ids) (every `from` is null).
 *
 * Usage — run from the repo root (no shared build needed; deal-regions is pure source imported via tsx):
 *   node --import tsx scripts/backfill-null-deal-regions.ts            # dry-run (default)
 *   node --import tsx scripts/backfill-null-deal-regions.ts --commit   # apply
 */

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

/** An active region_config row (mirrors /pipeline/regions — is_active=true). */
export interface NullRegionConfigRow {
  id: string;
  slug: string;
  name: string;
  isActive: boolean;
  displayOrder: number;
}

/** A deal with region_id IS NULL (candidate for derivation). */
export interface NullRegionDeal {
  schemaName: string;
  dealId: string;
  dealNumber: string;
  dealName: string;
  /** always null for fetched candidates; the planner defends against a non-null value anyway. */
  regionId: string | null;
  /** the deal's OWN property_state column (NOT the joined property) — what the form's auto-select reads. */
  propertyState: string | null;
  isActive: boolean;
}

export interface NullRegionChange {
  schemaName: string;
  dealId: string;
  dealNumber: string;
  dealName: string;
  isActive: boolean;
  propertyState: string | null;
  /** normalized 2-letter state code that drove the mapping */
  effectiveState: string | null;
  targetRegionSlug: DealRegionSlug;
  targetRegionId: string;
  targetRegionName: string;
}

export interface NullRegionBackfillPlan {
  counts: {
    candidateDeals: number;
    willUpdate: number;
    noState: number;
    unmappedState: number;
    alreadySet: number;
    missingTargetRegion: number;
    inactiveDealsUpdated: number;
  };
  bySchema: Record<string, { candidateDeals: number; willUpdate: number; leftBlank: number }>;
  /** region display name -> count of planned updates (the census the reviewer approves) */
  byTargetRegion: Record<string, number>;
  changes: NullRegionChange[];
  unmappedStates: NullRegionDeal[];
  missingTargetRegions: Array<{ dealId: string; schemaName: string; targetRegionSlug: DealRegionSlug }>;
}

function ensureSchemaBucket(plan: NullRegionBackfillPlan, schemaName: string) {
  plan.bySchema[schemaName] ??= { candidateDeals: 0, willUpdate: 0, leftBlank: 0 };
  return plan.bySchema[schemaName];
}

/**
 * Pure planner. For each NULL-region deal, derive the region from property_state the SAME way the form's
 * auto-select does (getDealRegionForState -> match the active region_config row by slug-or-name), and plan
 * an update only when a region is found. Everything else is left blank (and categorized for the census).
 */
export function buildNullRegionBackfillPlan(input: {
  deals: NullRegionDeal[];
  regions: NullRegionConfigRow[];
}): NullRegionBackfillPlan {
  const activeRegions = input.regions.filter((r) => r.isActive);
  const plan: NullRegionBackfillPlan = {
    counts: {
      candidateDeals: 0,
      willUpdate: 0,
      noState: 0,
      unmappedState: 0,
      alreadySet: 0,
      missingTargetRegion: 0,
      inactiveDealsUpdated: 0,
    },
    bySchema: {},
    byTargetRegion: {},
    changes: [],
    unmappedStates: [],
    missingTargetRegions: [],
  };

  for (const deal of input.deals) {
    plan.counts.candidateDeals += 1;
    const bucket = ensureSchemaBucket(plan, deal.schemaName);
    bucket.candidateDeals += 1;

    // Defensive: SELECT already filters region_id IS NULL, but never plan over a set region.
    if (deal.regionId != null) {
      plan.counts.alreadySet += 1;
      bucket.leftBlank += 1;
      continue;
    }

    const normalized = normalizeUsStateCode(deal.propertyState);
    const dealRegion = getDealRegionForState(deal.propertyState);
    if (!dealRegion) {
      if (normalized === null) {
        plan.counts.noState += 1;
      } else {
        plan.counts.unmappedState += 1;
        plan.unmappedStates.push(deal);
      }
      bucket.leftBlank += 1;
      continue;
    }

    // Mirror resolveRegionIdForState: find the active region_config row by slug OR display name.
    const match = activeRegions.find((r) => r.slug === dealRegion.slug || r.name === dealRegion.name);
    if (!match) {
      plan.counts.missingTargetRegion += 1;
      plan.missingTargetRegions.push({
        dealId: deal.dealId,
        schemaName: deal.schemaName,
        targetRegionSlug: dealRegion.slug,
      });
      bucket.leftBlank += 1;
      continue;
    }

    plan.changes.push({
      schemaName: deal.schemaName,
      dealId: deal.dealId,
      dealNumber: deal.dealNumber,
      dealName: deal.dealName,
      isActive: deal.isActive,
      propertyState: deal.propertyState,
      effectiveState: normalized,
      targetRegionSlug: dealRegion.slug,
      targetRegionId: match.id,
      targetRegionName: dealRegion.name,
    });
    plan.counts.willUpdate += 1;
    bucket.willUpdate += 1;
    plan.byTargetRegion[dealRegion.name] = (plan.byTargetRegion[dealRegion.name] ?? 0) + 1;
    if (!deal.isActive) plan.counts.inactiveDealsUpdated += 1;
  }

  return plan;
}

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
    "SELECT nspname FROM pg_namespace WHERE nspname LIKE 'office\\_%' ESCAPE '\\' ORDER BY nspname"
  );
  return rows.map((row) => String(row.nspname)).filter((name) => OFFICE_SCHEMA_PATTERN.test(name));
}

/** Every deals column this backfill reads or writes; an office missing any is skipped (schema-drift guard). */
export const REQUIRED_DEAL_COLUMNS = [
  "id",
  "region_id",
  "property_state",
  "deal_number",
  "name",
  "is_active",
  "updated_at",
] as const;

export async function missingDealColumns(client: QueryClient, schema: string): Promise<string[]> {
  if (!OFFICE_SCHEMA_PATTERN.test(schema)) {
    throw new Error(`Unsafe schema name: ${schema}`);
  }
  const { rows } = await client.query(
    "SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'deals'",
    [schema]
  );
  const present = new Set(rows.map((row) => String(row.column_name)));
  return REQUIRED_DEAL_COLUMNS.filter((column) => !present.has(column));
}

/** Active region_config rows (the form's source). region_config lives in public, shared across offices. */
export async function fetchActiveRegions(client: QueryClient): Promise<NullRegionConfigRow[]> {
  const { rows } = await client.query(
    `SELECT id::text AS id, slug, name, is_active AS "isActive", display_order AS "displayOrder"
       FROM public.region_config
      WHERE is_active = true
      ORDER BY display_order ASC, name ASC`
  );
  return rows.map((row) => ({
    id: String(row.id),
    slug: String(row.slug),
    name: String(row.name ?? ""),
    isActive: Boolean(row.isActive),
    displayOrder: Number(row.displayOrder ?? 0),
  }));
}

/** Full region distribution for an office (region_config name, else 'Unassigned'). */
export async function censusByRegion(client: QueryClient, schema: string): Promise<Record<string, number>> {
  await setSchema(client, schema);
  const { rows } = await client.query(
    `SELECT COALESCE(NULLIF(rc.name, ''), 'Unassigned') AS region, count(*)::int AS count
       FROM deals d
       LEFT JOIN public.region_config rc ON rc.id = d.region_id
      GROUP BY 1
      ORDER BY count DESC`
  );
  const census: Record<string, number> = {};
  for (const row of rows) census[String(row.region)] = Number(row.count);
  return census;
}

export async function fetchNullRegionDeals(client: QueryClient, schema: string): Promise<NullRegionDeal[]> {
  await setSchema(client, schema);
  const { rows } = await client.query(
    `SELECT id,
            deal_number    AS "dealNumber",
            name           AS "dealName",
            property_state AS "propertyState",
            is_active      AS "isActive"
       FROM deals
      WHERE region_id IS NULL
      ORDER BY deal_number ASC, id ASC`
  );
  return rows.map((row) => ({
    schemaName: schema,
    dealId: String(row.id),
    dealNumber: String(row.dealNumber ?? ""),
    dealName: String(row.dealName ?? ""),
    regionId: null,
    propertyState: row.propertyState == null ? null : String(row.propertyState),
    isActive: Boolean(row.isActive),
  }));
}

/** Commit-time guard: every region the deal-region model can target must exist as an active row. */
export function assertTargetRegionsPresent(regions: NullRegionConfigRow[]): void {
  const active = regions.filter((r) => r.isActive);
  const missing = DEAL_REGION_DEFINITIONS.filter(
    (def) => !active.some((r) => r.slug === def.slug || r.name === def.name)
  ).map((def) => def.slug);
  if (missing.length > 0) {
    throw new Error(
      `Missing active region_config rows for: ${missing.join(", ")}. Seed region_config before --commit.`
    );
  }
}

export interface SchemaResult {
  schema: string;
  before: Record<string, number>;
  plan: NullRegionBackfillPlan;
  /** the changes the UPDATE actually applied (rowCount > 0) — basis for the audit snapshot */
  appliedChanges: NullRegionChange[];
  after?: Record<string, number>;
}

export async function runBackfillForSchema(
  client: QueryClient,
  schema: string,
  regions: NullRegionConfigRow[],
  mode: BackfillMode
): Promise<SchemaResult> {
  const before = await censusByRegion(client, schema);
  const deals = await fetchNullRegionDeals(client, schema);
  const plan = buildNullRegionBackfillPlan({ deals, regions });

  const appliedChanges: NullRegionChange[] = [];
  if (mode === "commit" && plan.changes.length > 0) {
    await setSchema(client, schema);
    await client.query("BEGIN");
    try {
      for (const change of plan.changes) {
        // `AND region_id IS NULL` keeps the write idempotent and never clobbers a region set since the
        // SELECT. Only rows actually changed (rowCount > 0) are recorded as applied, so the audit
        // snapshot matches exactly what was committed.
        const res = await client.query(
          `UPDATE deals SET region_id = $1::uuid, updated_at = now()
            WHERE id = $2 AND region_id IS NULL`,
          [change.targetRegionId, change.dealId]
        );
        if ((res.rowCount ?? 0) > 0) appliedChanges.push(change);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    }
  }

  const after = mode === "commit" ? await censusByRegion(client, schema) : undefined;
  return { schema, before, plan, appliedChanges, after };
}

/** Writes an owner-only JSON audit snapshot of the ACTUALLY-applied changes, for reversibility. */
export function writeBackupSnapshot(result: SchemaResult, mode: BackfillMode, stamp: string): string | null {
  if (result.appliedChanges.length === 0) return null;
  const backupPath = path.join(
    os.tmpdir(),
    `trockcrm-null-region-backfill-${mode}-${result.schema}-${stamp}.json`
  );
  const changes = result.appliedChanges.map((c) => ({
    id: c.dealId,
    dealNumber: c.dealNumber,
    from: null,
    to: c.targetRegionId,
    toName: c.targetRegionName,
  }));
  fs.writeFileSync(
    backupPath,
    `${JSON.stringify({ schema: result.schema, mode, revert: "SET region_id = NULL WHERE id IN (changes.id)", changes }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 }
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
  const { mode } = parseBackfillArgs(argv);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  console.log(`[null-region-backfill] mode=${mode}`);

  const client = new pg.Client({ connectionString: resolveDatabaseUrl(), ssl: buildSslConfig() });
  await client.connect();

  let totalCandidates = 0;
  let totalPlanned = 0;
  let totalApplied = 0;
  let totalInactivePlanned = 0;
  const skippedOffices: string[] = [];
  try {
    const regions = await fetchActiveRegions(client);
    console.log(
      `[null-region-backfill] active regions: ${regions.map((r) => `${r.name} (${r.slug})`).join(", ") || "(none)"}`
    );
    if (mode === "commit") assertTargetRegionsPresent(regions);

    const schemas = await discoverOfficeSchemas(client);
    console.log(`[null-region-backfill] offices: ${schemas.join(", ") || "(none found)"}`);

    for (const schema of schemas) {
      try {
        const missing = await missingDealColumns(client, schema);
        if (missing.length > 0) {
          skippedOffices.push(schema);
          console.warn(`\n=== ${schema} === SKIPPED (schema drift): deals is missing column(s): ${missing.join(", ")}`);
          continue;
        }

        const result = await runBackfillForSchema(client, schema, regions, mode);
        totalCandidates += result.plan.counts.candidateDeals;
        totalPlanned += result.plan.counts.willUpdate;
        totalApplied += result.appliedChanges.length;
        totalInactivePlanned += result.plan.counts.inactiveDealsUpdated;

        console.log(`\n=== ${schema} ===`);
        console.log("  before:", JSON.stringify(result.before));
        console.log(
          `  candidates(null region): ${result.plan.counts.candidateDeals} | willUpdate: ${result.plan.counts.willUpdate}` +
            ` | leftBlank: noState=${result.plan.counts.noState} unmapped=${result.plan.counts.unmappedState}` +
            ` | inactiveAmongUpdates: ${result.plan.counts.inactiveDealsUpdated}`
        );
        console.log("  byTargetRegion:", JSON.stringify(result.plan.byTargetRegion));
        const shown = mode === "commit" ? result.appliedChanges : result.plan.changes;
        for (const c of shown) {
          console.log(`    ${c.dealNumber} (${c.dealId})${c.isActive ? "" : " [inactive]"}: -- → ${c.targetRegionName} [${c.effectiveState}]`);
        }
        if (mode === "commit") {
          console.log(`  applied: ${result.appliedChanges.length}`);
          console.log("  after:", JSON.stringify(result.after));
          try {
            const snapshot = writeBackupSnapshot(result, mode, stamp);
            if (snapshot) console.log(`  audit snapshot: ${snapshot}`);
          } catch (snapshotError) {
            console.warn("  audit snapshot write failed (applied changes already printed above):", snapshotError);
          }
        }
        if (result.plan.counts.missingTargetRegion > 0) {
          console.warn(`  WARNING: ${result.plan.counts.missingTargetRegion} deal(s) had no matching active region_config row.`);
        }
      } catch (schemaError) {
        console.error(`\n=== ${schema} === SKIPPED due to error:`, schemaError);
      }
    }

    const processed = schemas.length - skippedOffices.length;
    console.log(
      `\n[null-region-backfill] ${mode === "commit" ? "applied" : "would update"} ` +
        `${mode === "commit" ? totalApplied : totalPlanned} of ${totalCandidates} null-region deal(s) ` +
        `across ${processed} office(s); ${totalInactivePlanned} of the updates are inactive deals.`
    );
    if (skippedOffices.length > 0) {
      console.warn(`[null-region-backfill] skipped ${skippedOffices.length} office(s) for schema drift: ${skippedOffices.join(", ")}`);
    }
    if (mode !== "commit") {
      console.log("[null-region-backfill] dry-run only — re-run with --commit to apply.");
    }
  } finally {
    await client.end();
  }
}

const executedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === executedPath) {
  main().catch((error) => {
    console.error("[null-region-backfill] failed:", error);
    process.exit(1);
  });
}
