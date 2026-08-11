/**
 * Audit (and optionally repair) the disagreement between a deal's PROJECT TYPE and its WORKFLOW ROUTE.
 *
 * WHY THIS EXISTS. The Monday Showcase reported ~$490k of service YTD while one service rep alone showed
 * $1.1M won. Every reader narrowed on `deals.workflow_route`; the canonical definition
 * (`resolveProjectTypeCode`) says project_type WINS and workflow_route is consulted LAST. Since the column
 * is NOT NULL DEFAULT 'normal' and no write path ever derived it from the type, correctly-typed service
 * deals — deal numbers literally reading `DFW-4-…`, where 4 IS the service code — sat in the Normal bucket.
 *
 * THE REPORTS ARE ALREADY FIXED WITHOUT THIS SCRIPT. The read path now resolves service from project_type
 * (aliasedIsServiceProjectSql), so the showcase and the dashboard At Risk split are correct on today's data
 * with no write at all. This script exists for the SECOND half: `workflow_route` also drives BEHAVIOUR —
 * which pipeline family a deal travels (service_estimating vs estimating), the family a converted lead
 * lands in, and whether the deal skips RFP approval voting. Those do not read the canonical predicate, and
 * cannot: they are about which pipeline a deal is IN, not what kind of work it is.
 *
 * SO THIS IS A BEHAVIOUR CHANGE, NOT A DATA CLEANUP. Flipping a live deal's route can move it to a stage
 * family its current stage does not belong to. The census therefore reports STAGE-FAMILY MISMATCH counts
 * separately, and that number — not the headline disagreement count — is what should decide whether to run
 * the repair, and in which direction.
 *
 * ON THE PROJECT-NUMBER EMAIL. There is a standing warning that a bulk write could spam the project-number
 * notification (migration 0138, the mail Christy receives). VERIFIED AND IT DOES NOT APPLY HERE: the
 * trigger is `AFTER INSERT OR UPDATE **OF project_number**`, so an UPDATE touching only workflow_route
 * cannot fire it. (If you ever DO backfill project numbers, that trigger has an escape hatch — set
 * `app.skip_project_number_email` to 'on' for the session first.) Confirm both for yourself before a bulk
 * write; this note is a reading of 0138, not a promise about your database.
 *
 * DELIBERATELY NOT A MIGRATION. Migrations run automatically on API deploy. Reclassifying live deals is a
 * judgement call that wants a human looking at the census output first, so it lives here.
 *
 * DRY-RUN BY DEFAULT. `--execute` writes. Read the census before you pass it.
 *
 *   node --import tsx scripts/audit-service-classification.ts
 *   node --import tsx scripts/audit-service-classification.ts --direction=to-service
 *   node --import tsx scripts/audit-service-classification.ts --direction=to-service --execute
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { aliasedIsServiceProjectSql } from "../server/src/modules/shared/deal-value-sql.js";
import { SHARED_CANONICAL_DEAL_STAGE_SLUGS } from "../server/src/modules/deals/service.js";

const OFFICE_SCHEMA_PATTERN = /^office_[a-z0-9_]+$/;
const dialect = new PgDialect();

export type Direction = "to-service" | "to-normal" | "both";

export interface AuditArgs {
  execute: boolean;
  direction: Direction;
}

/**
 * `to-service` is the DEFAULT because it is the direction that fixes the reported symptom and the one
 * whose blast radius is understood. `to-normal` demotes deals someone may have deliberately routed to the
 * service pipeline despite their type, so it is opt-in.
 */
export function parseAuditArgs(argv: readonly string[] = process.argv): AuditArgs {
  const args = argv.slice(2);
  const directionArg = args.find((arg) => arg.startsWith("--direction="))?.split("=")[1];
  if (directionArg && !["to-service", "to-normal", "both"].includes(directionArg)) {
    throw new Error(`--direction must be one of: to-service, to-normal, both (got "${directionArg}")`);
  }
  return {
    execute: args.includes("--execute"),
    direction: (directionArg as Direction) ?? "to-service",
  };
}

