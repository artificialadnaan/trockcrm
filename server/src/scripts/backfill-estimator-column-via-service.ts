/**
 * One-time backfill: LINK the legacy free-text `estimator` column to a real CRM user — SAFELY, by invoking
 * setDealEstimator per deal (NOT a raw UPDATE).
 *
 * WHY (and why not a raw UPDATE): ~143 historical deals carry their estimator only as a first-name-only
 * free-text string in deals.estimator ("Tim", "sid", "alex", "colby", "James") with a NULL
 * estimator_user_id. A raw `UPDATE deals SET estimator_user_id = …` was tried and REVERTED: it bypasses
 * every guard the app relies on to keep money attribution consistent —
 *   • change-order rejection            (a CO's estimator is inherited from the parent, never set here),
 *   • sales-source-conflict rejection   (estimator can't equal the deal's sales source — double cut),
 *   • per-office access                 (the estimator must have access to the deal's office),
 *   • Bid-Board-ownership first-fill    (the FIRST estimator on a BB-owned deal is the sync's to set),
 *   • the ATOMIC additive estimator-commission mint (the estimator's extra deal_signed_commissions row).
 * setDealEstimator enforces all of these in ONE transaction and mints the commission itself, so INVOKING
 * it is the supported path — and it CORRECTLY SKIPS (throws) the deals that must not auto-link. This
 * script resolves the free-text name to a user id via the SAME curated map the Bid Board ingest uses
 * (BID_BOARD_ESTIMATOR_USER_MAP / resolveEstimatorUserId — NFC/lowercase/trim normalized, never fuzzy),
 * then calls setDealEstimator once per resolvable candidate, classifying every guard rejection as a SKIP
 * and CONTINUING (a guard-skip on one deal never aborts the run).
 *
 * RELATIONSHIP TO backfill-estimator-commissions.ts: that sibling mints the MISSING commission ROW for
 * deals whose estimator_user_id is ALREADY set. This one sets the estimator_user_id COLUMN (via the
 * service, which mints the row as a side effect) for deals where it is still NULL but the legacy
 * free-text `estimator` column names someone we can resolve. Run this FIRST (it populates the column);
 * the commission sibling is then a belt-and-braces no-op for anything this already linked.
 *
 * GUARANTEES:
 *   • NO raw UPDATE of estimator_user_id — every write goes through setDealEstimator, so every guard fires
 *     and the estimator commission is minted atomically with the column change (or nothing happens).
 *   • Faithful dry-run — dry-run runs the REAL setDealEstimator inside an outer transaction and rolls it
 *     back (via a thrown DRY_RUN_ROLLBACK symbol), so the reported outcome (assigned / skipped:<reason>)
 *     is EXACTLY what --commit would do, guard rejections included. setDealEstimator opens its own inner
 *     transaction; a savepoint nests cleanly under the outer one so the rollback is total.
 *   • Guard rejections are SKIPS, not failures — a thrown AppError (change order, sales-source conflict,
 *     BB first-fill, office access) is caught, classified skipped:<code>, logged, and the run CONTINUES.
 *   • Per-office — fans out over every office_* schema (or a single --tenant=office_x). The office_id
 *     passed to setDealEstimator is resolved from public.offices by the schema's slug (office_<slug>).
 *   • The commission EARNER is the resolved estimator (set by setDealEstimator). The OPERATOR (--actor) is
 *     stamped as the change actor / created_by, so the audit trail records who ran this historical link.
 *
 * USAGE (dry-run is the DEFAULT — nothing is written without --commit):
 *   railway run --service=Postgres npx tsx server/src/scripts/backfill-estimator-column-via-service.ts                          # dry-run, all offices
 *   railway run --service=Postgres npx tsx server/src/scripts/backfill-estimator-column-via-service.ts --tenant=office_dallas    # dry-run, one office
 *   railway run --service=Postgres npx tsx server/src/scripts/backfill-estimator-column-via-service.ts --commit --actor=<uuid>   # WRITE
 *
 * --commit REQUIRES --actor=<uuid> (the operator/system user stamped as the change actor / created_by).
 * --tenant=/--actor= must use the '=' form (the space-separated form is rejected to avoid silently
 * widening the blast radius). resolveEstimatorUserId is INERT (resolves nothing) until
 * BID_BOARD_ESTIMATOR_USER_MAP is set on the CRM server, so a dry-run with an unset map reports zero
 * resolvable candidates — set the same env the ingest uses before running.
 */
