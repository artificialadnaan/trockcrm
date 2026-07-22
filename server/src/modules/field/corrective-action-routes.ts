import type { NextFunction, Request, Response, Router } from "express";
import { sql } from "drizzle-orm";
import { requireFieldContractor } from "../../middleware/field-auth.js";
import { AppError } from "../../middleware/error-handler.js";
import { assertValidUuid } from "./photos-service.js";
import {
  resolveWriteOffice,
  runInOffice,
  runInOfficeTransaction,
  type FieldOffice,
  type FieldTenantDb,
} from "./cross-office.js";
import { verifyCorrectiveActionToken } from "./corrective-action-tokens.js";
import { isAssignedCorrectiveActionResponder } from "./corrective-action-recipients.js";
import { getCorrectiveActionItems, submitCorrectiveActionResponse } from "./corrective-action-api.js";
import { getFileDownloadUrl } from "../files/service.js";
import {
  requestCorrectiveActionUploadUrl,
  confirmCorrectiveActionUpload,
  CORRECTIVE_ACTION_SYSTEM_UPLOADER,
} from "./corrective-action-upload.js";

/** The responder identity threaded into a resolved item (a CRM user, or an email-only token recipient). */
export interface CorrectiveActionResponder {
  userId: string | null;
  name: string | null;
  email: string | null;
}

/**
 * A gate that admits EITHER a field session OR a `?token`. When a `?token` query param is present we do NOT
 * require a session (the email-only web responder has none) — the handler verifies the token against the
 * scorecard's office. Otherwise the standard field-session middleware runs.
 */
export function requireFieldSessionOrToken(req: Request, res: Response, next: NextFunction) {
  if (typeof req.query.token === "string" && req.query.token.trim()) {
    next();
    return;
  }
  void requireFieldContractor(req, res, next);
}

