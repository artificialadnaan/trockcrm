import { Router } from "express";
import { eq } from "drizzle-orm";
import { files } from "@trock-crm/shared/schema";
import { AppError } from "../../middleware/error-handler.js";
import { eventBus } from "../../events/bus.js";
import { DOMAIN_EVENTS } from "@trock-crm/shared/types";
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
import type { FileCategory } from "@trock-crm/shared/types";
import { FILE_CATEGORIES } from "@trock-crm/shared/types";

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
    const {
      r2Key,
      systemFilename,
      displayName,
      folderPath,
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
      takenAt,
      geoLat,
      geoLng,
      parentFileId,
      version,
    } = req.body;

    if (!r2Key || !systemFilename || !displayName || !originalFilename || !mimeType || !fileSizeBytes || !category) {
      throw new AppError(400, "Missing required fields for upload confirmation.");
    }

    // RBAC: validate dealId access if provided
    if (dealId) {
      const deal = await getDealById(req.tenantDb!, dealId, req.user!.role, req.user!.id);
      if (!deal) throw new AppError(403, "Access denied: you do not have access to this deal.");
    }

    const file = await confirmUpload(req.tenantDb!, req.user!.id, {
      r2Key,
      systemFilename,
      displayName,
      folderPath: folderPath ?? "",
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
      takenAt,
      geoLat: geoLat ? Number(geoLat) : undefined,
      geoLng: geoLng ? Number(geoLng) : undefined,
    });

    // If this is a new version, update parent_file_id and version
    if (parentFileId && version) {
      await req.tenantDb!
        .update(files)
        .set({ parentFileId, version: Number(version) })
        .where(eq(files.id, file.id));
    }

    await req.commitTransaction!();

    // Emit file.uploaded event after commit
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
        officeId: req.user!.activeOfficeId ?? req.user!.officeId,
        userId: req.user!.id,
        timestamp: new Date(),
      });
    } catch (eventErr) {
      console.error("[Files] Failed to emit file.uploaded event:", eventErr);
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
    // RBAC: deal-scoped files require deal access check
    const existing = await getFileById(req.tenantDb!, req.params.id);
    if (!existing) throw new AppError(404, "File not found");
    if (existing.dealId) {
      const deal = await getDealById(req.tenantDb!, existing.dealId, req.user!.role, req.user!.id);
      if (!deal) throw new AppError(403, "Access denied: you do not have access to this deal's files.");
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
    // RBAC: deal-scoped files require deal access + role check.
    // Delete is restricted to director/admin for deal files, or the original uploader.
    const existing = await getFileById(req.tenantDb!, req.params.id);
    if (!existing) throw new AppError(404, "File not found");
    if (existing.dealId) {
      const deal = await getDealById(req.tenantDb!, existing.dealId, req.user!.role, req.user!.id);
      if (!deal) throw new AppError(403, "Access denied: you do not have access to this deal's files.");

      const isAdminOrDirector = req.user!.role === "admin" || req.user!.role === "director";
      const isUploader = existing.uploadedBy === req.user!.id;
      if (!isAdminOrDirector && !isUploader) {
        throw new AppError(403, "Only admins, directors, or the original uploader can delete deal files.");
      }
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
