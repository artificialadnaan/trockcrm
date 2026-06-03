/**
 * One-time backfill: resolve existing deals' bid_board_estimator -> estimator_user_id via
 * BID_BOARD_ESTIMATOR_USER_MAP, so the estimator-aware rep/owner filter surfaces deals that
 * were ingested before migration 0150. Idempotent (only fills NULLs) and per-tenant.
 *
 * Usage (from repo root):
 *   node --import tsx scripts/backfill-estimator-user-id.ts            # dry-run (no writes)
 *   node --import tsx scripts/backfill-estimator-user-id.ts --commit   # apply
 *
 * Requires DATABASE_URL and BID_BOARD_ESTIMATOR_USER_MAP in the environment.
 */
import { pathToFileURL } from "node:url";
import pg from "pg";

import { resolveEstimatorUserId } from "../server/src/modules/bid-board-sync/estimator-map.js";

export interface EstimatorBackfillItem {
  estimator: string;
  userId: string;
}

const OFFICE_SCHEMA_DISCOVERY_SQL =
  "SELECT nspname AS schema_name FROM pg_namespace WHERE nspname LIKE 'office\\_%' ESCAPE '\\' ORDER BY nspname";

/**
 * Validate an office schema identifier before raw interpolation. The discovery LIKE allows any
 * characters after `office_` (incl. quoted/odd identifiers), so guard with a strict allow-list —
 * mirrors validateSchemaName in the sync service and the migration's %I quoting.
 */
export function assertSafeOfficeSchema(name: string): string {
  if (!/^office_[a-z][a-z0-9_]*$/.test(name)) {
    throw new Error(`Refusing to interpolate unsafe office schema name: ${JSON.stringify(name)}`);
  }
  return name;
}

/** Pure: resolve distinct estimator names to (name -> userId) for the mapped ones, de-duplicated. */
export function planEstimatorBackfill(distinctEstimators: Array<string | null | undefined>): EstimatorBackfillItem[] {
  const seen = new Set<string>();
  const plan: EstimatorBackfillItem[] = [];
  for (const estimator of distinctEstimators) {
    if (!estimator || seen.has(estimator)) continue;
    const userId = resolveEstimatorUserId(estimator);
    if (userId) {
      seen.add(estimator);
      plan.push({ estimator, userId });
    }
  }
  return plan;
}

/** Idempotent per-tenant UPDATE: fills estimator_user_id only where it is still NULL. */
export function buildEstimatorBackfillUpdateSql(schemaName: string): string {
  return `UPDATE ${assertSafeOfficeSchema(schemaName)}.deals SET estimator_user_id = $1 WHERE bid_board_estimator = $2 AND estimator_user_id IS NULL`;
}

async function main(): Promise<void> {
  const commit = process.argv.includes("--commit");
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");

  const pool = new pg.Pool({ connectionString });
  let totalUpdated = 0;
  try {
    // Existing active users — a mapped-but-nonexistent/inactive id is skipped (FK-safe).
    const { rows: userRows } = await pool.query<{ id: string }>(`SELECT id FROM public.users WHERE is_active = true`);
    const activeUserIds = new Set(userRows.map((r) => r.id));
    const { rows: schemas } = await pool.query<{ schema_name: string }>(OFFICE_SCHEMA_DISCOVERY_SQL);
    for (const { schema_name } of schemas) {
      const schema = assertSafeOfficeSchema(schema_name);
      const { rows } = await pool.query<{ bid_board_estimator: string | null }>(
        `SELECT DISTINCT bid_board_estimator
           FROM ${schema}.deals
          WHERE bid_board_estimator IS NOT NULL AND estimator_user_id IS NULL`
      );
      const plan = planEstimatorBackfill(rows.map((r) => r.bid_board_estimator)).filter((item) => {
        if (activeUserIds.has(item.userId)) return true;
        console.warn(`[${schema}] skipping ${item.estimator} -> ${item.userId}: not an active CRM user`);
        return false;
      });
      for (const item of plan) {
        if (commit) {
          const res = await pool.query(buildEstimatorBackfillUpdateSql(schema), [item.userId, item.estimator]);
          totalUpdated += res.rowCount ?? 0;
          console.log(`[${schema}] ${item.estimator} -> ${item.userId}: ${res.rowCount ?? 0} deals`);
        } else {
          const { rows: cnt } = await pool.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM ${schema}.deals WHERE bid_board_estimator = $1 AND estimator_user_id IS NULL`,
            [item.estimator]
          );
          console.log(`[${schema}] (dry-run) ${item.estimator} -> ${item.userId}: ${cnt[0]?.n ?? 0} deals`);
        }
      }
    }
    console.log(
      commit
        ? `Done. Updated ${totalUpdated} deal(s).`
        : "Dry run complete (no writes). Re-run with --commit to apply."
    );
  } finally {
    await pool.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
