import express, { Router } from "express";
import { AppError } from "../../middleware/error-handler.js";
import { requireAdmin } from "../../middleware/rbac.js";
import { requestAuditContext, writeSoftDeleteAuditLog } from "../../lib/soft-delete-audit.js";
import { redactDealList, shouldIncludeHubspotId } from "../deals/redact.js";
import { createProperty, deleteProperty, getPropertyDetail, listProperties, updateProperty } from "./service.js";
import { parseMoneyBound } from "./query-params.js";
import {
  PROPERTY_IMAGE_MAX_BYTES,
  buildPropertyImageR2Key,
  clearPropertyImageKeys,
  isAcceptablePropertyImageMime,
  propertyExists,
  resolvePropertyImageExtension,
  setPropertyImageKeys,
  type PropertyImageKeys,
} from "./property-image-service.js";
import { deleteObject, isR2Configured, putObject } from "../../lib/r2-client.js";
import { generateAndStoreThumbnail } from "../../lib/image-thumbnail.js";

const router = Router();

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

router.post("/", async (req, res, next) => {
  try {
    const { companyId, name, address, city, state, zip, buildYear, unitCount, notes } = req.body;
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
    });
    await req.commitTransaction!();
    res.status(201).json({ property });
  } catch (err) {
    next(err);
  }
});

router.patch("/:id", async (req, res, next) => {
  try {
    const allowedFields = ["address", "city", "state", "zip", "buildYear", "unitCount"] as const;
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
router.post("/:id/image", express.raw({ type: () => true, limit: PROPERTY_IMAGE_MAX_BYTES }), async (req, res, next) => {
  try {
    const propertyId = req.params.id as string;
    const mimeType = (req.headers["content-type"] as string | undefined) ?? "application/octet-stream";
    if (!isAcceptablePropertyImageMime(mimeType)) {
      throw new AppError(400, "Property photo must be an image (JPEG, PNG, WebP, HEIC, or GIF).");
    }
    const body = req.body as Buffer;
    if (!body || body.length === 0) {
      throw new AppError(400, "Request body (image) is empty.");
    }

    // Confirm the property exists BEFORE writing to R2 so a bad id can't orphan an object.
    if (!(await propertyExists(req.tenantDb!, propertyId))) {
      throw new AppError(404, "Property not found");
    }

    const extension = resolvePropertyImageExtension(decodeOriginalFilename(req.headers["x-original-filename"]), mimeType);
    const imageR2Key = buildPropertyImageR2Key(propertyId, extension, Date.now());

    let imageThumbnailR2Key: string | null = null;
    if (isR2Configured()) {
      await putObject(imageR2Key, body, mimeType);
      // Best-effort thumbnail; a null result just means the avatar renders from the full-size original.
      imageThumbnailR2Key = await generateAndStoreThumbnail(imageR2Key, mimeType, body);
    }

    const updated = await setPropertyImageKeys(req.tenantDb!, propertyId, { imageR2Key, imageThumbnailR2Key });
    if (!updated) {
      throw new AppError(404, "Property not found");
    }
    const detail = await getPropertyDetail(req.tenantDb!, propertyId);
    await req.commitTransaction!();

    await deletePropertyImageObjects(updated.previousKeys);
    res.status(201).json({ property: detail?.property ?? null });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/properties/:id/image — remove the property's cover photo (same edit surface as PATCH).
router.delete("/:id/image", async (req, res, next) => {
  try {
    const propertyId = req.params.id as string;
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
