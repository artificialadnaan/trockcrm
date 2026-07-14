import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  fieldScorecardEditUploads,
  fieldScorecardPhotos,
  fieldScorecards,
  files,
} from "@trock-crm/shared/schema";
import { AppError } from "../../middleware/error-handler.js";
import type { FieldTenantDb } from "./cross-office.js";

export type ScorecardEvidenceUploadTarget = {
  dealId?: string;
  leadId?: string;
  opportunityId?: string;
};

export type ScorecardEvidenceUploadCard = {
  dealId: string;
  submittedBy: string;
  status: string;
  formVersion: number;
  isActive: boolean;
};

export type ScorecardEditUploadScope = {
  scorecardId: string;
  clientUploadId: string;
};

type ScorecardEditUploadRow = typeof fieldScorecardEditUploads.$inferSelect;

function cleanClientUploadId(value: string): string {
  const clientUploadId = value.trim();
  if (!clientUploadId || clientUploadId.length > 64) {
    throw new AppError(400, "clientUploadId must be a non-empty string of at most 64 characters.");
  }
  return clientUploadId;
}

/**
 * Authorize the narrow cross-office exception used only by submitted-scorecard edit evidence. The generic
 * field-photo write flag remains untouched: this scope is safe because the immutable scorecard row proves
 * the target office, exact submitter, supported edit state, and authoritative deal.
 */
export function assertScorecardEvidenceUploadCard(
  card: ScorecardEvidenceUploadCard | null | undefined,
  input: { userId: string; target: ScorecardEvidenceUploadTarget },
): asserts card is ScorecardEvidenceUploadCard {
  if (!input.target.dealId || input.target.leadId || input.target.opportunityId) {
    throw new AppError(400, "Scorecard edit evidence requires exactly its project deal target.");
  }
  if (!card || !card.isActive) throw new AppError(404, "Scorecard not found");
  if (card.submittedBy !== input.userId) {
    throw new AppError(403, "Only the person who submitted this scorecard can add evidence.", "SCORECARD_EDIT_FORBIDDEN");
  }
  if (card.status !== "submitted" || card.formVersion !== 2) {
    throw new AppError(422, "Only submitted current-form scorecards can accept edited evidence.", "SCORECARD_EDIT_UNSUPPORTED");
  }
  if (card.dealId !== input.target.dealId) {
    throw new AppError(422, "Scorecard edit evidence must target the scorecard's project.");
  }
}

async function loadScorecardEvidenceUploadCard(
  tenantDb: FieldTenantDb,
  scorecardId: string,
  lock = false,
): Promise<ScorecardEvidenceUploadCard | undefined> {
  let query = tenantDb
    .select({
      dealId: fieldScorecards.dealId,
      submittedBy: fieldScorecards.submittedBy,
      status: fieldScorecards.status,
      formVersion: fieldScorecards.formVersion,
      isActive: fieldScorecards.isActive,
    })
    .from(fieldScorecards)
    .where(eq(fieldScorecards.id, scorecardId))
    .limit(1);
  if (lock) query = query.for("update") as typeof query;
  const [card] = await query;
  return card;
}

/** Load and authorize one scorecard-scoped evidence upload inside its resolved office transaction. */
export async function assertScorecardEvidenceUploadAccess(
  tenantDb: FieldTenantDb,
  input: { scorecardId: string; userId: string; target: ScorecardEvidenceUploadTarget },
): Promise<void> {
  const card = await loadScorecardEvidenceUploadCard(tenantDb, input.scorecardId);
  assertScorecardEvidenceUploadCard(card, input);
}

/**
 * Persist the exact scorecard + client-id binding before an upload URL is returned. The unique client id
 * prevents a queue row/token from being replayed against another submitted card. Existing exact retries
 * are idempotent; a discarded id remains terminal and the client must generate a fresh photo id.
 */
export async function authorizeScorecardEditEvidenceUpload(
  tenantDb: FieldTenantDb,
  input: {
    scorecardId: string;
    clientUploadId: string;
    userId: string;
    target: ScorecardEvidenceUploadTarget;
  },
): Promise<ScorecardEditUploadScope> {
  const clientUploadId = cleanClientUploadId(input.clientUploadId);
  const card = await loadScorecardEvidenceUploadCard(tenantDb, input.scorecardId);
  assertScorecardEvidenceUploadCard(card, input);

  await tenantDb
    .insert(fieldScorecardEditUploads)
    .values({
      scorecardId: input.scorecardId,
      dealId: card.dealId,
      clientUploadId,
      uploadedBy: input.userId,
      state: "authorized",
    })
    .onConflictDoNothing({ target: fieldScorecardEditUploads.clientUploadId });

  const [binding] = await tenantDb
    .select()
    .from(fieldScorecardEditUploads)
    .where(eq(fieldScorecardEditUploads.clientUploadId, clientUploadId))
    .limit(1)
    .for("update");
  if (
    !binding ||
    binding.scorecardId !== input.scorecardId ||
    binding.dealId !== card.dealId ||
    binding.uploadedBy !== input.userId
  ) {
    throw new AppError(409, "This evidence upload id is already bound to another scorecard.", "SCORECARD_EDIT_UPLOAD_SCOPE");
  }
  if (binding.state === "discarded") {
    throw new AppError(409, "This evidence upload was discarded. Add the photo again to continue.", "SCORECARD_EDIT_UPLOAD_DISCARDED");
  }
  return { scorecardId: input.scorecardId, clientUploadId };
}

