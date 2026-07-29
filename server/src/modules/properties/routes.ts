import express, { Router } from "express";
import { AppError } from "../../middleware/error-handler.js";
import { requireAdmin } from "../../middleware/rbac.js";
import { requestAuditContext, writeSoftDeleteAuditLog } from "../../lib/soft-delete-audit.js";
import { redactDealList, shouldIncludeHubspotId } from "../deals/redact.js";
import { createProperty, deleteProperty, getPropertyDetail, listProperties, updateProperty } from "./service.js";
import { parseMoneyBound } from "./query-params.js";
import { matchProperties } from "./match-service.js";
import { randomUUID } from "node:crypto";
import {
  PROPERTY_IMAGE_MAX_BYTES,
  activePropertyExists,
  buildPropertyImageR2Key,
  clearPropertyImageKeys,
  isHeicImageMime,
  resolveEffectivePropertyImageMime,
  setPropertyImageKeys,
  type PropertyImageKeys,
} from "./property-image-service.js";
import { deleteObject, isR2Configured, putObject } from "../../lib/r2-client.js";
import { generateAndStoreThumbnail, probeStorableImageFormat, transcodeHeicToStorableJpeg } from "../../lib/image-thumbnail.js";

const router = Router();

/**
 * A query-string coordinate, or null.
 *
 * `Number("")` is 0, not NaN, so a blank `?lat=` reads as the equator: a bad position that matches
 * nothing rather than an absent one that degrades to address-only matching. Blank-checked BEFORE
 * coercion for that reason.
 */
function readCoordinateParam(raw: unknown, limit: number): number | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && Math.abs(value) <= limit ? value : null;
}