import pg from "pg";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, eq, sql } from "drizzle-orm";
import * as schema from "@trock-crm/shared/schema";
import { LOST_DEAL_STAGE_SLUGS } from "@trock-crm/shared/types";
import { AppError } from "../middleware/error-handler.js";
import { setDealEstimator } from "../modules/deals/service.js";
import { resolveEstimatorUserId } from "../modules/bid-board-sync/estimator-map.js";

// Canonical lost/canceled pipeline stages: ["lost","deal_canceled","production_lost","service_lost","closed_lost"].
// setDealEstimator ALWAYS mints the additive estimator commission (mintEstimatorCommissionForDeal has no stage
// gate) and a lost deal retains its owner commission row, so a signed-then-lost deal would wrongly earn an
// estimator cut. We EXCLUDE lost deals from candidacy (mirrors backfill-estimator-commissions.ts) — they are
// also never shown by the estimator pipeline report (scope = open + won YTD), so there is no reason to link them.
const LOST_STAGE_SLUG_SET: ReadonlySet<string> = new Set(LOST_DEAL_STAGE_SLUGS);

type TenantDb = NodePgDatabase<typeof schema>;
type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

// Dry-run runs the REAL setDealEstimator inside an outer transaction and throws this to roll it back, so
// the reported outcome is exactly what --commit would write. Thrown/caught by identity, never surfaced.
const DRY_RUN_ROLLBACK = Symbol("dry-run-rollback");

// Office schemas only — validated before interpolating into SET search_path (--tenant is user input).
const OFFICE_SCHEMA_RE = /^office_[a-z0-9_]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Test-visible accessor for the search_path injection guard (the RE itself stays module-private). */
export function OFFICE_SCHEMA_RE_test(name: string): boolean {
  return OFFICE_SCHEMA_RE.test(name);
}

/**
 * A candidate row read from the deals table (BEFORE name resolution). Only the raw free-text `estimator`
 * string is carried; resolution to a user id happens in memory via resolveEstimatorUserId so the SQL stays
 * a pure column read (no user-map coupling in the query).
 */
export interface EstimatorColumnRow {
  dealId: string;
  dealNumber: string | null;
  estimatorText: string;
}

/**
 * A candidate whose free-text `estimator` RESOLVED to a real user id via the curated map. Only these are
 * handed to setDealEstimator; unresolvable names are dropped (counted skipped:unresolved).
 */
export interface ResolvedEstimatorCandidate extends EstimatorColumnRow {
  resolvedUserId: string;
}

export type EstimatorColumnBackfillStatus =
  | "assigned"
  | "skipped:unresolved"
  | "skipped:deal_not_found"
  | "skipped:no_change" // setDealEstimator returned the row unchanged (already had this estimator — race)
  | `skipped:${string}`; // AppError code (CHANGE_ORDER_FIELD_LOCKED, SALES_SOURCE_CONFLICT, …) or status

export interface EstimatorColumnBackfillSummary {
  schema: string;
  executed: boolean;
  officeId: string | null;
  candidates: number; // resolvable candidates handed to setDealEstimator
  scanned: number; // rows matching the column predicate BEFORE resolution
  unresolved: number; // rows whose free-text name did not resolve to a user id
  byStatus: Record<string, number>;
  rows: Array<ResolvedEstimatorCandidate & { status: EstimatorColumnBackfillStatus }>;
}

