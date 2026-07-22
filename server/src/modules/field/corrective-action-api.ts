import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import {
  fieldScorecardPhotos,
  files,
  scorecardCorrectiveActions,
} from "@trock-crm/shared/schema";
import { AppError } from "../../middleware/error-handler.js";
import { resolveCorrectiveActionItem } from "./corrective-actions-service.js";

type TenantDb = NodePgDatabase<typeof schema>;

export interface CorrectiveActionResponsePhoto {
  id: string;
  fileId: string;
  clientUploadId: string | null;
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
 */
export async function getCorrectiveActionItems(
  db: TenantDb,
  scorecardId: string,
): Promise<CorrectiveActionItemView[]> {
  const rows = await db
    .select()
    .from(scorecardCorrectiveActions)
    .where(eq(scorecardCorrectiveActions.scorecardId, scorecardId))
    .orderBy(scorecardCorrectiveActions.itemType, scorecardCorrectiveActions.itemRef);
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
  const photosByItem = new Map<string, CorrectiveActionResponsePhoto[]>();
  for (const p of photoRows) {
    if (!p.correctiveActionId) continue;
    const list = photosByItem.get(p.correctiveActionId) ?? [];
    list.push({ id: p.id, fileId: p.fileId, clientUploadId: p.clientUploadId ?? null, caption: p.caption ?? null });
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
 * (field_scorecard_photos.corrective_action_id), then resolve the item via Plan 1's
 * resolveCorrectiveActionItem (which auto-closes the scorecard when it's the last open item). The caller
 * has already authorized access (session or token) and bound the db to the scorecard's office.
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

  // The item must belong to this scorecard (strict). Resolve its deal via the scorecard for the photo check.
  const [item] = await db
    .select({ id: scorecardCorrectiveActions.id, scorecardId: scorecardCorrectiveActions.scorecardId })
    .from(scorecardCorrectiveActions)
    .where(
      and(
        eq(scorecardCorrectiveActions.id, input.itemId),
        eq(scorecardCorrectiveActions.scorecardId, input.scorecardId),
      ),
    )
    .limit(1);
  if (!item) throw new AppError(404, "Corrective-action item not found.");

  const photoFileIds = [...new Set((input.photoFileIds ?? []).filter((id) => id && id.trim()))];
  if (photoFileIds.length > 0) {
    // Every file must belong to this scorecard's deal (via field_scorecard_photos on the same scorecard, or
    // an active file on the deal). Resolve the deal from the scorecard and assert membership.
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

    // Link each file to this item as response evidence. Upsert a field_scorecard_photos row per file with
    // corrective_action_id set and section/deficiency null (a response photo, per spec §4.3). If a row for
    // this (scorecard, file) already exists (an original evidence photo), stamp its corrective_action_id.
    for (const fileId of photoFileIds) {
      const existing = await db
        .select({ id: fieldScorecardPhotos.id })
        .from(fieldScorecardPhotos)
        .where(
          and(eq(fieldScorecardPhotos.scorecardId, input.scorecardId), eq(fieldScorecardPhotos.fileId, fileId)),
        )
        .limit(1);
      if (existing[0]) {
        await db
          .update(fieldScorecardPhotos)
          .set({ correctiveActionId: input.itemId })
          .where(eq(fieldScorecardPhotos.id, existing[0].id));
      } else {
        await db.insert(fieldScorecardPhotos).values({
          scorecardId: input.scorecardId,
          sectionKey: null,
          deficiencyKey: null,
          fileId,
          correctiveActionId: input.itemId,
        });
      }
    }
  }

  await resolveCorrectiveActionItem(db, {
    scorecardId: input.scorecardId,
    itemId: input.itemId,
    responseComment: comment,
    respondedBy: input.respondedBy,
    photoFileIds,
  });
}
