import { Router, type Request } from "express";
import { eq } from "drizzle-orm";
import { users } from "@trock-crm/shared/schema";
import { AppError } from "../../middleware/error-handler.js";
import { getAccessibleOffices } from "../auth/service.js";
import { listUsers } from "../admin/users-service.js";
import { isCrmUserRole } from "../../middleware/field-auth.js";
import { sanitizeSignatureHtml, MAX_SIGNATURE_HTML_BYTES } from "../../lib/sanitize-signature.js";
import { generateUploadUrl, isR2Configured } from "../../lib/r2-client.js";
import {
  SIGNATURE_LOGO_TYPES,
  SIGNATURE_LOGO_MAX_BYTES,
  signatureLogoKey,
  assertOwnedSignatureLogoKey,
  enforceSignatureLogoSize,
} from "./signature-logo.js";

const router = Router();

function publicSignatureLogoBaseUrl(req: Request): string {
  const proto = req.get("x-forwarded-proto") ?? req.protocol;
  return `${proto}://${req.get("host")}/api/public/signature-logo`;
}

router.get("/crm-owners", async (req, res, next) => {
  try {
    const rows = (await listUsers()) as Array<{
      id: string;
      email: string;
      displayName: string;
      role: string;
      officeId: string | null;
      isActive: boolean;
    }>;

    await req.commitTransaction!();
    res.json({
      users: rows
        .filter((user) => user.isActive && isCrmUserRole(user.role))
        .map((user) => ({
          id: user.id,
          displayName: user.displayName,
          email: user.email,
          officeId: user.officeId,
        })),
    });
  } catch (err) {
    next(err);
  }
});

router.get("/sales-reps", async (req, res, next) => {
  try {
    const purpose = typeof req.query.purpose === "string" ? req.query.purpose : undefined;
    const isDealReassignmentPicker = purpose === "deal-reassignment";
    const isLeadReassignmentPicker = purpose === "lead-reassignment";
    const isReassignmentPicker = isDealReassignmentPicker || isLeadReassignmentPicker;
    // The sales-source picker needs the active office's CRM roster (any internal role — rep, director like
    // Chase Kelly, admin, construction — matching the assertSalesSourceIsCrmUser gate), NOT the self-only
    // feed a plain rep otherwise gets. Without this a rep creating a service opportunity would see only
    // themselves (then excluded as the owner) → an empty source list.
    const isSalesSourcePicker = purpose === "sales-source";

    if (req.user!.role === "rep" && !isReassignmentPicker && !isSalesSourcePicker) {
      await req.commitTransaction!();
      res.json({ users: [{ id: req.user!.id, displayName: req.user!.displayName, email: req.user!.email }] });
      return;
    }

    const requestedOfficeId = req.headers["x-office-id"] as string | undefined;
    const officeId = requestedOfficeId ?? req.user!.activeOfficeId ?? req.user!.officeId;
    const accessibleOffices = await getAccessibleOffices(
      req.user!.id,
      req.user!.role,
      req.user!.activeOfficeId ?? req.user!.officeId
    );

    if (requestedOfficeId && !accessibleOffices.some((office) => office.id === requestedOfficeId)) {
      throw new AppError(403, "Requested office is not accessible");
    }

    const rows = (await listUsers(officeId)) as Array<{
      id: string;
      email: string;
      displayName: string;
      role?: string;
      officeId: string | null;
      isActive: boolean;
    }>;
    await req.commitTransaction!();
    res.json({
      users: rows
        .filter((user) => user.isActive)
        .filter((user) => {
          // Sales-source and record-reassignment pickers restrict to internal CRM users (any role except
          // field_contractor) — matching assertSalesSourceIsCrmUser / the reassignment guard. The generic
          // feed (legacy callers) applies no role filter.
          if (isSalesSourcePicker || isReassignmentPicker) {
            return "role" in user && typeof user.role === "string" ? isCrmUserRole(user.role) : true;
          }
          return true;
        })
        // Do NOT re-filter to `user.officeId === officeId`. listUsers(officeId) already scopes the rows to
        // the active office via "office_id = officeId OR has a user_office_access grant to it", so a
        // primary-office-only filter STRIPS grant-holders — exactly the multi-office users the deal
        // reassignment (#748) and estimator (validateAssignee) backends ACCEPT, leaving valid candidates
        // un-pickable in the UI. The office scope is enforced in the SQL + the accessibleOffices check above.
        .map((user) => ({ id: user.id, displayName: user.displayName, email: user.email })),
    });
  } catch (err) {
    next(err);
  }
});