/**
 * THE candidate predicate: manual estimator-column deals with a NULL estimator_user_id and NO Bid-Board
 * name. Contains ONLY column references — no user input — so it is safe as static SQL.
 *
 *   • estimator_user_id IS NULL                       — not yet linked (setDealEstimator would no-op if set)
 *   • NULLIF(BTRIM(estimator),'') IS NOT NULL          — the legacy free-text estimator column is populated
 *   • NULLIF(BTRIM(bid_board_estimator),'') IS NULL    — NOT a Bid-Board-sourced name (those are the sync's
 *                                                        to resolve at ingest; this backfill is only for the
 *                                                        manual first-name-only column)
 *   • COALESCE(is_test_data, false) = false            — never link/mint on a test/demo deal (setDealEstimator
 *                                                        has no test-data guard; prod reads, commission reports,
 *                                                        and the sibling commission backfill all exclude them)
 *
 * NOTE: is_active / change-order / office-access / BB-ownership are NOT filtered here — setDealEstimator is
 * the authority on those and SKIPS (returns null or throws a classified AppError) any deal that must not
 * auto-link. Selecting broadly and letting the service reject is deliberate: the guards are the spec.
 */
export const CANDIDATE_COLUMN_SQL = `
  estimator_user_id IS NULL
  AND NULLIF(BTRIM(estimator), '') IS NOT NULL
  AND NULLIF(BTRIM(bid_board_estimator), '') IS NULL
  AND COALESCE(is_test_data, false) = false
`;

/**
 * Rows matching the column predicate (pre-resolution), EXCLUDING lost/canceled stages. The
 * pipeline_stage_config join exposes psc.slug so we can drop lost deals (see LOST_STAGE_SLUG_SET) — the same
 * money-safety exclusion backfill-estimator-commissions.ts applies. ORDER BY deal_number for stable logs.
 */
export async function findEstimatorColumnRows(query: QueryFn): Promise<EstimatorColumnRow[]> {
  const lostPlaceholders = LOST_DEAL_STAGE_SLUGS.map((_, i) => `$${i + 1}`).join(", ");
  const { rows } = await query(
    `
    SELECT d.id AS deal_id, d.deal_number, BTRIM(d.estimator) AS estimator_text
    FROM deals d
    JOIN pipeline_stage_config psc ON psc.id = d.stage_id
    WHERE ${CANDIDATE_COLUMN_SQL}
      AND psc.slug NOT IN (${lostPlaceholders})
    ORDER BY d.deal_number
  `,
    [...LOST_DEAL_STAGE_SLUGS]
  );
  return rows.map((r) => ({
    dealId: String(r.deal_id),
    dealNumber: r.deal_number == null ? null : String(r.deal_number),
    estimatorText: String(r.estimator_text),
  }));
}

/**
 * Resolve each row's free-text `estimator` to a user id via the curated Bid-Board map (the SAME
 * resolveEstimatorUserId the ingest uses — NFC/lowercase/trim normalized, never fuzzy). Rows that do not
 * resolve are returned separately so they can be counted skipped:unresolved (never handed to the service).
 */
export function resolveCandidates(rows: EstimatorColumnRow[]): {
  resolved: ResolvedEstimatorCandidate[];
  unresolved: EstimatorColumnRow[];
} {
  const resolved: ResolvedEstimatorCandidate[] = [];
  const unresolved: EstimatorColumnRow[] = [];
  for (const row of rows) {
    const resolvedUserId = resolveEstimatorUserId(row.estimatorText);
    if (resolvedUserId) {
      resolved.push({ ...row, resolvedUserId });
    } else {
      unresolved.push(row);
    }
  }
  return { resolved, unresolved };
}

/** Classify a thrown error into a stable skip status. AppError → its code (or `http:<status>`); any other
 * throw is re-raised (it's a bug / infra fault, not a guard rejection, and must fail the run). */
function classifyError(err: unknown): EstimatorColumnBackfillStatus {
  if (err instanceof AppError) {
    // setDealEstimator's guards throw AppError with a code: CHANGE_ORDER_FIELD_LOCKED (409),
    // SALES_SOURCE_CONFLICT (422), BID_BOARD_OWNED_ESTIMATOR_LOCKED (409). validateAssignee throws a
    // code-less AppError(400) ("Assigned user … inactive" / "… does not have access to this office") →
    // fall back to the HTTP status so those are still classifiable, distinct skips.
    return `skipped:${err.code ?? `http_${err.statusCode}`}`;
  }
  throw err;
}