router.get("/", async (req, res, next) => {
  try {
    const { search, companyId, type, sortBy, sortDir, page, limit, isActive, minLinkedValue, maxLinkedValue } =
      req.query as Record<string, string>;
    const result = await listProperties(req.tenantDb!, {
      search,
      companyId,
      type,
      sortBy,
      sortDir: sortDir === "asc" ? "asc" : sortDir === "desc" ? "desc" : undefined,
      minLinkedValue: parseMoneyBound(minLinkedValue),
      maxLinkedValue: parseMoneyBound(maxLinkedValue),
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 100,
      isActive: isActive === "false" ? false : true,
    });
    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/properties/match?lat=&lng=&address= — the property a rep is standing at.
 *
 * Deliberately a READ that returns candidates rather than a create-or-get. The field capture shows what
 * matched and why, and only offers "add a new property" when this comes back empty — because the
 * alternative, creating on a near-miss, is how ~94 duplicate property groups happen faster.
 *
 * Returns [] rather than erroring when there is nothing to match on; see matchProperties.
 */
router.get("/match", async (req, res, next) => {
  try {
    const matches = await matchProperties(req.tenantDb!, {
      lat: readCoordinateParam(req.query.lat, 90),
      lng: readCoordinateParam(req.query.lng, 180),
      address: typeof req.query.address === "string" ? req.query.address : null,
      // Locality can only DISPROVE an address match — "100 Main St" exists in every city, and without
      // these the copy two towns over outranks the building the rep is standing on.
      city: typeof req.query.city === "string" ? req.query.city : null,
      state: typeof req.query.state === "string" ? req.query.state : null,
      zip: typeof req.query.zip === "string" ? req.query.zip : null,
    });
    // Commit like every sibling handler. Without it this tenant-scoped request falls through to the
    // close-event rollback and holds its pooled client until the response finishes — avoidable pool
    // pressure on the one route a rep hits at every stop.
    await req.commitTransaction!();
    res.json({ matches });
  } catch (err) {
    next(err);
  }
});

router.post("/", async (req, res, next) => {
  try {
    const { companyId, name, address, city, state, zip, buildYear, unitCount, notes, lat, lng } =
      req.body;
    if (!companyId) {
      throw new AppError(400, "companyId is required");
    }
    if (!name?.trim()) {
      throw new AppError(400, "Property name is required");
    }
    const property = await createProperty(req.tenantDb!, {
      companyId,
      name: name.trim(),
      address,
      city,
      state,
      zip,
      buildYear,
      unitCount,
      notes,
      // Optional and additive — every existing caller omits them and is unchanged. Field capture sends
      // the Mapbox geocode so the property is findable by distance next time someone stands there.
      lat,
      lng,
    });
    await req.commitTransaction!();
    res.status(201).json({ property });
  } catch (err) {
    next(err);
  }
});

router.patch("/:id", async (req, res, next) => {
  try {
    // lat/lng included so a cleared geocode can be RESTORED. An address edit wipes the pair (a geocode
    // of the old line is worse than none), and without a write path here the only way to set
    // coordinates was creation — leaving every edited or legacy property permanently address-only, and
    // making the "the next field visit repopulates it" note a promise nothing could keep.
    const allowedFields = ["address", "city", "state", "zip", "buildYear", "unitCount", "lat", "lng"] as const;
    const input: Parameters<typeof updateProperty>[2] = {};
    for (const field of allowedFields) {
      if (Object.prototype.hasOwnProperty.call(req.body, field)) {
        input[field] = req.body[field];
      }
    }
    const property = await updateProperty(req.tenantDb!, req.params.id, input);
    if (!property) {
      throw new AppError(404, "Property not found");
    }
    await req.commitTransaction!();
    res.json({ property });
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", requireAdmin, async (req, res, next) => {
  try {
    const propertyId = req.params.id as string;
    const property = await deleteProperty(req.tenantDb!, propertyId);
    if (property) {
      await writeSoftDeleteAuditLog(req.tenantDb!, {
        actorUserId: req.user!.id,
        entityType: "property",
        entityId: propertyId,
        ...requestAuditContext(req),
      });
    }
    await req.commitTransaction!();
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const result = await getPropertyDetail(req.tenantDb!, req.params.id);
    if (!result) {
      throw new AppError(404, "Property not found");
    }
    await req.commitTransaction!();
    const includeHubspotId = shouldIncludeHubspotId(req.query, req.user!.role);
    res.json({ ...result, deals: redactDealList(result.deals ?? [], { includeHubspotId }) });
  } catch (err) {
    next(err);
  }
});

function decodeOriginalFilename(header: unknown): string | undefined {
  if (typeof header !== "string" || header.length === 0) return undefined;
  try {
    return decodeURIComponent(header);
  } catch {
    // Malformed percent-encoding — fall back to the raw header rather than 500 the upload.
    return header;
  }
}

// Raw-body parser for the cover-photo upload that translates the body-parser size-limit error into a clean
// 413 AppError. Without this, an over-cap upload rejects BEFORE the handler's try block and the shared error
// handler turns the raw PayloadTooLargeError into a generic 500 instead of a clear "too large" message.
function rawPropertyImageBody() {
  const parser = express.raw({ type: () => true, limit: PROPERTY_IMAGE_MAX_BYTES });
  return (req: Parameters<typeof parser>[0], res: Parameters<typeof parser>[1], next: (err?: unknown) => void) => {
    parser(req, res, (err: unknown) => {
      if (err && ((err as { type?: string }).type === "entity.too.large" || (err as { statusCode?: number }).statusCode === 413)) {
        const maxMb = Math.floor(PROPERTY_IMAGE_MAX_BYTES / (1024 * 1024));
        return next(new AppError(413, `Photo is too large. Please upload an image under ${maxMb} MB.`));
      }
      next(err);
    });
  };
}

// Best-effort R2 cleanup of superseded/removed cover-photo objects. Never throws — cleanup failure must
// not fail a request that has already committed the authoritative DB change.
async function deletePropertyImageObjects(keys: PropertyImageKeys): Promise<void> {
  if (!isR2Configured()) return;
  for (const key of [keys.imageR2Key, keys.imageThumbnailR2Key]) {
    if (!key) continue;
    try {
      await deleteObject(key);
    } catch {
      // ignore — orphaned object is harmless and can be swept later
    }
  }
}

// POST /api/properties/:id/image — upload (or replace) the property's cover photo. Accepts raw image bytes
// with the mime in Content-Type; anyone who can edit the property may set it (same surface as PATCH).
router.post("/:id/image", rawPropertyImageBody(), async (req, res, next) => {
  try {
    const propertyId = req.params.id as string;
    const originalFilename = decodeOriginalFilename(req.headers["x-original-filename"]);
    // Resolve the type from Content-Type, falling back to the filename extension — browsers often send
    // application/octet-stream for camera images (HEIC especially), and rejecting on that would block a
    // valid photo before the decoder/transcoder runs.
    const mimeType = resolveEffectivePropertyImageMime(req.headers["content-type"] as string | undefined, originalFilename);
    if (!mimeType) {
      throw new AppError(400, "Property photo must be an image (JPEG, PNG, WebP, HEIC, or GIF).");
    }
    const body = req.body as Buffer;
    if (!body || body.length === 0) {
      throw new AppError(400, "Request body (image) is empty.");
    }

    // Fail fast when storage is unavailable — otherwise we'd persist an image key with no object behind it,
    // reporting a false success and (once R2 is configured) presigning a key that 404s.
    if (!isR2Configured()) {
      throw new AppError(503, "Image storage is not configured.");
    }

    // Confirm the property exists AND is active BEFORE writing to R2 — a bad id can't orphan an object, and
    // a soft-deleted property (read-only) can't have its cover mutated via a stale deep link.
    if (!(await activePropertyExists(req.tenantDb!, propertyId))) {
      throw new AppError(404, "Property not found");
    }

    // Derive the stored MIME + extension from the ACTUAL bytes, not the client metadata. HEIC/HEIF can't
    // render in most browsers, so transcode to a FULL-RESOLUTION JPEG up front and store THAT; everything
    // else is probed so a corrupt/spoofed file (e.g. a TIFF renamed .jpg) is rejected rather than stored as
    // a cover that renders broken.
    let uploadBuffer = body;
    let uploadMime: string;
    let extension: string;
    if (isHeicImageMime(mimeType)) {
      try {
        uploadBuffer = await transcodeHeicToStorableJpeg(body);
      } catch {
        throw new AppError(400, "Could not process this HEIC photo. Please upload a JPEG or PNG.");
      }
      uploadMime = "image/jpeg";
      extension = "jpg";
    } else {
      try {
        const probed = await probeStorableImageFormat(body);
        uploadMime = probed.mime;
        extension = probed.extension;
      } catch {
        throw new AppError(400, "This image could not be read. Please upload a valid JPEG, PNG, WebP, or GIF.");
      }
    }

    // A random suffix (not just the timestamp) makes each upload key globally unique, so two near-
    // simultaneous replacements can't share a key and have one's cleanup delete the other's live object.
    const imageR2Key = buildPropertyImageR2Key(propertyId, extension, `${Date.now()}-${randomUUID()}`);

    await putObject(imageR2Key, uploadBuffer, uploadMime);
    // Best-effort thumbnail; a null result just means the avatar renders from the full-size original.
    const imageThumbnailR2Key = await generateAndStoreThumbnail(imageR2Key, uploadMime, uploadBuffer);
    const newlyUploaded: PropertyImageKeys = { imageR2Key, imageThumbnailR2Key };

    let committed = false;
    try {
      const updated = await setPropertyImageKeys(req.tenantDb!, propertyId, { imageR2Key, imageThumbnailR2Key });
      if (!updated) {
        // Property was removed/soft-deleted between the check and the locked write.
        throw new AppError(404, "Property not found");
      }
      const detail = await getPropertyDetail(req.tenantDb!, propertyId);
      await req.commitTransaction!();
      committed = true;

      // Post-commit: the DB now points at the new keys, so delete the SUPERSEDED objects.
      await deletePropertyImageObjects(updated.previousKeys);
      res.status(201).json({ property: detail?.property ?? null });
    } catch (err) {
      // Pre-commit failure: the DB rolls back and won't reference these objects, so delete them so they
      // don't orphan in R2. (No-op once committed.)
      if (!committed) {
        await deletePropertyImageObjects(newlyUploaded);
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

// DELETE /api/properties/:id/image — remove the property's cover photo (same edit surface as PATCH).
router.delete("/:id/image", async (req, res, next) => {
  try {
    const propertyId = req.params.id as string;
    // A soft-deleted property is read-only — don't mutate its cover even via a stale deep link.
    if (!(await activePropertyExists(req.tenantDb!, propertyId))) {
      throw new AppError(404, "Property not found");
    }
    const cleared = await clearPropertyImageKeys(req.tenantDb!, propertyId);
    if (!cleared) {
      throw new AppError(404, "Property not found");
    }
    const detail = await getPropertyDetail(req.tenantDb!, propertyId);
    await req.commitTransaction!();

    await deletePropertyImageObjects(cleared.previousKeys);
    res.json({ property: detail?.property ?? null });
  } catch (err) {
    next(err);
  }
});

export const propertyRoutes = router;