/**
 * The canonical predicate, rendered to text ONCE. Imported from the reports layer rather than retyped, so
 * this audit cannot report a population the showcase would disagree with — which is the whole failure mode
 * that produced the bug being audited.
 */
export function canonicalServicePredicate(alias = "d"): { text: string; params: unknown[] } {
  const { sql: text, params } = dialect.sqlToQuery(aliasedIsServiceProjectSql(alias));
  return { text, params: params as unknown[] };
}

/**
 * Rows whose route was chosen by an upstream system rather than defaulted, and which the repair must NOT
 * touch. createDeal deliberately preserves an explicitly-supplied route for exactly these callers; a
 * repair that ignored that provenance would put an imported or converted deal into a pipeline its source
 * disagrees with, until the next sync reverts it — or, worse, keeps processing it under the wrong family.
 *
 *   • is_bid_board_owned — the Bid Board owns the record; direct writes are known to revert on sync.
 *   • synchub_bid_board_id — linked to a SyncHub/Procore record that drives its own stage + family.
 *   • source_lead_id — converted from a lead, where the route came from the lead's own workflow.
 */
function authoritativeRouteFor(alias: string): string {
  return `(
    COALESCE(${alias}.is_bid_board_owned, false) = true
    OR ${alias}.synchub_bid_board_id IS NOT NULL
    OR ${alias}.source_lead_id IS NOT NULL
  )`;
}

/**
 * ...AND a change order whose PARENT is protected.
 *
 * A change-order child is created by copying the parent's project_type, project_type_id,
 * pipeline_type_snapshot and workflow_route — but NOT its provenance columns (change-order-service.ts).
 * So a child of a Bid Board-owned or converted parent carries no source_lead_id, no synchub id and
 * is_bid_board_owned=false, and would sail through the row-level guard above while its parent was skipped.
 *
 * That matters because a change order's route is INHERITED, not independent: the normal update path
 * rejects edits that would diverge it from the parent. Flipping the child alone breaks the invariant in a
 * way nothing downstream expects. Where the parent is NOT protected, parent and child flip together
 * anyway — they share a project type, so the canonical predicate returns the same verdict for both.
 */
const AUTHORITATIVE_ROUTE_SQL = `(
  ${authoritativeRouteFor("d")}
  OR EXISTS (
    SELECT 1 FROM deals parent
    WHERE parent.id = d.parent_deal_id
      AND ${authoritativeRouteFor("parent")}
  )
)`;

/**
 * A service→normal demotion is not a column edit. `updateDeal` and the resolved-fields route both call
 * `clearSalesSource` on exactly this transition, because a sales-source commission cut is invalid outside
 * the service workflow; a raw UPDATE would leave the attribution and its commission state behind, live and
 * now unbacked. Rather than reimplement that cleanup in SQL — where it would drift from the ORM path that
 * owns the invariant — the repair EXCLUDES these rows and reports them for a human to move through the
 * normal write path.
 */
const HAS_SALES_SOURCE_SQL = `d.sales_source_user_id IS NOT NULL`;

/**
 * Is the deal's CURRENT stage valid for the route the repair would give it?
 *
 * A stage belongs to one workflow family, so rewriting the route alone can produce a pair the platform
 * rejects and getStageByIdForWorkflowRoute resolves to NULL. But a blanket family test is too strict in
 * one direction: a SERVICE-routed deal may legitimately sit in the SHARED standard-family stages
 * (opportunity, contract, won, …) — that is exactly what getStageByIdForWorkflowRoute accepts — so
 * excluding them would defer safe rows for ever while claiming a mismatch that does not exist.
 *
 * The shared list is IMPORTED from the service rather than retyped, so the repair and the runtime cannot
 * disagree about which pairs are legal. Demotion to `normal` has no such allowance: the normal lookup is
 * standard-family only.
 */
