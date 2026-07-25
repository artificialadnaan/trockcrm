import type { NextFunction, Request, Response, Router } from "express";
import { sql } from "drizzle-orm";
import { requireFieldContractor } from "../../middleware/field-auth.js";
import { correctiveActionPublicLimiter } from "../../middleware/rate-limit.js";
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
import {
  isAssignedCorrectiveActionResponder,
  resolveScorecardCorrectiveActionRecipients,
} from "./corrective-action-recipients.js";
import { getCorrectiveActionItems, submitCorrectiveActionResponse } from "./corrective-action-api.js";
import { activeProjectWhere } from "./projects-service.js";
import { getFileDownloadUrl } from "../files/service.js";
import {
  requestCorrectiveActionUploadUrl,
  confirmCorrectiveActionUpload,
  discardCorrectiveActionUpload,
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

// A raw corrective-action token is base64url of 32 random bytes → exactly 43 url-safe chars ([A-Za-z0-9_-]),
// see generateRawCorrectiveActionToken. A cheap SHAPE check rejected here (BEFORE resolveWriteOffice fans the
// UUID across every office schema) means a garbage/obviously-forged token never triggers the cross-office scan
// — it fails as a plain 401. A well-formed but unknown token still hits the scan, but the IP rate limiter caps
// that volume.
const CORRECTIVE_ACTION_TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;
function isWellFormedCorrectiveActionToken(token: string): boolean {
  return CORRECTIVE_ACTION_TOKEN_SHAPE.test(token);
}

/**
 * Gate corrective-action access on the SAME active-scorecard + browsable-project predicate every normal
 * field-scorecard surface applies (getFieldScorecardDetail: `field_scorecards.is_active = true` AND
 * assertActiveFieldProject's `activeProjectWhere`). Without this, a soft-deleted scorecard — or a scorecard
 * whose deal was archived (`deals.is_active = false`) or moved to Lost/terminal — would still be reachable via
 * an existing 30-day token OR an assigned session user through a direct deep link, even though the record is
 * hidden from every other field read. resolveWriteOffice only proves WHICH office schema owns the id; it does
 * NOT apply the active/browsable filter. Applied to BOTH the token and session paths so neither can bypass it.
 *
 * 404 (consistent with getFieldScorecardDetail / assertActiveFieldProject) when the scorecard is inactive or
 * its project is not browsable, so a hidden record is indistinguishable from a nonexistent one.
 */
async function assertActiveCorrectiveActionScorecard(
  db: FieldTenantDb,
  scorecardId: string,
): Promise<void> {
  const res = await db.execute(sql`
    SELECT 1
    FROM field_scorecards sc
    JOIN deals d ON d.id = sc.deal_id
    LEFT JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
    WHERE sc.id = ${scorecardId}
      AND sc.is_active = true
      AND ${activeProjectWhere()}
    LIMIT 1
  `);
  if (res.rows.length === 0) {
    throw new AppError(404, "Scorecard not found");
  }
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
  const token = rawToken(req);
  // Pre-scan shape guard: a malformed token can't be a real one, so reject it as 401 BEFORE
  // resolveWriteOffice fans the scorecard UUID across every active office schema (one DB query per office).
  // This blunts the cross-office-scan DoS surface for obviously-forged tokens (the IP rate limiter caps
  // well-formed-but-unknown floods). The session path (no token) is unaffected.
  if (token && !isWellFormedCorrectiveActionToken(token)) {
    throw new AppError(401, "This corrective-action link is invalid or has expired.");
  }
  const office = await resolveWriteOffice("scorecard", scorecardId, "Scorecard not found");

  if (token) {
    // Verify the token AND revalidate the assignment in a SINGLE office transaction sharing one db handle
    // (previously two separate runInOffice opens with a duplicated deal_id lookup).
    const responder = await runInOffice(office, async (db) => {
      // Even a valid, still-assigned token must not reach a soft-deleted scorecard or an archived/Lost deal —
      // reuse the normal field-scorecard active/browsable gate (404, hidden ⇒ nonexistent).
      await assertActiveCorrectiveActionScorecard(db, scorecardId);
      const verified = await verifyCorrectiveActionToken(db, token);
      if (!verified) throw new AppError(401, "This corrective-action link is invalid or has expired.");
      if (verified.scorecardId !== scorecardId) {
        // A recipient-bound token grants access ONLY to its own scorecard's flow.
        throw new AppError(403, "This link does not grant access to this scorecard.");
      }
      // Verify-time revalidation: a token verified by hash+expiry alone would keep working for its full TTL
      // even after the assignment drifts (the recipient's email CHANGED, or the super/PM was reassigned) — the
      // per-mutation archive/removal hooks don't cover an email CHANGE. So re-resolve THIS SCORECARD's CURRENT
      // recipients and confirm the token's email still matches a live assignment. If not, the link no longer
      // maps to an assigned responder → 403. (The mutation hooks stay as belt-and-suspenders.)
      //
      // SCORECARD-scoped, not deal-scoped: the worker mints tokens for whoever this card resolves to, and for a
      // card whose super/PM was picked from the field-responder roster that is the picked person — who need not
      // be on deal_team_members at all. A deal-scoped revalidation here would 403 that link on its first click.
      // Resolution still falls back to the deal team per role, so nothing is loosened for anyone else, and a
      // pick that goes inactive/re-roled stops authorizing on the very next request.
      const recipients = await resolveScorecardCorrectiveActionRecipients(db, scorecardId);
      const wanted = verified.recipientEmail.trim().toLowerCase();
      const match = recipients.find((r) => r.email.trim().toLowerCase() === wanted);
      if (!match) {
        throw new AppError(403, "This corrective-action link no longer matches an assigned recipient.");
      }
      // Carry the resolved recipient's configured name so the stamped responder_name is the assignee's name
      // (not null). Keep the token's recipientEmail as the canonical stamped email.
      return { userId: null, name: match.name, email: verified.recipientEmail };
    });
    return { office, responder };
  }

  // Session path — requireFieldContractor already populated req.fieldUser.
  const fieldUser = req.fieldUser;
  if (!fieldUser) throw new AppError(401, "Authentication required");
  await runInOffice(office, async (db) => {
    // Same active/browsable gate as the token path: an assigned session user must not reach a soft-deleted
    // scorecard or an archived/Lost deal via a direct deep link (404, hidden ⇒ nonexistent).
    await assertActiveCorrectiveActionScorecard(db, scorecardId);
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

// Upper bound on a corrective-action response comment. response_comment is an unbounded TEXT column, so cap
// the input here (mirrors the parsePhotoFileIds cap idiom) to reject an oversized/abusive payload rather than
// persist megabytes of free text. Generous enough for a full narrative; the service also trims + requires it.
const MAX_RESPONSE_COMMENT_LENGTH = 5000;

function parseComment(value: unknown): string {
  const comment = typeof value === "string" ? value : "";
  if (comment.length > MAX_RESPONSE_COMMENT_LENGTH) {
    throw new AppError(400, `A response comment must be at most ${MAX_RESPONSE_COMMENT_LENGTH} characters.`);
  }
  return comment;
}

// A per-photo caption persists to files.description (an unbounded TEXT column), so cap it here — otherwise an
// oversized/abusive caption on the upload-confirm body would persist megabytes. null/empty are allowed (an
// optional caption); reuse the same generous bound as the response comment.
function parseCaption(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string") throw new AppError(400, "caption must be a string.");
  if (value.length > MAX_RESPONSE_COMMENT_LENGTH) {
    throw new AppError(400, `A caption must be at most ${MAX_RESPONSE_COMMENT_LENGTH} characters.`);
  }
  return value;
}

// A stable per-photo idempotency key the client generates once and re-sends on retry (finding P2). Forwarded
// to confirmUpload so a lost-response retry (same key, token already consumed) returns the already-created
// file row instead of an expired-token error → no re-upload / orphan. Cap its length (it persists to
// files.client_upload_id) and require a non-empty string; anything else (absent / non-string / blank) is
// legacy single-shot behavior and simply ignored (undefined).
const MAX_CLIENT_UPLOAD_ID_LENGTH = 200;
function parseClientUploadId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > MAX_CLIENT_UPLOAD_ID_LENGTH) {
    throw new AppError(400, `clientUploadId must be at most ${MAX_CLIENT_UPLOAD_ID_LENGTH} characters.`);
  }
  return trimmed;
}

/**
 * Parse the OPTIONAL capture metadata (takenAt + GPS) off the upload-confirm body. The mobile capture flow
 * collects these per response photo; we thread them into confirmUpload so a response file carries the same
 * taken-at/location provenance as an ordinary field photo. This metadata is best-effort — malformed values are
 * silently IGNORED rather than 400'd (a bad optional field must never fail an otherwise-valid photo upload), so
 * every field is validated defensively and dropped if it doesn't fit. Latitude/longitude are only forwarded as
 * a PAIR (confirmUpload/resolvePhotoAddressMetadata rejects a lone coordinate with a 400); a lone or
 * out-of-range coordinate is dropped so it can't fail the upload.
 */
function parseCaptureMetadata(body: any): {
  takenAt?: string;
  latitude?: number;
  longitude?: number;
  addressSource?: "exif" | "live_gps";
} {
  const out: { takenAt?: string; latitude?: number; longitude?: number; addressSource?: "exif" | "live_gps" } = {};

  // takenAt: an ISO date string that parses to a real time.
  if (typeof body?.takenAt === "string" && !Number.isNaN(Date.parse(body.takenAt))) {
    out.takenAt = body.takenAt;
  }

  // latitude/longitude: forward ONLY as a valid, in-range pair (a lone/out-of-range coord would 400 downstream).
  const lat = body?.latitude;
  const lng = body?.longitude;
  if (
    typeof lat === "number" &&
    Number.isFinite(lat) &&
    lat >= -90 &&
    lat <= 90 &&
    typeof lng === "number" &&
    Number.isFinite(lng) &&
    lng >= -180 &&
    lng <= 180
  ) {
    out.latitude = lat;
    out.longitude = lng;
  }

  // addressSource: only the two supported provenance values (exif | live_gps); anything else is dropped.
  if (body?.addressSource === "exif" || body?.addressSource === "live_gps") {
    out.addressSource = body.addressSource;
  }

  return out;
}

/** Register the corrective-action read + response endpoints on the field router. */
export function registerCorrectiveActionRoutes(fieldRoutes: Router): void {
  // Read the scorecard's corrective-action items + their inline responses. Session OR token auth.
  fieldRoutes.get(
    "/scorecards/:id/corrective-actions",
    correctiveActionPublicLimiter,
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
    correctiveActionPublicLimiter,
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
            sessionUserId: responder.userId,
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
    correctiveActionPublicLimiter,
    requireFieldSessionOrToken,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const id = String(req.params.id);
        assertValidUuid(id, "id");
        const uploadToken = typeof req.body?.uploadToken === "string" ? req.body.uploadToken : "";
        const objectKey = typeof req.body?.objectKey === "string" ? req.body.objectKey : "";
        const caption = parseCaption(req.body?.caption);
        // Stable per-photo idempotency key (finding P2) — makes a lost-response confirm retry return the same
        // fileId instead of an expired-token error. Absent/blank → legacy single-shot confirm.
        const clientUploadId = parseClientUploadId(req.body?.clientUploadId);
        // Best-effort capture provenance (takenAt + GPS) collected by the mobile capture flow; malformed values
        // are dropped, never a 400, so a bad optional field can't fail an otherwise-valid photo upload.
        const captureMetadata = parseCaptureMetadata(req.body);
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
              sessionUserId: responder.userId,
              uploadToken,
              objectKey,
              caption,
              clientUploadId,
              ...captureMetadata,
            }),
        );
        res.status(201).json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  // Discard a corrective-action response photo that was uploaded but NOT yet submitted (the responder removed
  // it, or abandoned/refreshed the page). Without this every removed-before-submit upload leaves a permanent,
  // unattached file in the project gallery. Session OR token auth. Registered BEFORE the `:itemId` route so
  // "upload" is never captured as an :itemId. The service only deletes an eligible file (this scorecard's
  // deal + corrective-action flow + not yet attached to any corrective action) — a 404/409 no-op otherwise.
  fieldRoutes.delete(
    "/scorecards/:id/corrective-actions/upload/:fileId",
    correctiveActionPublicLimiter,
    requireFieldSessionOrToken,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const id = String(req.params.id);
        const fileId = String(req.params.fileId);
        assertValidUuid(id, "id");
        assertValidUuid(fileId, "fileId");
        const { office, responder } = await authorizeCorrectiveAction(req, id);
        const result = await runInOfficeTransaction(
          office,
          responder.userId ?? "",
          (db: FieldTenantDb) =>
            discardCorrectiveActionUpload(db, {
              scorecardId: id,
              fileId,
              sessionUserId: responder.userId,
            }),
        );
        res.json(result);
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
    correctiveActionPublicLimiter,
    requireFieldSessionOrToken,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const id = String(req.params.id);
        const itemId = String(req.params.itemId);
        assertValidUuid(id, "id");
        assertValidUuid(itemId, "itemId");
        const comment = parseComment(req.body?.comment);
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