/**
 * Run setDealEstimator for one resolved candidate. On --commit it commits; on a dry-run it runs the REAL
 * service call inside an outer transaction and rolls it back so the reported outcome is faithful.
 *
 * FAITHFUL DRY-RUN MECHANICS: setDealEstimator opens its OWN inner tenantDb.transaction. Postgres/pg-node
 * nests that as a SAVEPOINT when a transaction is already open, so wrapping the whole call in an outer
 * transaction and throwing DRY_RUN_ROLLBACK after it returns rolls back the inner savepoint AND the outer
 * transaction together — nothing persists, yet the guards ran and either returned an updated row or threw.
 * We capture the outcome BEFORE throwing the rollback symbol so a would-be success is reported as such.
 */
export async function runOne(
  tenantDb: TenantDb,
  candidate: ResolvedEstimatorCandidate,
  actorUserId: string,
  officeId: string | null,
  execute: boolean
): Promise<EstimatorColumnBackfillStatus> {
  const attempt = async (tx: TenantDb): Promise<EstimatorColumnBackfillStatus> => {
    // Re-check the FULL candidate predicate under a row lock before touching the deal. The candidate scan is
    // unlocked, so between it and here a concurrent write (e.g. the RFP edit path, a manual estimator edit, a
    // stage move) could have: assigned an estimator, changed the free-text `estimator`, populated
    // `bid_board_estimator` (now Bid-Board sourced), or moved the deal to a LOST stage. setDealEstimator would
    // otherwise happily overwrite / mint against stale text — and the post-call comparison could NOT detect a
    // concurrent assignment (the row would already equal our value). Re-verify everything while holding the
    // lock; setDealEstimator re-locks this same row in its own nested transaction (SAVEPOINT), and re-taking a
    // lock we already hold is a no-op, so there is no deadlock.
    const [locked] = await tx
      .select({
        estimatorUserId: schema.deals.estimatorUserId,
        estimatorText: sql<string | null>`NULLIF(BTRIM(${schema.deals.estimator}), '')`,
        bidBoardEstimator: sql<string | null>`NULLIF(BTRIM(${schema.deals.bidBoardEstimator}), '')`,
        stageSlug: schema.pipelineStageConfig.slug,
        isTestData: schema.deals.isTestData,
      })
      .from(schema.deals)
      .innerJoin(schema.pipelineStageConfig, eq(schema.pipelineStageConfig.id, schema.deals.stageId))
      .where(and(eq(schema.deals.id, candidate.dealId), eq(schema.deals.isActive, true)))
      .limit(1)
      .for("update", { of: schema.deals });
    if (!locked) return "skipped:deal_not_found"; // not found / soft-deleted since the scan
    if (locked.estimatorUserId != null) return "skipped:no_change"; // concurrently assigned between scan and lock
    if (locked.estimatorText !== candidate.estimatorText) return "skipped:no_change"; // free-text changed since scan
    if (locked.bidBoardEstimator != null) return "skipped:no_change"; // now Bid-Board sourced (the sync owns it)
    if (locked.isTestData === true) return "skipped:no_change"; // flagged test/demo since the scan — never link/mint
    if (LOST_STAGE_SLUG_SET.has(locked.stageSlug)) return "skipped:lost_stage"; // moved to a lost stage since scan
    const updated = await setDealEstimator(tx, candidate.dealId, candidate.resolvedUserId, actorUserId, officeId);
    if (!updated) return "skipped:deal_not_found";
    if (updated.estimatorUserId !== candidate.resolvedUserId) return "skipped:no_change";
    return "assigned";
  };

  if (execute) {
    // Wrap the lock+recheck+service call in ONE transaction so the row lock is held across the recheck and
    // the write (setDealEstimator nests as a savepoint). A guard rejection throws → the tx rolls back → the
    // error is classified as a skip and the run continues (one bad deal never aborts the batch).
    try {
      return await tenantDb.transaction(async (tx) => attempt(tx));
    } catch (err) {
      return classifyError(err);
    }
  }

  // Faithful dry-run: run the real lock+recheck+service call inside an outer transaction, capture the
  // outcome, then roll everything back so nothing persists (identical code path to --commit above).
  let captured: EstimatorColumnBackfillStatus = "skipped:unresolved";
  try {
    await tenantDb.transaction(async (tx) => {
      try {
        captured = await attempt(tx);
      } catch (err) {
        // A guard rejection is a real outcome — capture it, then still roll back the (partial) tx cleanly.
        captured = classifyError(err);
      }
      throw DRY_RUN_ROLLBACK;
    });
  } catch (err) {
    if (err !== DRY_RUN_ROLLBACK) throw err;
  }
  return captured;
}