function stageCompatibleSql(direction: Exclude<Direction, "both">): string {
  if (direction === "to-normal") {
    return `EXISTS (
      SELECT 1 FROM pipeline_stage_config psc
       WHERE psc.id = d.stage_id AND psc.workflow_family = 'standard_deal'
    )`;
  }
  const sharedSlugs = [...SHARED_CANONICAL_DEAL_STAGE_SLUGS]
    .map((slug) => `'${slug}'`)
    .join(", ");
  return `EXISTS (
    SELECT 1 FROM pipeline_stage_config psc
     WHERE psc.id = d.stage_id
       AND (
         psc.workflow_family = 'service_deal'
         OR (psc.workflow_family = 'standard_deal' AND psc.slug IN (${sharedSlugs}))
       )
  )`;
}

export interface OfficeCensus {
  schema: string;
  activeDeals: number;
  canonicalService: number;
  routeService: number;
  /** Canonically service, routed normal — the undercount that hid service revenue. */
  toServiceCount: number;
  toServiceValue: number;
  /** Routed service, canonically NOT service — the opposite error. */
  toNormalCount: number;
  toNormalValue: number;
  /** Of the to-service rows, how many sit in a stage whose family is not the service family. */
  toServiceStageMismatch: number;
  /** Of the to-normal rows, likewise. */
  toNormalStageMismatch: number;
  /** to-service rows with no project number yet. Informational: classification never needed one. */
  toServiceMissingProjectNumber: number;
  /** Disagreeing rows whose route an upstream system owns. Excluded from the repair, reported instead. */
  authoritativeRouteSkipped: number;
  /** to-normal rows carrying a sales source. Excluded: demotion needs clearSalesSource, not an UPDATE. */
  toNormalSalesSourceSkipped: number;
}

/**
 * One pass per office. `is_active` + non-test only: a report never counts the others, so neither should a
 * census that claims to explain a report.
 *
 * The stage-family mismatch counts are the reason to read this output rather than skim it. A deal moved to
 * `workflow_route='service'` while sitting in a `standard_deal` stage is in a state the pipeline UI does
 * not model, and that is a worse outcome than the misreporting this repairs.
 */
export function buildCensusSql(): { text: string; params: unknown[] } {
  const { text: isService, params } = canonicalServicePredicate("d");
  // The predicate's own params come first; the census adds none of its own.
  return {
    text: `
      WITH scoped AS (
        SELECT
          d.id,
          d.workflow_route,
          COALESCE(NULLIF(BTRIM(d.project_number), ''), '') AS project_number,
          COALESCE(
            CASE WHEN d.awarded_amount   > 0 THEN d.awarded_amount   END,
            CASE WHEN d.bid_board_total_sales > 0 THEN d.bid_board_total_sales END,
            CASE WHEN d.bid_estimate     > 0 THEN d.bid_estimate     END,
            CASE WHEN d.dd_estimate      > 0 THEN d.dd_estimate      END,
            0
          )::numeric AS deal_value,
          psc.workflow_family,
          -- The SAME compatibility rule the repair applies, so the census can never report a mismatch the
          -- repair would have been happy to fix (or vice versa).
          ${stageCompatibleSql("to-service")} AS service_stage_ok,
          ${stageCompatibleSql("to-normal")} AS normal_stage_ok,
          ${AUTHORITATIVE_ROUTE_SQL} AS authoritative_route,
          ${HAS_SALES_SOURCE_SQL} AS has_sales_source,
          (${isService}) AS is_service
        FROM deals d
        JOIN pipeline_stage_config psc ON psc.id = d.stage_id
        WHERE d.is_active = true
          AND COALESCE(d.is_test_data, false) = false
      )
      SELECT
        COUNT(*)::int AS active_deals,
        COUNT(*) FILTER (WHERE is_service)::int AS canonical_service,
        COUNT(*) FILTER (WHERE workflow_route = 'service')::int AS route_service,

        COUNT(*) FILTER (WHERE is_service AND workflow_route IS DISTINCT FROM 'service')::int
          AS to_service_count,
        COALESCE(SUM(deal_value) FILTER (WHERE is_service AND workflow_route IS DISTINCT FROM 'service'), 0)::numeric
          AS to_service_value,

        COUNT(*) FILTER (WHERE NOT is_service AND workflow_route = 'service')::int
          AS to_normal_count,
        COALESCE(SUM(deal_value) FILTER (WHERE NOT is_service AND workflow_route = 'service'), 0)::numeric
          AS to_normal_value,

        COUNT(*) FILTER (
          WHERE is_service AND workflow_route IS DISTINCT FROM 'service'
            AND NOT service_stage_ok
        )::int AS to_service_stage_mismatch,
        COUNT(*) FILTER (
          WHERE NOT is_service AND workflow_route = 'service'
            AND NOT normal_stage_ok
        )::int AS to_normal_stage_mismatch,

        COUNT(*) FILTER (
          WHERE is_service AND workflow_route IS DISTINCT FROM 'service' AND project_number = ''
        )::int AS to_service_missing_project_number,

        COUNT(*) FILTER (
          WHERE authoritative_route
            AND ((is_service AND workflow_route IS DISTINCT FROM 'service')
              OR (NOT is_service AND workflow_route = 'service'))
        )::int AS authoritative_route_skipped,
        COUNT(*) FILTER (
          WHERE NOT is_service AND workflow_route = 'service' AND has_sales_source
        )::int AS to_normal_sales_source_skipped
      FROM scoped
    `,
    params,
  };
}

