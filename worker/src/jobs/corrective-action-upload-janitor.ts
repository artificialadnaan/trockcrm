import type { PoolClient } from "pg";
import { pool } from "../db.js";

// How stale an UNATTACHED corrective-action upload must be before the janitor reclaims it. The client's
// React-unmount cleanup that discards un-submitted uploads is not reliable on browser close/refresh, so an
// abandoned upload can linger as a permanent, unattached project file. This threshold is intentionally
// conservative: a legitimately in-progress responder submits within minutes, so 24h leaves ample slack while
// still bounding orphan lifetime.
const STALE_UPLOAD_THRESHOLD = "24 hours";

function quoteIdent(identifier: string) {
  return `"${identifier.replace(/"/g, '""')}"`;
}

// The subset of a pg PoolClient the per-candidate transaction needs. `connect` hands one back; `release`
// returns it to the pool. Injectable so tests can drive the lock/re-check/soft-delete transaction without a
// real database.
export interface JanitorClient {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }>;
  release: () => void;
}

/**
 * Server-side reclamation of ABANDONED corrective-action response uploads.
 *
 * A corrective-action response upload creates a persistent `files` row plus a durable
 * `scorecard_corrective_action_uploads` ledger row at confirm time; the file is only attached to a response
 * (via a `field_scorecard_photos` row, corrective_action_id set) on submit. The client's React-unmount cleanup
 * that discards un-submitted uploads (discardCorrectiveActionUpload) is NOT reliable on browser close/refresh,
 * so an abandoned upload can linger forever as an unattached project file. This periodic sweep is the reliable
 * server-side backstop.
 *
 * For each active office schema, it reclaims a ledger/file pair that is PROVABLY abandoned — BOTH:
 *   - UNATTACHED: no `field_scorecard_photos` row references the file (an attached file — a submitted response
 *     photo with corrective_action_id set, or any evidence link — is left alone); AND
 *   - STALE: the ledger row is older than STALE_UPLOAD_THRESHOLD (a recent, still-in-progress upload is left
 *     alone).
 *
 * Concurrency (the reason each candidate is reclaimed under its OWN transaction + lock, not one office-wide
 * CTE): a responder can SUBMIT the very file this sweep is about to reclaim. submitCorrectiveActionResponse
 * (and discardCorrectiveActionUpload) take a parent-scorecard `SELECT ... FOR UPDATE` lock, validate the file
 * still active, then insert the `field_scorecard_photos` link + resolve the item — all under that lock. A
 * lock-free reclaim could interleave BETWEEN the submit's active-file validation and its link insert: the
 * janitor would read "no field_scorecard_photos row" (the submit hasn't linked yet), soft-delete the file, and
 * the submit would then attach + resolve — leaving a hidden/inactive photo in a completed response. So the
 * janitor takes the SAME parent-scorecard FOR UPDATE lock per candidate and RE-CHECKS attachment/staleness/
 * active state UNDER that lock before the soft-delete. A concurrent submit then either WINS (it linked first →
 * the re-check sees a field_scorecard_photos row → the janitor skips) or is SERIALIZED after the janitor's
 * commit (it validates the file and finds it already soft-deleted → its own active-file guard rejects it).
 *
 * Reclamation mirrors the shared files-service soft delete (deleteFile): is_active = false + deleted_at = now()
 * (no deleted_by — this is a system sweep, and deleted_by_user_id FKs public.users). It ONLY touches files that
 * are still active/undeleted, and it deletes the ledger row in the SAME statement so the sweep is idempotent.
 * Everything is best-effort + logged per office; one office's (or one candidate's) failure never aborts the
 * others or throws out of the scheduled tick.
 *
 * The soft-delete + ledger-delete for a candidate run in ONE CTE statement (implicitly atomic in Postgres)
 * INSIDE the per-candidate transaction that also holds the FOR UPDATE lock, so a crash can't leave a
 * soft-deleted file with a surviving ledger row (or vice versa), and the reclaim can't race a submit.
 */