function rawToken(req: Request): string | null {
  const value = req.query.token;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Resolve the owning office of the route's scorecard, then authorize the caller against it:
 *   - token path: the `?token` must verify IN that office AND its scorecardId must equal the route :id
 *     (a token for scorecard A can't touch scorecard B) → an invalid/expired/cross-scorecard token is 401/403;
 *   - session path: the field user must be the deal's ASSIGNED superintendent/project_manager (an active
 *     deal_team_members row matched by user_id) OR hold an authorized management role (admin/director) —
 *     spec §7.1. This is narrower than mere browse access (assertActiveFieldProject): a field_contractor /
 *     construction / rep who can browse the project but is not on the team is 403, so they can't respond or
 *     auto-close another crew's corrective action.
 *
 * Returns the office + the responder identity to stamp on any resolution.
 */
async function authorizeCorrectiveAction(
  req: Request,
  scorecardId: string,
): Promise<{ office: FieldOffice; responder: CorrectiveActionResponder }> {
  const office = await resolveWriteOffice("scorecard", scorecardId, "Scorecard not found");
  const token = rawToken(req);

  if (token) {
    const verified = await runInOffice(office, (db) => verifyCorrectiveActionToken(db, token));
    if (!verified) throw new AppError(401, "This corrective-action link is invalid or has expired.");
    if (verified.scorecardId !== scorecardId) {
      // A recipient-bound token grants access ONLY to its own scorecard's flow.
      throw new AppError(403, "This link does not grant access to this scorecard.");
    }
    return { office, responder: { userId: null, name: null, email: verified.recipientEmail } };
  }

  // Session path — requireFieldContractor already populated req.fieldUser.
  const fieldUser = req.fieldUser;
  if (!fieldUser) throw new AppError(401, "Authentication required");
  await runInOffice(office, async (db) => {
    const dealRes = await db.execute(
      sql`SELECT deal_id FROM field_scorecards WHERE id = ${scorecardId} LIMIT 1`,
    );
    const dealId = (dealRes.rows[0] as { deal_id?: string } | undefined)?.deal_id;
    if (!dealId) throw new AppError(404, "Scorecard not found");
    // Gate on the caller being the deal's assigned super/PM, or an authorized management role (spec §7.1).
    // Browse access alone (assertActiveFieldProject) is NOT enough — a browsable-but-unassigned field user
    // must not respond to / auto-close another crew's corrective action.
    const allowed = await isAssignedCorrectiveActionResponder(db, dealId, {
      id: fieldUser.id,
      role: fieldUser.role,
    });
    if (!allowed) {
      throw new AppError(403, "You are not authorized to respond to this scorecard's corrective action.");
    }
  });
  return {
    office,
    responder: {
      userId: fieldUser.id,
      name: [fieldUser.firstName, fieldUser.lastName].filter(Boolean).join(" ").trim() || null,
      email: fieldUser.email ?? null,
    },
  };
}

/**
 * A photo-URL resolver bound to the request's office db, matching the scorecard evidence read
 * (getFieldScorecardDetail / getDealScorecardDetail): presign via getFileDownloadUrl, degrade to null on any
 * failure so one bad object never fails the whole read.
 */
function correctiveActionPhotoUrlResolver(db: FieldTenantDb) {
  return (fileId: string) =>
    getFileDownloadUrl(db, fileId)
      .then((r) => r.url)
      .catch(() => null);
}

function parsePhotoFileIds(value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new AppError(400, "photoFileIds must be an array.");
  if (value.length > 50) throw new AppError(400, "At most 50 photos can be attached to a response.");
  return value.map((candidate) => {
    if (typeof candidate !== "string" || !candidate.trim()) {
      throw new AppError(400, "Each photoFileId must be a non-empty string.");
    }
    assertValidUuid(candidate.trim(), "photoFileId");
    return candidate.trim();
  });
}

/** Register the corrective-action read + response endpoints on the field router. */
export function registerCorrectiveActionRoutes(fieldRoutes: Router): void {
  // Read the scorecard's corrective-action items + their inline responses. Session OR token auth.
  fieldRoutes.get(
    "/scorecards/:id/corrective-actions",
    requireFieldSessionOrToken,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const id = String(req.params.id);
        assertValidUuid(id, "id");
        const { office } = await authorizeCorrectiveAction(req, id);
        const items = await runInOffice(office, (db: FieldTenantDb) =>
          getCorrectiveActionItems(db, id, { resolvePhotoUrl: correctiveActionPhotoUrlResolver(db) }),
        );
        res.json({ items });
      } catch (err) {
        next(err);
      }
    },
  );

  // NOTE ON ORDERING: the upload routes below MUST be registered BEFORE the `:itemId` catch-all POST — else
  // Express would bind POST /…/corrective-actions/upload to `:itemId = "upload"` (a 400 on the uuid assert).

  // Step 1 (presign) of the token-scoped response-photo upload: mint a presigned R2 upload URL for a fresh
  // photo on the scorecard's deal. Session OR token auth. The web (email-only) responder has no field
  // session, so uploads can't go through the session-scoped field upload endpoint — this token-authed pair
  // is that path. Returns { uploadUrl, objectKey, uploadToken } for the browser to PUT to R2.
  fieldRoutes.post(
    "/scorecards/:id/corrective-actions/upload/url",
    requireFieldSessionOrToken,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const id = String(req.params.id);
        assertValidUuid(id, "id");
        const { office, responder } = await authorizeCorrectiveAction(req, id);
        const result = await runInOffice(office, (db: FieldTenantDb) =>
          requestCorrectiveActionUploadUrl(db, {
            scorecardId: id,
            officeSlug: office.slug,
            uploaderId: responder.userId ?? CORRECTIVE_ACTION_SYSTEM_UPLOADER,
            contentType: String(req.body?.contentType),
            sizeBytes: Number(req.body?.sizeBytes),
          }),
        );
        res.json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  // Step 2 (confirm) of the token-scoped response-photo upload: after the browser PUT the object to R2,
  // create the files row on the deal and return { fileId } — the id the response POST's photoFileIds expects
  // (a fresh file, never existing scorecard evidence). Session OR token auth.
  fieldRoutes.post(
    "/scorecards/:id/corrective-actions/upload",
    requireFieldSessionOrToken,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const id = String(req.params.id);
        assertValidUuid(id, "id");
        const uploadToken = typeof req.body?.uploadToken === "string" ? req.body.uploadToken : "";
        const objectKey = typeof req.body?.objectKey === "string" ? req.body.objectKey : "";
        if (!uploadToken || !objectKey) {
          throw new AppError(400, "uploadToken and objectKey are required.");
        }
        const { office, responder } = await authorizeCorrectiveAction(req, id);
        const result = await runInOfficeTransaction(
          office,
          responder.userId ?? "",
          (db: FieldTenantDb) =>
            confirmCorrectiveActionUpload(db, {
              scorecardId: id,
              uploaderId: responder.userId ?? CORRECTIVE_ACTION_SYSTEM_UPLOADER,
              uploadToken,
              objectKey,
            }),
        );
        res.status(201).json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  // Submit a per-item corrective-action response (comment + already-uploaded photo ids). Session OR token
  // auth. Marks the item resolved (auto-closing the scorecard when it's the last open item). Registered
  // AFTER the /upload routes so "upload" is never captured as an :itemId.
  fieldRoutes.post(
    "/scorecards/:id/corrective-actions/:itemId",
    requireFieldSessionOrToken,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const id = String(req.params.id);
        const itemId = String(req.params.itemId);
        assertValidUuid(id, "id");
        assertValidUuid(itemId, "itemId");
        const comment = typeof req.body?.comment === "string" ? req.body.comment : "";
        const photoFileIds = parsePhotoFileIds(req.body?.photoFileIds);

        const { office, responder } = await authorizeCorrectiveAction(req, id);
        // runInOfficeTransaction sets app.current_user_id — a token responder has no user id, so "".
        const items = await runInOfficeTransaction(office, responder.userId ?? "", async (db) => {
          await submitCorrectiveActionResponse(db, {
            scorecardId: id,
            itemId,
            comment,
            photoFileIds,
            respondedBy: responder,
          });
          return getCorrectiveActionItems(db, id, { resolvePhotoUrl: correctiveActionPhotoUrlResolver(db) });
        });
        res.json({ items });
      } catch (err) {
        next(err);
      }
    },
  );
}