// ---- Per-user CRM email signature ----

// Current user's stored signature HTML (for the settings editor + the compose preview).
router.get("/me/signature", async (req, res, next) => {
  try {
    const [row] = await req.tenantDb!
      .select({ emailSignature: users.emailSignature })
      .from(users)
      .where(eq(users.id, req.user!.id))
      .limit(1);
    await req.commitTransaction!();
    res.json({ emailSignature: row?.emailSignature ?? "" });
  } catch (err) {
    next(err);
  }
});

// Save the current user's signature. Sanitized server-side (authoritative — never trust the client
// copy); empty/whitespace clears it (null ⇒ no append at send).
router.patch("/me/signature", async (req, res, next) => {
  try {
    const raw = (req.body ?? {}).emailSignature;
    if (raw != null && typeof raw !== "string") {
      throw new AppError(400, "emailSignature must be a string");
    }
    // Byte cap (UTF-8), not UTF-16 code units — multibyte content must not bypass the limit.
    if (typeof raw === "string" && Buffer.byteLength(raw, "utf8") > MAX_SIGNATURE_HTML_BYTES) {
      throw new AppError(413, "Signature is too large");
    }
    const clean = sanitizeSignatureHtml(raw);
    await req.tenantDb!
      .update(users)
      .set({ emailSignature: clean === "" ? null : clean })
      .where(eq(users.id, req.user!.id));
    await req.commitTransaction!();
    res.json({ emailSignature: clean });
  } catch (err) {
    next(err);
  }
});

// Step 1: presigned PUT for a signature logo, under the user's OWN folder. We do NOT hand back a
// usable public URL here — a presigned PUT can't bound the uploaded size, so the URL is only issued
// by /confirm after the server verifies the actual object size.
router.post("/me/signature-logo/upload-url", async (req, res, next) => {
  try {
    if (!isR2Configured()) throw new AppError(503, "Image storage is not configured.");
    const contentType = typeof (req.body ?? {}).contentType === "string" ? req.body.contentType : "";
    const ext = SIGNATURE_LOGO_TYPES[contentType];
    if (!ext) throw new AppError(400, "Logo must be a PNG, JPEG, GIF, or WebP image.");
    const r2Key = signatureLogoKey(req.user!.id, ext);
    const upload = await generateUploadUrl(r2Key, contentType, SIGNATURE_LOGO_MAX_BYTES);
    await req.commitTransaction!();
    res.json({ uploadUrl: upload.uploadUrl, r2Key, maxBytes: SIGNATURE_LOGO_MAX_BYTES });
  } catch (err) {
    next(err);
  }
});

// Step 2: after the client PUTs the bytes, confirm the upload. The server enforces the size cap by
// reading the object's REAL size and deleting it if oversized (the client size check is cosmetic and
// bypassable) — only then is a servable public URL returned. The key must be the caller's own.
router.post("/me/signature-logo/confirm", async (req, res, next) => {
  try {
    if (!isR2Configured()) throw new AppError(503, "Image storage is not configured.");
    const r2Key = typeof (req.body ?? {}).r2Key === "string" ? req.body.r2Key : "";
    assertOwnedSignatureLogoKey(r2Key, req.user!.id);
    await enforceSignatureLogoSize(r2Key); // headObject → delete + 413 if over the cap
    const asset = r2Key.slice(`signature-logos/${req.user!.id}/`.length);
    const publicUrl = `${publicSignatureLogoBaseUrl(req)}/${req.user!.id}/${asset}`;
    await req.commitTransaction!();
    res.json({ publicUrl });
  } catch (err) {
    next(err);
  }
});

export { router as userRoutes };
