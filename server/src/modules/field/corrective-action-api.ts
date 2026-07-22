import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import {
  fieldScorecardPhotos,
  fieldScorecards,
  files,
  scorecardCorrectiveActions,
} from "@trock-crm/shared/schema";
import { AppError } from "../../middleware/error-handler.js";
import { resolveCorrectiveActionItemTx } from "./corrective-actions-service.js";

type TenantDb = NodePgDatabase<typeof schema>;

export interface CorrectiveActionResponsePhoto {
  id: string;
  fileId: string;
  clientUploadId: string | null;
  /**
   * A presigned/authorized R2 URL for the response photo, resolved through the SAME presigner the scorecard
   * evidence read uses (getFileDownloadUrl). Null when no resolver was passed or resolution failed; the
   * deal-tab thread + mobile treat it as optional and fall back to "Unavailable" without it.
   */
  url: string | null;
  caption: string | null;
}

export interface CorrectiveActionItemView {
  id: string;
  itemType: string;
  itemRef: string;
  itemLabel: string;
  status: string;
  responseComment: string | null;
  respondedByUserId: string | null;
  responderName: string | null;
  responderEmail: string | null;
  respondedAt: string | null;
  /** Response-evidence photos linked to this item (corrective_action_id = this item). */
  photos: CorrectiveActionResponsePhoto[];
}

/**
 * The corrective-action items for a scorecard (each flagged action item / critical deficiency), with their
 * inline response (comment + responder + response photos). Used by the read endpoint for BOTH the in-app
 * (session) and tokenized web (email-only) responder flows — the caller has already authorized access to
 * this scorecard. Throws 404 if the scorecard has no corrective-action items (not below-band, or unknown).
 *
 * Response photos carry a resolvable `url` when the caller passes `resolvePhotoUrl` (the same presigner the
 * scorecard evidence read uses); without it the url is null and the client shows "Unavailable".
 */
export async function getCorrectiveActionItems(
  db: TenantDb,
  scorecardId: string,
  opts?: { resolvePhotoUrl?: (fileId: string) => Promise<string | null> },
): Promise<CorrectiveActionItemView[]> {
  const rows = await db
    .select()
    .from(scorecardCorrectiveActions)
    .where(eq(scorecardCorrectiveActions.scorecardId, scorecardId))
    // Group by kind (item_type) as before, then order refs NUMERICALLY: action-item item_ref is a numeric
    // STRING ("0".."49"), so a lexical sort gives 0,1,10,11,2,… once there are ≥11 items. Zero-pad numeric
    // refs so they sort numerically without a cast that could error on deficiency KEY refs (non-numeric).
    .orderBy(
      scorecardCorrectiveActions.itemType,
      sql`CASE WHEN ${scorecardCorrectiveActions.itemRef} ~ '^[0-9]+$' THEN lpad(${scorecardCorrectiveActions.itemRef}, 12, '0') ELSE ${scorecardCorrectiveActions.itemRef} END`,
    );
  if (rows.length === 0) {
    throw new AppError(404, "No corrective actions for this scorecard.");
  }

  const itemIds = rows.map((r) => r.id);
  const photoRows = itemIds.length
    ? await db
        .select({
          id: fieldScorecardPhotos.id,
          correctiveActionId: fieldScorecardPhotos.correctiveActionId,
          fileId: fieldScorecardPhotos.fileId,
          clientUploadId: files.clientUploadId,
          caption: files.description,
        })
        .from(fieldScorecardPhotos)
        .innerJoin(
          files,
          and(eq(files.id, fieldScorecardPhotos.fileId), eq(files.isActive, true), isNull(files.deletedAt)),
        )
        .where(inArray(fieldScorecardPhotos.correctiveActionId, itemIds))
    : [];
  // Resolve each response photo's presigned URL once (deduped by fileId), concurrently, so a repeated file id
  // doesn't presign twice and read latency doesn't scale with the photo count.
  const resolvePhotoUrl = opts?.resolvePhotoUrl;
  const uniqueFileIds = [...new Set(photoRows.map((p) => p.fileId))];
  const urlByFileId = new Map<string, string | null>();
  if (resolvePhotoUrl) {
    await Promise.all(
      uniqueFileIds.map(async (fileId) => {
        urlByFileId.set(fileId, await resolvePhotoUrl(fileId));
      }),
    );
  }

  const photosByItem = new Map<string, CorrectiveActionResponsePhoto[]>();
  for (const p of photoRows) {
    if (!p.correctiveActionId) continue;
    const list = photosByItem.get(p.correctiveActionId) ?? [];
    list.push({
      id: p.id,
      fileId: p.fileId,
      clientUploadId: p.clientUploadId ?? null,
      url: urlByFileId.get(p.fileId) ?? null,
      caption: p.caption ?? null,
    });
    photosByItem.set(p.correctiveActionId, list);
  }

  return rows.map((r) => ({
    id: r.id,
    itemType: r.itemType,
    itemRef: r.itemRef,
    itemLabel: r.itemLabel,
    status: r.status,
    responseComment: r.responseComment ?? null,
    respondedByUserId: r.respondedByUserId ?? null,
    responderName: r.responderName ?? null,
    responderEmail: r.responderEmail ?? null,
    respondedAt: r.respondedAt ? r.respondedAt.toISOString() : null,
    photos: photosByItem.get(r.id) ?? [],
  }));
}

