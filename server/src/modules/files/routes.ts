import { Router } from "express";
import { eq, sql } from "drizzle-orm";
import { files } from "@trock-crm/shared/schema";
import { AppError } from "../../middleware/error-handler.js";
import { eventBus } from "../../events/bus.js";
import { DOMAIN_EVENTS } from "@trock-crm/shared/types";
import type { FileCategory } from "@trock-crm/shared/types";
import { FILE_CATEGORIES } from "@trock-crm/shared/types";
import {
  requestUploadUrl,
  confirmUpload,
  uploadNewVersion,
  getFiles,
  getFileById,
  getFileDownloadUrl,
  updateFile,
  deleteFile,
  getFileVersions,
  getTagSuggestions,
  getDealFolderTree,
  getDealPhotoTimeline,
} from "./service.js";
import { getDealById } from "../deals/service.js";

const router = Router();

// POST /api/files/upload-url — Step 1: request presigned URL
router.post("/upload-url", async (req, res, next) => {
  try {
    const {
      originalFilename,
      mimeType,
      fileSizeBytes,
      category,
      subcategory,
      dealId,
      contactId,
      procoreProjectId,
      changeOrderId,
      description,
      tags,
    } = req.body;

    if (!originalFilename || !mimeType || !fileSizeBytes || !category) {
      throw new AppError(400, "originalFilename, mimeType, fileSizeBytes, and category are required.");
    }

    if (!FILE_CATEGORIES.includes(category)) {
      throw new AppError(400, `Invalid category "${category}". Valid: ${FILE_CATEGORIES.join(", ")}`);
    }

    // Validate deal access if dealId provided
    if (dealId) {
      const deal = await getDealById(req.tenantDb!, dealId, req.user!.role, req.user!.id);
      if (!deal) throw new AppError(404, "Deal not found or access denied.");
    }

    const result = await requestUploadUrl(
      req.tenantDb!,
      req.officeSlug!,
      req.user!.id,
      {
        originalFilename,
        mimeType,
        fileSizeBytes: Number(fileSizeBytes),
        category: category as FileCategory,
        subcategory,
        dealId,
        contactId,
        procoreProjectId: procoreProjectId ? Number(procoreProjectId) : undefined,
        changeOrderId,
        description,
        tags,
      }
    );

    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/files/confirm-upload — Step 2: record file metadata after upload
router.post("/confirm-upload", async (req, res, next) => {
  try {
    const { uploadToken, takenAt, geoLat, geoLng } = req.body;

    // Fix 2: Require upload token — all other metadata is server-trusted
    if (!uploadToken) {
      throw new AppError(400, "uploadToken is required.");
    }

    const file = await confirmUpload(req.tenantDb!, req.user!.id, {
      uploadToken,
      takenAt,
      geoLat: geoLat ? Number(geoLat) : undefined,
      geoLng: geoLng ? Number(geoLng) : undefined,
    });

    // Fix 1: Insert job into job_queue before commit so the worker picks it up.
    // The worker processes domain_event jobs -- emitLocal alone never reached it.
    const officeId = req.user!.activeOfficeId ?? req.user!.officeId;
    const jobPayload = JSON.stringify({
      eventName: "file.uploaded",
      fileId: file.id,
      r2Key: file.r2Key,
      mimeType: file.mimeType,
      dealId: file.dealId,
      contactId: file.contactId,
      category: file.category,
      uploadedBy: req.user!.id,
    });
    // jobQueue is in the public schema — use raw SQL since tenantDb targets tenant schema.
    await req.tenantDb!.execute(
      sql`INSERT INTO public.job_queue (job_type, payload, office_id, status, run_after)
          VALUES ('domain_event', ${jobPayload}::jsonb, ${officeId}::uuid, 'pending', NOW())`
    );

    await req.commitTransaction!();

    // Best-effort local emit after commit (for any in-process listeners)
    try {
      eventBus.emitLocal({
        name: DOMAIN_EVENTS.FILE_UPLOADED,
        payload: {
          fileId: file.id,
          r2Key: file.r2Key,
          mimeType: file.mimeType,
          dealId: file.dealId,
          contactId: file.contactId,
          category: file.category,
          uploadedBy: req.user!.id,
        },
        officeId,
        userId: req.user!.id,
        timestamp: new Date(),
      });
    } catch (_) {
      // Best effort — worker will handle it via job_queue
    }

    res.status(201).json({ file });
  } catch (err) {
    next(err);
  }
});

// POST /api/files/:id/new-version — Upload a new version of a file
router.post("/:id/new-version", async (req, res, next) => {
  try {
    const { originalFilename, mimeType, fileSizeBytes, category, subcategory, tags } = req.body;

    if (!originalFilename || !mimeType || !fileSizeBytes) {
      throw new AppError(400, "originalFilename, mimeType, and fileSizeBytes are required.");
    }

    // Fix 7: RBAC — load parent file and check deal access
    const parentFile = await getFileById(req.tenantDb!, req.params.id);
    if (!parentFile) throw new AppError(404, "File not found");
    if (parentFile.dealId) {
      const deal = await getDealById(req.tenantDb!, parentFile.dealId, req.user!.role, req.user!.id);
      if (!deal) throw new AppError(403, "Access denied: you do not have access to this deal's files.");
    }

    // Fix 5: parentFileId comes from the URL param; version is computed server-side.
    // The client does NOT supply parentFileId or version.
    const result = await uploadNewVersion(
      req.tenantDb!,
      req.officeSlug!,
      req.user!.id,
      req.params.id,
      {
        originalFilename,
        mimeType,
        fileSizeBytes: Number(fileSizeBytes),
        category: (category as FileCategory) ?? "other",
        subcategory,
        tags,
      }
    );

    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/files — list files (paginated, filtered, sorted)
router.get("/", async (req, res, next) => {
  try {
    // Fix 6: For reps, require a dealId or contactId filter.
    // Without it, reps would see all office files. Directors/admins see all.
    const isRep = req.user!.role === "rep";
    if (isRep && !req.query.dealId && !req.query.contactId) {
      throw new AppError(400, "dealId or contactId filter is required.");
    }

    // Fix 4: Reps CAN query by contactId without additional access checks.
    // Contact files are intentionally office-shared — all reps in the same
    // office can see contact files, matching the visibility model for contacts.

    // If rep specifies a dealId, verify they have access to it
    if (isRep && req.query.dealId) {
      const deal = await getDealById(req.tenantDb!, req.query.dealId as string, req.user!.role, req.user!.id);
      if (!deal) throw new AppError(403, "Access denied: you do not have access to this deal's files.");
    }

    const filters = {
      dealId: req.query.dealId as string | undefined,
      contactId: req.query.contactId as string | undefined,
      procoreProjectId: req.query.procoreProjectId
        ? Number(req.query.procoreProjectId)
        : undefined,
      changeOrderId: req.query.changeOrderId as string | undefined,
      category: req.query.category as FileCategory | undefined,
      folderPath: req.query.folderPath as string | undefined,
      search: req.query.search as string | undefined,
      tags: req.query.tags
        ? (req.query.tags as string).split(",")
        : undefined,
      page: req.query.page ? parseInt(req.query.page as string, 10) : undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
      sortBy: req.query.sortBy as "display_name" | "created_at" | "file_size_bytes" | "taken_at" | undefined,
      sortDir: req.query.sortDir as "asc" | "desc" | undefined,
    };

    const result = await getFiles(req.tenantDb!, filters);
    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/files/tags — tag autocomplete suggestions
// Fix 5: Tags are office-scoped metadata for autocomplete. Knowing tag names
// does not leak file content, so no per-file RBAC check is needed here.
router.get("/tags", async (req, res, next) => {
  try {
    const dealId = req.query.dealId as string | undefined;
    const tags = await getTagSuggestions(req.tenantDb!, dealId);
    await req.commitTransaction!();
    res.json({ tags });
  } catch (err) {
    next(err);
  }
});

// GET /api/files/deal/:dealId/folders — virtual folder tree for a deal
router.get("/deal/:dealId/folders", async (req, res, next) => {
  try {
    const deal = await getDealById(req.tenantDb!, req.params.dealId, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found or access denied.");

    const tree = await getDealFolderTree(req.tenantDb!, req.params.dealId);
    await req.commitTransaction!();
    res.json({ folders: tree });
  } catch (err) {
    next(err);
  }
});

// GET /api/files/deal/:dealId/photos — photo timeline for a deal
router.get("/deal/:dealId/photos", async (req, res, next) => {
  try {
    const deal = await getDealById(req.tenantDb!, req.params.dealId, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found or access denied.");

    const page = req.query.page ? parseInt(req.query.page as string, 10) : 1;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;

    const result = await getDealPhotoTimeline(req.tenantDb!, req.params.dealId, page, limit);
    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/files/:id — single file metadata
router.get("/:id", async (req, res, next) => {
  try {
    const file = await getFileById(req.tenantDb!, req.params.id);
    if (!file) throw new AppError(404, "File not found");

    // RBAC: if file has a dealId, verify the user has access to that deal.
    // Contact/project files are office-scoped so any tenant user can view.
    if (file.dealId) {
      const deal = await getDealById(req.tenantDb!, file.dealId, req.user!.role, req.user!.id);
      if (!deal) throw new AppError(403, "Access denied: you do not have access to this deal's files.");
    }

    await req.commitTransaction!();
    res.json({ file });
  } catch (err) {
    next(err);
  }
});

// GET /api/files/:id/download — presigned download URL
router.get("/:id/download", async (req, res, next) => {
  try {
    const file = await getFileById(req.tenantDb!, req.params.id);
    if (!file) throw new AppError(404, "File not found");

    // RBAC: deal-scoped files require deal access check
    if (file.dealId) {
      const deal = await getDealById(req.tenantDb!, file.dealId, req.user!.role, req.user!.id);
      if (!deal) throw new AppError(403, "Access denied: you do not have access to this deal's files.");
    }

    const result = await getFileDownloadUrl(req.tenantDb!, req.params.id);
    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/files/:id/versions — version history chain
router.get("/:id/versions", async (req, res, next) => {
  try {
    // Fix 7: RBAC — load file and check deal access
    const file = await getFileById(req.tenantDb!, req.params.id);
    if (!file) throw new AppError(404, "File not found");
    if (file.dealId) {
      const deal = await getDealById(req.tenantDb!, file.dealId, req.user!.role, req.user!.id);
      if (!deal) throw new AppError(403, "Access denied: you do not have access to this deal's files.");
    }

    const versions = await getFileVersions(req.tenantDb!, req.params.id);
    await req.commitTransaction!();
    res.json({ versions });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/files/:id — update file metadata
router.patch("/:id", async (req, res, next) => {
  try {
    const existing = await getFileById(req.tenantDb!, req.params.id);
    if (!existing) throw new AppError(404, "File not found");

    // RBAC: deal-scoped files require deal access check
    if (existing.dealId) {
      const deal = await getDealById(req.tenantDb!, existing.dealId, req.user!.role, req.user!.id);
      if (!deal) throw new AppError(403, "Access denied: you do not have access to this deal's files.");
    } else if (req.user!.role === "rep" && existing.uploadedBy !== req.user!.id) {
      // Fix 8: Non-deal files (e.g. contact files) — reps can only modify files they uploaded
      throw new AppError(403, "You can only modify files you uploaded");
    }

    const { displayName, description, notes, tags, category, subcategory, folderPath } = req.body;

    const file = await updateFile(req.tenantDb!, req.params.id, {
      displayName,
      description,
      notes,
      tags,
      category,
      subcategory,
      folderPath,
    });
    await req.commitTransaction!();
    res.json({ file });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/files/:id — soft-delete a file
router.delete("/:id", async (req, res, next) => {
  try {
    const existing = await getFileById(req.tenantDb!, req.params.id);
    if (!existing) throw new AppError(404, "File not found");

    const isAdminOrDirector = req.user!.role === "admin" || req.user!.role === "director";
    const isUploader = existing.uploadedBy === req.user!.id;

    if (existing.dealId) {
      // RBAC: deal-scoped files require deal access + role check
      const deal = await getDealById(req.tenantDb!, existing.dealId, req.user!.role, req.user!.id);
      if (!deal) throw new AppError(403, "Access denied: you do not have access to this deal's files.");

      if (!isAdminOrDirector && !isUploader) {
        throw new AppError(403, "Only admins, directors, or the original uploader can delete deal files.");
      }
    } else if (req.user!.role === "rep" && !isUploader) {
      // Fix 8: Non-deal files — reps can only delete files they uploaded
      throw new AppError(403, "You can only delete files you uploaded");
    }

    await deleteFile(req.tenantDb!, req.params.id, req.user!.role);
    await req.commitTransaction!();
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// --- Dev-mode routes (only active when R2 is not configured) ---

// PUT /api/files/dev-upload — mock upload endpoint for dev mode
// Must be PUT to match the client's XHR method (presigned URLs use PUT).
router.put("/dev-upload", async (req, res, next) => {
  try {
    if (process.env.NODE_ENV === "production") {
      throw new AppError(404, "Not found");
    }
    // In dev mode, just accept the upload and return success
    res.json({ success: true, message: "Dev mode: file upload simulated." });
  } catch (err) {
    next(err);
  }
});

// GET /api/files/dev-download — mock download endpoint for dev mode
router.get("/dev-download", async (_req, res, next) => {
  try {
    if (process.env.NODE_ENV === "production") {
      throw new AppError(404, "Not found");
    }
    res.json({ message: "Dev mode: file download simulated. R2 not configured." });
  } catch (err) {
    next(err);
  }
});

export const fileRoutes = router;