export async function runCorrectiveActionUploadJanitor(
  deps: {
    query?: typeof pool.query;
    connect?: () => Promise<PoolClient | JanitorClient>;
    logger?: Pick<Console, "log" | "warn" | "error">;
  } = {}
): Promise<{ reclaimed: number; officesSwept: number }> {
  const query = deps.query ?? pool.query.bind(pool);
  const connect = deps.connect ?? (() => pool.connect());
  const logger = deps.logger ?? console;

  const offices = await query(
    "SELECT slug FROM public.offices WHERE is_active = true"
  );

  let reclaimed = 0;
  let officesSwept = 0;

  for (const office of offices.rows as { slug: string }[]) {
    const schemaName = `office_${office.slug}`;
    const quotedSchema = quoteIdent(schemaName);

    // Skip offices provisioned before this feature (no ledger table yet). A missing table is not an error.
    const tableExists = await query(
      "SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'scorecard_corrective_action_uploads'",
      [schemaName]
    );
    if ((tableExists.rowCount ?? 0) === 0) continue;

    try {
      // 1) Snapshot candidates: stale + unattached + still-active ledger/file pairs, WITH each row's
      //    scorecard_id (the lock key). This read is advisory only — every candidate is RE-CHECKED under the
      //    per-scorecard FOR UPDATE lock below before it is actually reclaimed, so a race between this snapshot
      //    and the lock (a concurrent submit attaching the file) is caught at reclaim time.
      const candidatesRes = await query(
        `SELECT u.file_id, u.scorecard_id
           FROM ${quotedSchema}.scorecard_corrective_action_uploads u
           JOIN ${quotedSchema}.files f ON f.id = u.file_id
          WHERE u.created_at < now() - interval '${STALE_UPLOAD_THRESHOLD}'
            AND f.is_active = true
            AND f.deleted_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM ${quotedSchema}.field_scorecard_photos p
               WHERE p.file_id = u.file_id
            )`
      );
      const candidates = candidatesRes.rows as { file_id: string; scorecard_id: string }[];
      officesSwept += 1;

      let officeReclaimed = 0;
      for (const candidate of candidates) {
        // 2) Reclaim ONE candidate under the SAME parent-scorecard FOR UPDATE lock the submit/discard paths
        //    use, re-checking attachment/staleness/active state under the lock. A dedicated client + explicit
        //    transaction is required so the lock is HELD across the re-check + soft-delete (bare pool.query
        //    calls can each land on a different pooled connection, so the lock wouldn't persist).
        const client = await connect();
        try {
          await client.query("BEGIN");
          // Take the parent-scorecard lock. A concurrent submit/discard holds this same lock while it attaches
          // the file, so acquiring it here serializes us against that submit.
          await client.query(
            `SELECT id FROM ${quotedSchema}.field_scorecards WHERE id = $1::uuid LIMIT 1 FOR UPDATE`,
            [candidate.scorecard_id]
          );
          // Re-run the exact stale + active + UNATTACHED discrimination UNDER the lock, then soft-delete the
          // file + delete the ledger row in ONE CTE (atomic). If a concurrent submit linked the file first, the
          // NOT EXISTS now fails → the CTE reclaims 0 rows → we skip this file (leaving the finalized response
          // intact). Keyed by file_id so it targets exactly this candidate.
          const reclaimRes = await client.query(
            `WITH stale AS (
               SELECT u.file_id
                 FROM ${quotedSchema}.scorecard_corrective_action_uploads u
                 JOIN ${quotedSchema}.files f ON f.id = u.file_id
                WHERE u.file_id = $1::uuid
                  AND u.created_at < now() - interval '${STALE_UPLOAD_THRESHOLD}'
                  AND f.is_active = true
                  AND f.deleted_at IS NULL
                  AND NOT EXISTS (
                    SELECT 1 FROM ${quotedSchema}.field_scorecard_photos p
                     WHERE p.file_id = u.file_id
                  )
             ),
             soft_deleted AS (
               UPDATE ${quotedSchema}.files f
                  SET is_active = false, deleted_at = now()
                 FROM stale
                WHERE f.id = stale.file_id
                RETURNING f.id
             )
             DELETE FROM ${quotedSchema}.scorecard_corrective_action_uploads u
              USING soft_deleted sd
              WHERE u.file_id = sd.id
             RETURNING u.file_id`,
            [candidate.file_id]
          );
          await client.query("COMMIT");
          officeReclaimed += reclaimRes.rowCount ?? 0;
        } catch (err) {
          await client.query("ROLLBACK").catch(() => undefined);
          logger.error(
            `[Worker:ca-upload-janitor] Reclaim failed for file ${candidate.file_id} in ${schemaName}:`,
            err
          );
        } finally {
          client.release();
        }
      }

      reclaimed += officeReclaimed;
      if (officeReclaimed > 0) {
        logger.log(
          `[Worker:ca-upload-janitor] Reclaimed ${officeReclaimed} abandoned corrective-action upload(s) in ${schemaName}`
        );
      }
    } catch (err) {
      logger.error(`[Worker:ca-upload-janitor] Sweep failed for ${schemaName}:`, err);
    }
  }

  return { reclaimed, officesSwept };
}
