import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { AppError } from "../../middleware/error-handler.js";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import { scorecardCorrectiveActionEvents } from "@trock-crm/shared/schema";
import type { CorrectiveActionEventType } from "@trock-crm/shared/types";

type TenantDb = NodePgDatabase<typeof schema>;

/**
 * The append-only record of a corrective action's back-and-forth: each submission, each approval, each
 * rejection with its reason.
 *
 * Why this exists rather than more columns on scorecard_corrective_actions: that table holds a SINGLE set of
 * response fields, so a resubmission overwrites the previous attempt. The item row is the CURRENT state;
 * these rows are the history, and they are what the PDF and the CRM render as the thread.
 *
 * Nothing here ever updates or deletes an event. A correction to the record is a new event, not an edit to
 * an old one — an audit trail that can be rewritten is not an audit trail.
 */

export interface RecordCorrectiveActionEventInput {
  correctiveActionId: string;
  scorecardId: string;
  eventType: CorrectiveActionEventType;
  /** Null for a token responder, who has no CRM user id. */
  actorUserId: string | null;
  /** Captured at write time so a later rename or archive cannot rewrite history. */
  actorName: string | null;
  actorEmail: string | null;
  /** The response text, or the rejection reason. Required for `rejected` — enforced here AND by a CHECK. */
  comment: string | null;
  /** The item's identity, snapshotted so the event stays readable if an edit later removes the item. */
  itemType?: string | null;
  itemRef?: string | null;
  itemLabel?: string | null;
}

export interface CorrectiveActionEventRow {
  id: string;
  /** Null once its item is removed by an edit — the event survives as part of the card's record. */
  correctiveActionId: string | null;
  eventType: string;
  actorUserId: string | null;
  actorName: string | null;
  actorEmail: string | null;
  comment: string | null;
  createdAt: string | null;
  /** Snapshotted item identity — the only way to read a detached event. */
  itemType: string | null;
  itemRef: string | null;
  itemLabel: string | null;
}

/**
 * Append one event. Runs in the caller's transaction so the event and the state change it describes commit
 * together — an approval that recorded no event, or an event with no approval, would both be lies.
 *
 * Returns the new event id so the caller can attribute response photos to this specific attempt.
 */
export async function recordCorrectiveActionEvent(
  tx: TenantDb,
  input: RecordCorrectiveActionEventInput,
): Promise<string> {
  const comment = input.comment?.trim() || null;
  // Mirrors the CHECK in migration 0202. Validated here too so the failure is a clear 400 at the API edge
  // rather than a constraint violation surfacing as a 500.
  if (input.eventType === "rejected" && !comment) {
    throw new AppError(
      400,
      "A rejection must carry a comment: telling the responder what to fix IS the rejection.",
    );
  }

  const [row] = await tx
    .insert(scorecardCorrectiveActionEvents)
    .values({
      correctiveActionId: input.correctiveActionId,
      scorecardId: input.scorecardId,
      eventType: input.eventType,
      actorUserId: input.actorUserId,
      actorName: input.actorName,
      actorEmail: input.actorEmail,
      comment,
      itemType: input.itemType ?? null,
      itemRef: input.itemRef ?? null,
      itemLabel: input.itemLabel ?? null,
    })
    .returning({ id: scorecardCorrectiveActionEvents.id });
  return row.id;
}

/**
 * The columns both readers select — one list so the two cannot drift.
 *
 * A FUNCTION, not a module-level const: a top-level object literal dereferences the Drizzle table at IMPORT
 * time, which throws for any consumer that partially mocks `@trock-crm/shared/schema`. This module is
 * reachable from the corrective-action service and therefore from the auth and deal import graphs, so that
 * would break unrelated suites — the same trap the generation-token helper already hit.
 */