/**
 * The repair, one direction at a time. Scoped to exactly the rows the census counted, so what runs is what
 * was read — no second, looser derivation. `is_active`/test-data scoping is repeated here rather than
 * inherited, because an UPDATE that silently widened its own population is the classic version of this bug.
 */
export function buildUpdateSql(direction: Exclude<Direction, "both">): { text: string; params: unknown[] } {
  const { text: isService, params } = canonicalServicePredicate("d");
  const target = direction === "to-service" ? "service" : "normal";
  const guard =
    direction === "to-service"
      ? `(${isService}) AND d.workflow_route IS DISTINCT FROM 'service'`
      // A demotion must not strand a sales-source attribution; those rows go through the ORM path that
      // owns clearSalesSource, not this UPDATE.
      : `NOT (${isService}) AND d.workflow_route = 'service' AND NOT (${HAS_SALES_SOURCE_SQL})`;
  return {
    text: `
      UPDATE deals d
         SET workflow_route = '${target}',
             -- Kept in step with the route, exactly as createDeal and the SyncHub route updater do.
             -- pipeline_type_snapshot is NOT NULL, and the report builder groups and filters deal type on
             -- COALESCE(d.pipeline_type_snapshot, d.workflow_route) -- the SNAPSHOT first -- so leaving it
             -- behind would repair the route while that report went on showing the old classification.
             pipeline_type_snapshot = '${target}',
             updated_at = now()
       WHERE d.is_active = true
         AND COALESCE(d.is_test_data, false) = false
         -- Never overwrite a route an upstream system chose. See AUTHORITATIVE_ROUTE_SQL.
         AND NOT ${AUTHORITATIVE_ROUTE_SQL}
         -- NEVER leave a route its stage disagrees with. A stage belongs to ONE workflow family, so
         -- rewriting the route alone would produce a combination the normal update path rejects outright
         -- and getStageByIdForWorkflowRoute resolves to null — the deal would read as broken to the very
         -- code that has to move it next. Reporting the mismatch count is not a substitute for refusing
         -- the write: on production every single to-service candidate (279 of 279) is in this state, so
         -- an unguarded --execute would have corrupted all of them.
         --
         -- These rows are not lost, they are DEFERRED: the census reports them under "behaviour change",
         -- and repairing them means moving the deal to its counterpart stage as well, which is a decision
         -- about a live pipeline rather than a column edit.
         AND ${stageCompatibleSql(direction)}
         AND ${guard}
    `,
    params,
  };
}

export interface QueryClient {
  query: (text: string, values?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }>;
}

export async function discoverOfficeSchemas(client: QueryClient): Promise<string[]> {
  const result = await client.query(
    `SELECT nspname FROM pg_namespace WHERE nspname LIKE 'office\\_%' ORDER BY nspname`
  );
  return result.rows.map((row) => String(row.nspname)).filter((name) => OFFICE_SCHEMA_PATTERN.test(name));
}