/**
 * Lock and verify the durable scope before confirm creates/returns a file row. `pendingScope` is the
 * server-trusted scope stored alongside the upload token; the registry also covers tokenless idempotent
 * retries after a restart. Presence itself must match, so generic <-> scoped confirm replay is rejected.
 */
export async function lockScorecardEditEvidenceUploadForConfirm(
  tenantDb: FieldTenantDb,
  input: {
    userId: string;
    dealId?: string;
    scorecardId?: string;
    clientUploadId?: string;
    pendingScope?: ScorecardEditUploadScope;
    pendingUploadFound?: boolean;
  },
): Promise<ScorecardEditUploadRow | null> {
  const requestedScope = input.scorecardId
    ? {
        scorecardId: input.scorecardId?.trim() ?? "",
        clientUploadId: input.clientUploadId ? cleanClientUploadId(input.clientUploadId) : "",
      }
    : undefined;
  if (requestedScope && (!requestedScope.scorecardId || !requestedScope.clientUploadId)) {
    throw new AppError(400, "scorecardId and clientUploadId must be supplied together for edit evidence.");
  }
  if (input.pendingUploadFound && (
    Boolean(input.pendingScope) !== Boolean(requestedScope) ||
    (input.pendingScope && requestedScope &&
      (input.pendingScope.scorecardId !== requestedScope.scorecardId ||
        input.pendingScope.clientUploadId !== requestedScope.clientUploadId))
  )) {
    throw new AppError(400, "Upload token does not match this scorecard evidence upload.", "SCORECARD_EDIT_UPLOAD_SCOPE");
  }

  // A consumed/expired token can still be an idempotent confirm retry, so the durable row is authoritative.
  const lookupClientUploadId = requestedScope?.clientUploadId ?? input.clientUploadId?.trim();
  if (!lookupClientUploadId) return null;
  const [binding] = await tenantDb
    .select()
    .from(fieldScorecardEditUploads)
    .where(eq(fieldScorecardEditUploads.clientUploadId, lookupClientUploadId))
    .limit(1)
    .for("update");

  if (!binding) {
    if (requestedScope) {
      throw new AppError(409, "Scorecard evidence upload authorization was not found.", "SCORECARD_EDIT_UPLOAD_SCOPE");
    }
    return null;
  }
  // A generic confirm may not omit the scope for a client id previously authorized as edit evidence.
  if (
    !requestedScope ||
    binding.scorecardId !== requestedScope.scorecardId ||
    binding.clientUploadId !== requestedScope.clientUploadId ||
    binding.uploadedBy !== input.userId ||
    binding.dealId !== input.dealId
  ) {
    throw new AppError(409, "Scorecard evidence upload scope does not match.", "SCORECARD_EDIT_UPLOAD_SCOPE");
  }
  if (binding.state === "discarded") {
    throw new AppError(409, "This evidence upload was discarded and cannot be confirmed.", "SCORECARD_EDIT_UPLOAD_DISCARDED");
  }
  return binding;
}

/** Finish the confirm transition while the binding row remains locked in the request transaction. */
export async function markScorecardEditEvidenceUploadConfirmed(
  tenantDb: FieldTenantDb,
  binding: ScorecardEditUploadRow | null,
  fileId: string,
): Promise<void> {
  if (!binding) return;
  if (binding.state === "discarded") {
    throw new AppError(409, "This evidence upload was discarded and cannot be confirmed.", "SCORECARD_EDIT_UPLOAD_DISCARDED");
  }
  await tenantDb
    .update(fieldScorecardEditUploads)
    .set({
      fileId,
      state: binding.state === "linked" ? "linked" : "confirmed",
      updatedAt: new Date(),
    })
    .where(eq(fieldScorecardEditUploads.id, binding.id));
}

/** Mark files attached by a successful PUT as permanently cleanup-safe. This transition never reverses. */
export async function markScorecardEditEvidenceLinked(
  tenantDb: FieldTenantDb,
  input: { scorecardId: string; userId: string; fileIds: string[] },
): Promise<void> {
  const fileIds = [...new Set(input.fileIds)];
  if (fileIds.length === 0) return;
  await tenantDb
    .update(fieldScorecardEditUploads)
    .set({ state: "linked", updatedAt: new Date() })
    .where(
      and(
        eq(fieldScorecardEditUploads.scorecardId, input.scorecardId),
        eq(fieldScorecardEditUploads.uploadedBy, input.userId),
        inArray(fieldScorecardEditUploads.fileId, fileIds),
        sql`${fieldScorecardEditUploads.state} <> 'discarded'`,
      ),
    );
}