export interface SubmitCorrectiveActionResponseInput {
  scorecardId: string;
  itemId: string;
  comment: string;
  /** Already-uploaded file ids to attach as response evidence (must belong to the scorecard's deal). */
  photoFileIds?: string[];
  respondedBy: { userId: string | null; name: string | null; email: string | null };
}

/**
 * Submit a per-item corrective-action response: link any already-uploaded photos to the item
 * (field_scorecard_photos.corrective_action_id), then resolve the item (auto-closing the scorecard when it's
 * the last open item). The caller has already authorized access (session or token) and MUST run this inside
 * a transaction (the route wraps it in runInOfficeTransaction) so the OPEN-status gate, the photo inserts,
 * and the resolve are ONE atomic unit under the parent-scorecard FOR UPDATE lock.
 *
 * Atomicity (spec §8): everything below shares the caller's transaction + the parent-scorecard lock. Without
 * that, two responders submitting the same item concurrently (or a stale form after another responder already
 * resolved it) would each insert their response photos, but only the FIRST resolve wins (the status-guarded
 * UPDATE is a no-op for the loser) — orphaning the loser's photos onto the winner's finalized response.
 * Re-reading the item's status under the lock and bailing when it is no longer `open` (BEFORE inserting)
 * means the losing/stale path inserts nothing and returns the same idempotent no-op. It also makes a retry
 * safe: once resolved the item is no longer `open`, so a replayed request never re-inserts the photo links.
 *
 * Strict belongs-checks: the item must belong to the scorecard, and every photoFileId must belong to the
 * scorecard's deal — a foreign/nonexistent file id is a 400, never silently linked.
 *
 * NOTE (Plan 3/4 seam): the token-scoped photo UPLOAD endpoint is not built here. This accepts file ids
 * that were already uploaded (an in-app responder uses the existing field upload endpoint). The web
 * (email-only) upload-auth path is deferred — see corrective-action-routes.ts.
 */