function eventColumns() {
  return {
    id: scorecardCorrectiveActionEvents.id,
    correctiveActionId: scorecardCorrectiveActionEvents.correctiveActionId,
    eventType: scorecardCorrectiveActionEvents.eventType,
    actorUserId: scorecardCorrectiveActionEvents.actorUserId,
    actorName: scorecardCorrectiveActionEvents.actorName,
    actorEmail: scorecardCorrectiveActionEvents.actorEmail,
    comment: scorecardCorrectiveActionEvents.comment,
    createdAt: scorecardCorrectiveActionEvents.createdAt,
    itemType: scorecardCorrectiveActionEvents.itemType,
    itemRef: scorecardCorrectiveActionEvents.itemRef,
    itemLabel: scorecardCorrectiveActionEvents.itemLabel,
  } as const;
}

function groupByItem(
  rows: Array<{ createdAt: Date | string | null } & Omit<CorrectiveActionEventRow, "createdAt">>,
): Map<string, CorrectiveActionEventRow[]> {
  const byItem = new Map<string, CorrectiveActionEventRow[]>();
  for (const row of rows) {
    // A detached event (its item was removed by an edit) belongs to no item bucket. It stays in the table as
    // part of the card's history; the per-item readers simply have nothing to thread it under.
    if (!row.correctiveActionId) continue;
    const list = byItem.get(row.correctiveActionId) ?? [];
    list.push({
      ...row,
      createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : (row.createdAt ?? null),
    });
    byItem.set(row.correctiveActionId, list);
  }
  return byItem;
}

/**
 * Every event for a scorecard, oldest first, grouped by item.
 *
 * ONE query for the whole card rather than one per item — the PDF renderer and the deal-tab read both need
 * the full thread, and a per-item fetch would be N+1 on a surface that already loads photos per item.
 */
/**
 * Events whose item an edit removed. They keep the card's history honest — a rejection and the answer to it
 * are things that happened, and the item disappearing does not unhappen them.
 *
 * Returned separately rather than dropped: the per-item readers have nothing to thread them under, but the
 * scorecard-level record can still show them. Ordered by the same monotonic sequence.
 */
export async function getDetachedCorrectiveActionEvents(
  db: TenantDb,
  scorecardId: string,
): Promise<CorrectiveActionEventRow[]> {
  const rows = await db
    .select(eventColumns())
    .from(scorecardCorrectiveActionEvents)
    .where(
      and(
        eq(scorecardCorrectiveActionEvents.scorecardId, scorecardId),
        isNull(scorecardCorrectiveActionEvents.correctiveActionId),
      ),
    )
    .orderBy(asc(scorecardCorrectiveActionEvents.seq));

  return rows.map((row) => ({
    ...row,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : (row.createdAt ?? null),
  }));
}

export async function getCorrectiveActionEventsByItem(
  db: TenantDb,
  scorecardId: string,
): Promise<Map<string, CorrectiveActionEventRow[]>> {
  const rows = await db
    .select(eventColumns())
    .from(scorecardCorrectiveActionEvents)
    .where(eq(scorecardCorrectiveActionEvents.scorecardId, scorecardId))
    // Ordered by the monotonic sequence, NOT created_at: events written in one transaction share a
    // timestamp and the uuid PK is random, so a timestamp sort renders the thread in an arbitrary order.
    .orderBy(asc(scorecardCorrectiveActionEvents.seq));

  return groupByItem(rows);
}

/** The events for a specific set of items, same ordering guarantees. Used by the responder-scoped reads. */
export async function getCorrectiveActionEventsForItems(
  db: TenantDb,
  itemIds: string[],
): Promise<Map<string, CorrectiveActionEventRow[]>> {
  if (itemIds.length === 0) return new Map();
  const rows = await db
    .select(eventColumns())
    .from(scorecardCorrectiveActionEvents)
    .where(inArray(scorecardCorrectiveActionEvents.correctiveActionId, itemIds))
    .orderBy(asc(scorecardCorrectiveActionEvents.seq));

  return groupByItem(rows);
}