export async function censusForSchema(client: QueryClient, schema: string): Promise<OfficeCensus> {
  await client.query(`SET search_path TO "${schema}", public`);
  const { text, params } = buildCensusSql();
  const { rows } = await client.query(text, params);
  const row = rows[0] ?? {};
  return {
    schema,
    activeDeals: Number(row.active_deals ?? 0),
    canonicalService: Number(row.canonical_service ?? 0),
    routeService: Number(row.route_service ?? 0),
    toServiceCount: Number(row.to_service_count ?? 0),
    toServiceValue: Number(row.to_service_value ?? 0),
    toNormalCount: Number(row.to_normal_count ?? 0),
    toNormalValue: Number(row.to_normal_value ?? 0),
    toServiceStageMismatch: Number(row.to_service_stage_mismatch ?? 0),
    toNormalStageMismatch: Number(row.to_normal_stage_mismatch ?? 0),
    toServiceMissingProjectNumber: Number(row.to_service_missing_project_number ?? 0),
    authoritativeRouteSkipped: Number(row.authoritative_route_skipped ?? 0),
    toNormalSalesSourceSkipped: Number(row.to_normal_sales_source_skipped ?? 0),
  };
}

const money = (value: number) => `$${Math.round(value).toLocaleString("en-US")}`;

export function formatCensus(census: OfficeCensus): string[] {
  return [
    `  ${census.schema}`,
    `    active, non-test deals ................ ${census.activeDeals}`,
    `    service by PROJECT TYPE (canonical) ... ${census.canonicalService}`,
    `    service by workflow_route (today) ..... ${census.routeService}`,
    `    -> would flip TO service .............. ${census.toServiceCount}  (${money(census.toServiceValue)})`,
    `         of which in a non-service stage .. ${census.toServiceStageMismatch}   << behaviour change`,
    `         of which have no project number .. ${census.toServiceMissingProjectNumber}   (classification never needed one)`,
    `    -> would flip TO normal ............... ${census.toNormalCount}  (${money(census.toNormalValue)})`,
    `         of which in a non-standard stage . ${census.toNormalStageMismatch}   << behaviour change`,
    `    SKIPPED, upstream owns the route ...... ${census.authoritativeRouteSkipped}   (bid board / SyncHub / converted lead)`,
    `    SKIPPED, carries a sales source ....... ${census.toNormalSalesSourceSkipped}   (needs clearSalesSource, not an UPDATE)`,
  ];
}

function resolveDatabaseUrl(): string {
  const url =
    process.env.CRM_DATABASE_URL?.trim() ||
    process.env.DATABASE_PUBLIC_URL?.trim() ||
    process.env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error("Missing database URL. Set CRM_DATABASE_URL, DATABASE_PUBLIC_URL, or DATABASE_URL.");
  }
  return url;
}

export async function main(argv = process.argv): Promise<void> {
  const { execute, direction } = parseAuditArgs(argv);
  const client = new pg.Client({ connectionString: resolveDatabaseUrl() });
  await client.connect();

  try {
    const schemas = await discoverOfficeSchemas(client);
    console.log(`\nService classification audit — ${schemas.length} office schema(s)`);
    console.log(execute ? `MODE: EXECUTE (${direction})` : `MODE: dry run (would apply: ${direction})`);
    console.log("");

    for (const schema of schemas) {
      const census = await censusForSchema(client, schema);
      formatCensus(census).forEach((line) => console.log(line));

      if (!execute) {
        console.log("");
        continue;
      }

      const directions: Array<Exclude<Direction, "both">> =
        direction === "both" ? ["to-service", "to-normal"] : [direction];
      for (const one of directions) {
        const { text, params } = buildUpdateSql(one);
        const result = await client.query(text, params);
        console.log(`    APPLIED ${one}: ${result.rowCount ?? 0} row(s) updated`);
      }
      console.log("");
    }

    if (!execute) {
      console.log("Nothing was written. Re-run with --execute once the stage-mismatch counts above look");
      console.log("acceptable — those rows change pipeline family and RFP voting eligibility, not just a");
      console.log("report. The showcase and dashboard numbers are ALREADY correct without this write.");
      console.log("");
    }
  } finally {
    await client.end();
  }
}

const executedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === executedPath) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