export async function submitCorrectiveActionResponse(
  db: TenantDb,
  input: SubmitCorrectiveActionResponseInput,
): Promise<void> {
  const comment = input.comment?.trim();
  if (!comment) throw new AppError(400, "A response comment is required.");

  const photoFileIds = [...new Set((input.photoFileIds ?? []).filter((id) => id && id.trim()))];

  // Take the parent-scorecard lock up front. resolveCorrectiveActionItemTx re-takes the same lock (a cheap
  // no-op re-lock in the same tx), so serialization holds across the whole submit. We deliberately do NOT
  // open a nested db.transaction here: the route already runs us inside runInOfficeTransaction's transaction
  // (matching reconcileScorecardCorrectiveActions / resolveCorrectiveActionItemTx, which also take an
  // ambient tx), so a nested begin/commit would prematurely close that outer transaction.
  await db
    .select({ id: fieldScorecards.id })
    .from(fieldScorecards)
    .where(eq(fieldScorecards.id, input.scorecardId))
    .limit(1)
    .for("update");

  // The item must belong to this scorecard (strict), and we read its status under the lock.
  const [item] = await db
    .select({
      id: scorecardCorrectiveActions.id,
      status: scorecardCorrectiveActions.status,
    })
    .from(scorecardCorrectiveActions)
    .where(
      and(
        eq(scorecardCorrectiveActions.id, input.itemId),
        eq(scorecardCorrectiveActions.scorecardId, input.scorecardId),
      ),
    )
    .limit(1);
  if (!item) throw new AppError(404, "Corrective-action item not found.");

  // If the item is no longer open (a concurrent/stale submit lost the race), do NOT insert photos — the
  // resolve below would be a no-op and any inserted photos would orphan onto the winner's response. Return
  // cleanly (the caller re-reads the current thread), preserving the idempotent no-op result.
  if (item.status !== "open") return;

  if (photoFileIds.length > 0) {
    // Every file must belong to this scorecard's deal. Resolve the deal from the scorecard and assert
    // membership.
    const dealRow = await db.execute(
      sql`SELECT deal_id FROM field_scorecards WHERE id = ${input.scorecardId} LIMIT 1`,
    );
    const dealId = (dealRow.rows[0] as { deal_id?: string } | undefined)?.deal_id;
    if (!dealId) throw new AppError(404, "Scorecard not found.");

    const owned = await db
      .select({ id: files.id })
      .from(files)
      .where(
        and(
          inArray(files.id, photoFileIds),
          eq(files.dealId, dealId),
          eq(files.isActive, true),
          isNull(files.deletedAt),
        ),
      );
    const ownedIds = new Set(owned.map((r) => r.id));
    const missing = photoFileIds.filter((id) => !ownedIds.has(id));
    if (missing.length > 0) {
      throw new AppError(400, "One or more photos are not part of this project.");
    }

    // A response photo MUST be a distinct fresh file. Reject any file that already has a
    // field_scorecard_photos row for this scorecard — that is existing scorecard EVIDENCE, and stamping
    // corrective_action_id on it would drop it from the PDF/evidence grid (those queries exclude
    // corrective_action_id IS NOT NULL), letting a responder hijack/erase original evidence.
    const existing = await db
      .select({ fileId: fieldScorecardPhotos.fileId })
      .from(fieldScorecardPhotos)
      .where(
        and(
          eq(fieldScorecardPhotos.scorecardId, input.scorecardId),
          inArray(fieldScorecardPhotos.fileId, photoFileIds),
        ),
      );
    if (existing.length > 0) {
      throw new AppError(400, "A response photo must be a new file, not existing scorecard evidence.");
    }

    // Insert each fresh file as a NEW response-photo row: corrective_action_id set to this item, and
    // section/deficiency null (a response photo, per spec §4.3). Never UPDATE/stamp an existing row.
    for (const fileId of photoFileIds) {
      await db.insert(fieldScorecardPhotos).values({
        scorecardId: input.scorecardId,
        sectionKey: null,
        deficiencyKey: null,
        fileId,
        correctiveActionId: input.itemId,
      });
    }
  }

  // Resolve within the SAME (caller-supplied) transaction so a resolve failure rolls back the photo inserts.
  await resolveCorrectiveActionItemTx(db, {
    scorecardId: input.scorecardId,
    itemId: input.itemId,
    responseComment: comment,
    respondedBy: input.respondedBy,
    photoFileIds,
  });
}
