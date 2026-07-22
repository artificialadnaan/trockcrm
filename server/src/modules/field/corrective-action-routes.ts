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
import { assertActiveFieldProject } from "./projects-service.js";
import { verifyCorrectiveActionToken } from "./corrective-action-tokens.js";
import { getCorrectiveActionItems, submitCorrectiveActionResponse } from "./corrective-action-api.js";

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
 *   - session path: the field user must be able to browse the scorecard's deal (assertActiveFieldProject) —
 *     the same gate getFieldScorecardDetail uses. (Assigned-super/PM-only narrowing is a Plan 3/4 refinement.)
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
    // Gate on the scorecard's deal being browsable to this field user (throws 403/404 if not).
    await assertActiveFieldProject(db, { userId: fieldUser.id, userRole: fieldUser.role }, dealId);
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
        const items = await runInOffice(office, (db: FieldTenantDb) => getCorrectiveActionItems(db, id));
        res.json({ items });
      } catch (err) {
        next(err);
      }
    },
  );

  // Submit a per-item corrective-action response (comment + already-uploaded photo ids). Session OR token
  // auth. Marks the item resolved (auto-closing the scorecard when it's the last open item).
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
          return getCorrectiveActionItems(db, id);
        });
        res.json({ items });
      } catch (err) {
        next(err);
      }
    },
  );
}