export async function backfillTenantEstimatorColumn(
  tenantDb: TenantDb,
  query: QueryFn,
  opts: { schema: string; execute: boolean; actorUserId: string; officeId: string | null }
): Promise<EstimatorColumnBackfillSummary> {
  const scannedRows = await findEstimatorColumnRows(query);
  const { resolved, unresolved } = resolveCandidates(scannedRows);

  const byStatus: Record<string, number> = {};
  const bump = (status: string) => {
    byStatus[status] = (byStatus[status] ?? 0) + 1;
  };
  const rows: EstimatorColumnBackfillSummary["rows"] = [];

  for (const candidate of resolved) {
    const status = await runOne(tenantDb, candidate, opts.actorUserId, opts.officeId, opts.execute);
    bump(status);
    rows.push({ ...candidate, status });
  }
  // Count EVERY unresolved row under one bucket (they're never handed to the service). Bump per row, not
  // once — otherwise a tenant with many unmapped names reports skipped:unresolved=1 and the operator badly
  // under-estimates the manual cleanup backlog (prod has ~126 such rows in office_dallas alone).
  for (let i = 0; i < unresolved.length; i++) bump("skipped:unresolved");

  return {
    schema: opts.schema,
    executed: opts.execute,
    officeId: opts.officeId,
    candidates: resolved.length,
    scanned: scannedRows.length,
    unresolved: unresolved.length,
    byStatus,
    rows,
  };
}

export function parseArgs(argv: string[]): { tenant: string | null; execute: boolean; actorUserId: string | null } {
  // --tenant / --actor are execution-safety controls. Reject the space-separated form (--tenant office_x)
  // FIRST, so its specific "use '='" message fires (rather than the generic unknown-argument error below on
  // the stray value token). Silently ignoring them would widen the blast radius or drop the audit actor.
  for (const key of ["--tenant", "--actor"]) {
    if (argv.includes(key)) {
      throw new Error(`Use ${key}=<value> (with '='); the space-separated form is rejected.`);
    }
  }
  // Then reject ANY remaining unrecognized argument. A misspelled safety flag (e.g. --tennant=office_dallas)
  // would otherwise be silently ignored, leaving tenant=null so a --commit writes across EVERY discovered
  // tenant. Recognized: --commit, --tenant=<office_x>, --actor=<uuid> (bare --tenant/--actor already threw).
  for (const arg of argv) {
    const recognized = arg === "--commit" || arg.startsWith("--tenant=") || arg.startsWith("--actor=");
    if (!recognized) {
      throw new Error(`Unknown argument ${JSON.stringify(arg)}. Valid: --commit, --tenant=<office_x>, --actor=<uuid>.`);
    }
  }
  const readValue = (key: string): string | null => {
    const arg = argv.find((a) => a.startsWith(`${key}=`));
    if (!arg) return null;
    const value = arg.slice(key.length + 1);
    if (!value) throw new Error(`${key}= requires a value.`);
    return value;
  };
  const tenant = readValue("--tenant");
  // The write flag is --commit (dry-run is the default). A WRITE must record a real operator/system actor
  // as the change actor / created_by — never default it.
  const execute = argv.includes("--commit");
  const actor = readValue("--actor");
  if (execute && !actor) {
    throw new Error("--commit requires --actor=<uuid> (the operator/system user recorded as the change actor / created_by).");
  }
  if (actor && !UUID_RE.test(actor)) {
    throw new Error(`--actor must be a UUID, got ${JSON.stringify(actor)}.`);
  }
  return {
    tenant: tenant && tenant !== "all" ? tenant : null,
    execute,
    actorUserId: actor,
  };
}

