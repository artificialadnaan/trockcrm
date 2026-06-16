import { Router, type Request } from "express";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { users } from "@trock-crm/shared/schema";
import { AppError } from "../../middleware/error-handler.js";
import { getAccessibleOffices } from "../auth/service.js";
import { listUsers } from "../admin/users-service.js";
import { isCrmUserRole } from "../../middleware/field-auth.js";
import { sanitizeSignatureHtml, MAX_SIGNATURE_HTML_BYTES } from "../../lib/sanitize-signature.js";
import { generateUploadUrl, isR2Configured } from "../../lib/r2-client.js";

const router = Router();

// Allowed signature-logo image types → file extension. The logo is stored in R2 and referenced by
// an <img> URL (never base64-embedded), so it must be a real hosted image of a known type.
const SIGNATURE_LOGO_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};
const SIGNATURE_LOGO_MAX_BYTES = 1_000_000; // 1 MB

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

    if (req.user!.role === "rep" && !isDealReassignmentPicker) {
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
        .filter((user) =>
          isDealReassignmentPicker && "role" in user && typeof user.role === "string"
            ? isCrmUserRole(user.role)
            : true
        )
        .filter((user) =>
          isDealReassignmentPicker && officeId
            ? user.officeId === officeId
            : true
        )
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
    if (typeof raw === "string" && raw.length > MAX_SIGNATURE_HTML_BYTES) {
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

// Presigned PUT for a signature logo. Stored under the user's OWN folder; served permanently +
// publicly by GET /api/public/signature-logo/:userId/:asset (R2 exposes no public URL of its own).
router.post("/me/signature-logo/upload-url", async (req, res, next) => {
  try {
    if (!isR2Configured()) throw new AppError(503, "Image storage is not configured.");
    const contentType = typeof (req.body ?? {}).contentType === "string" ? req.body.contentType : "";
    const ext = SIGNATURE_LOGO_TYPES[contentType];
    if (!ext) throw new AppError(400, "Logo must be a PNG, JPEG, GIF, or WebP image.");
    const asset = `${randomUUID()}.${ext}`;
    const r2Key = `signature-logos/${req.user!.id}/${asset}`;
    const upload = await generateUploadUrl(r2Key, contentType, SIGNATURE_LOGO_MAX_BYTES);
    const publicUrl = `${publicSignatureLogoBaseUrl(req)}/${req.user!.id}/${asset}`;
    await req.commitTransaction!();
    res.json({ uploadUrl: upload.uploadUrl, publicUrl, r2Key, maxBytes: SIGNATURE_LOGO_MAX_BYTES });
  } catch (err) {
    next(err);
  }
});

export { router as userRoutes };