/**
 * Reconcile new evidence when the submitter discards a local edit after upload began.
 *
 * The scorecard row lock serializes this with updateFieldScorecard's PUT lock. Registry rows are then
 * tombstoned before the transaction commits: a confirm that timed out in the app either committed first
 * (and is cleaned here) or observes `discarded` and cannot create a late orphan. `linked` is terminal, so a
 * file successfully linked once remains a normal gallery photo even if a later edit removes that link.
 */
export async function discardScorecardEditEvidence(
  tenantDb: FieldTenantDb,
  input: { scorecardId: string; userId: string; clientUploadIds: string[] },
): Promise<{ discarded: number }> {
  const card = await loadScorecardEvidenceUploadCard(tenantDb, input.scorecardId, true);
  assertScorecardEvidenceUploadCard(card, {
    userId: input.userId,
    target: { dealId: card?.dealId ?? "missing-scorecard" },
  });

  const clientUploadIds = [...new Set(input.clientUploadIds.map(cleanClientUploadId))];
  if (clientUploadIds.length === 0) return { discarded: 0 };

  // Tombstone ledger ids even when upload-url has not committed yet. This closes the inverse network race:
  // cleanup may arrive while a timed-out authorization request is still in flight. Do not claim ids that
  // already belong to ordinary (non-edit) files; only never-seen ids receive a discarded binding here.
  const existingFiles = await tenantDb
    .select({ clientUploadId: files.clientUploadId })
    .from(files)
    .where(
      and(
        inArray(files.clientUploadId, clientUploadIds),
        eq(files.uploadedBy, input.userId),
      ),
    );
  const existingFileClientIds = new Set(existingFiles.map((row) => row.clientUploadId));
  const unregisteredIds = clientUploadIds.filter((id) => !existingFileClientIds.has(id));
  if (unregisteredIds.length > 0) {
    await tenantDb
      .insert(fieldScorecardEditUploads)
      .values(unregisteredIds.map((clientUploadId) => ({
        scorecardId: input.scorecardId,
        dealId: card.dealId,
        clientUploadId,
        uploadedBy: input.userId,
        state: "discarded",
      })))
      .onConflictDoNothing({ target: fieldScorecardEditUploads.clientUploadId });
  }

  const bindings = await tenantDb
    .select()
    .from(fieldScorecardEditUploads)
    .where(
      and(
        eq(fieldScorecardEditUploads.scorecardId, input.scorecardId),
        eq(fieldScorecardEditUploads.uploadedBy, input.userId),
        inArray(fieldScorecardEditUploads.clientUploadId, clientUploadIds),
      ),
    )
    .for("update");
  if (bindings.length === 0) return { discarded: 0 };

  const candidateFileIds = bindings.flatMap((binding) =>
    binding.state !== "linked" && binding.fileId ? [binding.fileId] : [],
  );
  const linkedRows = candidateFileIds.length === 0
    ? []
    : await tenantDb
        .select({ fileId: fieldScorecardPhotos.fileId })
        .from(fieldScorecardPhotos)
        .where(inArray(fieldScorecardPhotos.fileId, candidateFileIds));
  const linkedFileIds = new Set(linkedRows.map((row) => row.fileId));
  const linkedBindingIds = bindings.flatMap((binding) =>
    binding.fileId && linkedFileIds.has(binding.fileId) ? [binding.id] : [],
  );
  if (linkedBindingIds.length > 0) {
    await tenantDb
      .update(fieldScorecardEditUploads)
      .set({ state: "linked", updatedAt: new Date() })
      .where(inArray(fieldScorecardEditUploads.id, linkedBindingIds));
  }

  const discardable = bindings.filter(
    (binding) => binding.state !== "linked" && (!binding.fileId || !linkedFileIds.has(binding.fileId)),
  );
  if (discardable.length === 0) return { discarded: 0 };
  await tenantDb
    .update(fieldScorecardEditUploads)
    .set({ state: "discarded", updatedAt: new Date() })
    .where(inArray(fieldScorecardEditUploads.id, discardable.map((binding) => binding.id)));

  const fileIdsToHide = discardable.flatMap((binding) => (binding.fileId ? [binding.fileId] : []));
  if (fileIdsToHide.length === 0) return { discarded: 0 };
  const hidden = await tenantDb
    .update(files)
    .set({ isActive: false, deletedAt: new Date(), deletedByUserId: input.userId })
    .where(
      and(
        inArray(files.id, fileIdsToHide),
        eq(files.uploadedBy, input.userId),
        eq(files.dealId, card.dealId),
        eq(files.isActive, true),
        isNull(files.deletedAt),
      ),
    )
    .returning({ id: files.id });
  return { discarded: hidden.length };
}