async function discoverTenants(client: pg.Client): Promise<string[]> {
  const { rows } = await client.query<{ nspname: string }>(
    `SELECT nspname FROM pg_namespace WHERE nspname LIKE 'office\\_%' ESCAPE '\\' ORDER BY nspname`
  );
  return rows.map((r) => r.nspname);
}

/**
 * Resolve the office_id for a schema by its slug. The schema name is `office_<slug>` (see
 * provisionOfficeSchema / tenant middleware), so strip the `office_` prefix and look the slug up in
 * public.offices. Returns null (with a warning) if no office row matches — setDealEstimator's
 * validateAssignee then can't office-scope by id, so those candidates skip on office access rather than
 * silently linking against the wrong office. The schema name is already OFFICE_SCHEMA_RE-validated upstream.
 */
async function resolveOfficeId(client: pg.Client, schemaName: string): Promise<string | null> {
  const slug = schemaName.replace(/^office_/, "");
  const { rows } = await client.query<{ id: string }>(
    "SELECT id FROM public.offices WHERE slug = $1 AND is_active = true LIMIT 1",
    [slug]
  );
  return rows[0]?.id ?? null;
}

function printSummary(s: EstimatorColumnBackfillSummary): void {
  const mode = s.executed ? "WRITE" : "DRY-RUN";
  console.log(
    `\n[${s.schema}] ${mode} — office_id=${s.officeId ?? "(unresolved)"} — scanned ${s.scanned}, ` +
      `${s.candidates} resolvable candidate(s), ${s.unresolved} unresolved`
  );
  for (const row of s.rows) {
    console.log(
      `  ${(row.dealNumber ?? "(none)").padEnd(16)} "${row.estimatorText}" -> ${row.resolvedUserId}  => ${row.status}`
    );
  }
  const statusPairs = Object.entries(s.byStatus)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  console.log(`  totals: ${statusPairs || "(none)"}`);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { tenant, execute, actorUserId } = parseArgs(argv);
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const tenants = tenant ? [tenant] : await discoverTenants(client);
    // Guard the search_path interpolation: every tenant (especially a user-supplied --tenant=) must be a
    // valid office_* schema identifier — no quotes/semicolons/spaces — so it cannot be a SQL-injection vector.
    for (const t of tenants) {
      if (!OFFICE_SCHEMA_RE.test(t)) {
        throw new Error(`Refusing unsafe tenant schema name: ${JSON.stringify(t)} (expected /^office_[a-z0-9_]+$/)`);
      }
    }
    // On a WRITE, --actor is required (parseArgs). On a dry-run without --actor we STILL need a REAL user id
    // for the rolled-back created_by: deal_signed_commissions.created_by is an FK to users(id) (migration 0062
    // — NOT declared in the drizzle schema, so the PGlite tests don't enforce it), so a synthetic zero-uuid
    // FK-violates on the FIRST signed candidate's minted commission and aborts the whole preview (rolling back
    // afterward does not suppress the constraint check). Fall back to any active user (the value is thrown
    // away on rollback); prefer the real --actor when supplied so the preview's created_by matches the write.
    let effectiveActor = actorUserId;
    if (!effectiveActor) {
      const { rows } = await client.query<{ id: string }>(
        "SELECT id FROM public.users WHERE is_active = true ORDER BY id LIMIT 1"
      );
      effectiveActor = rows[0]?.id ?? null;
      if (!effectiveActor) {
        throw new Error("No active user available for the throwaway dry-run actor; pass --actor=<uuid>.");
      }
    } else {
      // Validate a SUPPLIED --actor up front. It is stamped as deal_signed_commissions.created_by (an FK to
      // users) AND the audit_log.changed_by (NO FK). A syntactically-valid but nonexistent UUID would let
      // unsigned candidates commit deal changes + a bogus audit actor, then FK-fail on the first SIGNED
      // candidate's minted commission — a partially-completed run with an invalid audit trail. Fail before the
      // tenant loop instead.
      const { rows } = await client.query<{ ok: number }>("SELECT 1 AS ok FROM public.users WHERE id = $1", [
        effectiveActor,
      ]);
      if (rows.length === 0) {
        throw new Error(`--actor ${effectiveActor} is not a known user (public.users); pass a real operator/system user id.`);
      }
    }
    console.log(`${execute ? "WRITE" : "DRY-RUN (no writes)"} — tenants: ${tenants.join(", ")}`);
    let grandAssigned = 0;
    let grandSkipped = 0;
    for (const t of tenants) {
      const officeId = await resolveOfficeId(client, t);
      if (!officeId) {
        // FAIL CLOSED: without an office id, validateAssignee's per-office access check is a NO-OP (it only
        // runs `if (officeId && …)`), so any active mapped user would link WITHOUT office validation. Refuse
        // to run this tenant unscoped rather than risk a cross-office attribution.
        const message = `[${t}] no active public.offices row for slug '${t.replace(/^office_/, "")}'. Refusing to run unscoped (office-access checks are a no-op with a null office id).`;
        // For an EXPLICITLY requested --tenant, FAIL the command — silently skipping the only requested tenant
        // would exit 0 with a zero grand total and let automation record a "successful" backfill that did
        // nothing. For automatic multi-tenant discovery, skip-and-continue so one bad tenant can't abort the sweep.
        if (tenant) throw new Error(message);
        console.warn(`${message} SKIPPED (multi-tenant discovery).`);
        continue;
      }
      // Confirm the tenant actually OWNS a deals table before SET search_path. If an office is provisioned
      // without its own deals table, an unqualified `deals` would fall through to a legacy public.deals via the
      // search_path, and --commit could mutate that unrelated table while validating against this office.
      // to_regclass returns NULL when the relation is absent (it does not error).
      const { rows: dealsReg } = await client.query<{ reg: string | null }>("SELECT to_regclass($1) AS reg", [
        `${t}.deals`,
      ]);
      if (!dealsReg[0]?.reg) {
        const message = `[${t}] has no ${t}.deals table (schema not fully provisioned).`;
        if (tenant) throw new Error(message);
        console.warn(`${message} SKIPPED (multi-tenant discovery).`);
        continue;
      }
      // OFFICE_SCHEMA_RE-validated above; also double-quote as a PG identifier at the interpolation site as
      // defense-in-depth for the SET search_path (the regex already forbids quotes/semicolons/spaces).
      await client.query(`SET search_path TO "${t}", public`);
      const tenantDb = drizzle(client, { schema });
      const summary = await backfillTenantEstimatorColumn(
        tenantDb,
        (text, params) => client.query(text, params as never),
        { schema: t, execute, actorUserId: effectiveActor, officeId }
      );
      printSummary(summary);
      grandAssigned += summary.byStatus["assigned"] ?? 0;
      grandSkipped += Object.entries(summary.byStatus)
        .filter(([k]) => k !== "assigned")
        .reduce((acc, [, v]) => acc + v, 0);
    }
    console.log(
      `\n=== GRAND TOTAL ${execute ? "LINKED" : "(dry-run) WOULD LINK"}: ${grandAssigned} deal(s) to their estimator ` +
        `(${grandSkipped} skipped by guards / unresolved) ===`
    );
    console.log("(Every link went through setDealEstimator: change-order / sales-source / office-access / Bid-Board guards enforced; estimator commission minted atomically.)");
  } finally {
    await client.end();
  }
}

const executedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === executedPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
