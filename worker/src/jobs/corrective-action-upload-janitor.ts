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
 * Reclamation mirrors the shared files-service soft delete (deleteFile): is_active = false + deleted_at = now()
 * (no deleted_by — this is a system sweep, and deleted_by_user_id FKs public.users). It ONLY touches files that
 * are still active/undeleted, and it deletes the ledger row in the SAME statement so the sweep is idempotent.
 * Everything is best-effort + logged per office; one office's failure never aborts the others or throws out of
 * the scheduled tick.
 *
 * The soft-delete and ledger-delete for a schema run in ONE CTE statement (implicitly atomic in Postgres), so a
 * crash can't leave a soft-deleted file with a surviving ledger row (or vice versa) — and it needs no explicit
 * BEGIN/COMMIT, which would be unsafe across separate pool.query calls (each can land on a different pooled
 * connection).
 */
export async function runCorrectiveActionUploadJanitor(
  deps: { query?: typeof pool.query; logger?: Pick<Console, "log" | "warn" | "error"> } = {}
): Promise<{ reclaimed: number; officesSwept: number }> {
  const query = deps.query ?? pool.query.bind(pool);
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
      // Reclaim provably-abandoned uploads in ONE CTE statement per office (atomic — no explicit BEGIN/COMMIT):
      //   stale        = ledger rows past the threshold whose file is unattached (no field_scorecard_photos row)
      //                  and still active/undeleted;
      //   soft_deleted = soft-delete those files (mirrors deleteFile: is_active=false + deleted_at, no
      //                  deleted_by for a system sweep);
      //   final DELETE = remove the reclaimed ledger rows, keyed off the same set via a join on file_id.
      const staleRes = await query(
        `WITH stale AS (
           SELECT u.file_id
             FROM ${quotedSchema}.scorecard_corrective_action_uploads u
             JOIN ${quotedSchema}.files f ON f.id = u.file_id
            WHERE u.created_at < now() - interval '${STALE_UPLOAD_THRESHOLD}'
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
      );
      const count = staleRes.rowCount ?? 0;
      reclaimed += count;
      officesSwept += 1;
      if (count > 0) {
        logger.log(
          `[Worker:ca-upload-janitor] Reclaimed ${count} abandoned corrective-action upload(s) in ${schemaName}`
        );
      }
    } catch (err) {
      logger.error(`[Worker:ca-upload-janitor] Sweep failed for ${schemaName}:`, err);
    }
  }

  return { reclaimed, officesSwept };
}
