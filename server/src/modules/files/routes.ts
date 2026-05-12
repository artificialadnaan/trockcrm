import express, { Router } from "express";
import { files } from "@trock-crm/shared/schema";
import { AppError } from "../../middleware/error-handler.js";
import { requireAdmin } from "../../middleware/rbac.js";
import { writeSoftDeleteAuditLog } from "../../lib/soft-delete-audit.js";
import type { FileCategory } from "@trock-crm/shared/types";
import { FILE_CATEGORIES } from "@trock-crm/shared/types";
import {
  requestUploadUrl,
  confirmUpload,
  uploadNewVersion,
  getFiles,
  getFileStats,
  getFileById,
  getFileByIdIncludingDeleted,
  getFileDownloadUrl,
  shouldLogFileDownloadEvent,
  shouldServeExternalFileUrl,
  updateFile,
  updateFileAddress,
  deleteFile,
  getFileVersions,
  getTagSuggestions,
  getDealFolderTree,
  getDealPhotoTimeline,
  searchPhotoUploadTargets,
} from "./service.js";
import { getDealById } from "../deals/service.js";
import { getLeadById } from "../leads/service.js";
import { getPhotoFeed, getNewPhotoCount, getProjectPhotoStats } from "./feed-service.js";
import { getPhotoAuditEvents, logPhotoEvent } from "./audit-log-service.js";
import { emitUploadedFileEvent, recordUploadedFileSideEffects } from "./upload-workflow.js";

const router = Router();

function requestAuditContext(req: express.Request) {
  const userAgentHeader = req.headers["user-agent"];
  return {
    ipAddress: req.ip ?? null,
    userAgent: Array.isArray(userAgentHeader) ? userAgentHeader.join(", ") : userAgentHeader ?? null,
  };
}

function isPhotoRecord(file: { category?: string | null }) {
  return file.category === "photo";
}

function parseFileKind(value: unknown): "photos" | "documents" | undefined {
  if (value == null || value === "") return undefined;
  if (value === "photos" || value === "documents") return value;
  throw new AppError(400, "fileKind must be photos or documents.");
}

function parseLinkedType(value: unknown): "deal" | "lead" | "contact" | "procore" | "change_order" | "unassigned" | undefined {
  if (value == null || value === "") return undefined;
  if (
    value === "deal" ||
    value === "lead" ||
    value === "contact" ||
    value === "procore" ||
    value === "change_order" ||
    value === "unassigned"
  ) {
    return value;
  }
  throw new AppError(400, "linkedType must be deal, lead, contact, procore, change_order, or unassigned.");
}

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
      leadId,
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
    if (leadId) {
      const lead = await getLeadById(req.tenantDb!, leadId, req.user!.role, req.user!.id);
      if (!lead) throw new AppError(404, "Lead not found or access denied.");
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
        leadId,
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

// POST /api/files/upload-direct — Server-side upload (bypasses CORS issues with presigned URLs)
// Accepts raw file body with metadata in headers. The server uploads to R2 directly.
router.post("/upload-direct", express.raw({ type: "*/*", limit: "50mb" }), async (req, res, next) => {
  try {
    const originalFilename = decodeURIComponent(req.headers["x-original-filename"] as string);
    const mimeType = req.headers["content-type"] as string || "application/octet-stream";
    const category = req.headers["x-file-category"] as string;
    const subcategory = req.headers["x-file-subcategory"] as string | undefined;
    const dealId = req.headers["x-deal-id"] as string | undefined;
    const leadId = req.headers["x-lead-id"] as string | undefined;
    const contactId = req.headers["x-contact-id"] as string | undefined;
    const description = req.headers["x-file-description"] as string | undefined;
    const tagsRaw = req.headers["x-file-tags"] as string | undefined;
    const tags = tagsRaw ? tagsRaw.split(",") : undefined;

    if (!originalFilename || !category) {
      throw new AppError(400, "x-original-filename and x-file-category headers are required.");
    }

    if (!FILE_CATEGORIES.includes(category as any)) {
      throw new AppError(400, `Invalid category "${category}".`);
    }

    const body = req.body as Buffer;
    if (!body || body.length === 0) {
      throw new AppError(400, "Request body (file) is empty.");
    }

    // Validate deal access if dealId provided
    if (dealId) {
      const deal = await getDealById(req.tenantDb!, dealId, req.user!.role, req.user!.id);
      if (!deal) throw new AppError(404, "Deal not found or access denied.");
    }
    if (leadId) {
      const lead = await getLeadById(req.tenantDb!, leadId, req.user!.role, req.user!.id);
      if (!lead) throw new AppError(404, "Lead not found or access denied.");
    }

    // Reuse the presign logic to generate filenames, r2Key, folderPath
    const result = await requestUploadUrl(
      req.tenantDb!,
      req.officeSlug!,
      req.user!.id,
      {
        originalFilename,
        mimeType,
        fileSizeBytes: body.length,
        category: category as FileCategory,
        subcategory: subcategory || undefined,
        dealId,
        leadId,
        contactId,
        description,
        tags,
      }
    );

    // Upload to R2 server-side (no CORS needed)
    const { putObject, isR2Configured } = await import("../../lib/r2-client.js");
    if (isR2Configured()) {
      await putObject(result.r2Key, body, mimeType);
    }

    // Confirm the upload (creates the file record)
    const file = await confirmUpload(req.tenantDb!, req.user!.id, {
      uploadToken: result.uploadToken,
    });

    const officeId = req.user!.activeOfficeId ?? req.user!.officeId;
    await recordUploadedFileSideEffects(req.tenantDb!, {
      file,
      userId: req.user!.id,
      officeId,
      auditContext: requestAuditContext(req),
    });

    await req.commitTransaction!();
    res.status(201).json({ file });
  } catch (err) {
    next(err);
  }
});

// POST /api/files/confirm-upload — Step 2: record file metadata after upload
router.post("/confirm-upload", async (req, res, next) => {
  try {
    const { uploadToken, takenAt, geoLat, geoLng, latitude, longitude, addressSource } = req.body;

    // Fix 2: Require upload token — all other metadata is server-trusted
    if (!uploadToken) {
      throw new AppError(400, "uploadToken is required.");
    }

    if (addressSource !== undefined && addressSource !== "exif" && addressSource !== "live_gps") {
      throw new AppError(400, "addressSource must be either exif or live_gps.");
    }

    const file = await confirmUpload(req.tenantDb!, req.user!.id, {
      uploadToken,
      takenAt,
      geoLat: geoLat !== undefined ? Number(geoLat) : undefined,
      geoLng: geoLng !== undefined ? Number(geoLng) : undefined,
      latitude: latitude !== undefined ? Number(latitude) : undefined,
      longitude: longitude !== undefined ? Number(longitude) : undefined,
      addressSource,
    });

    const officeId = req.user!.activeOfficeId ?? req.user!.officeId;
    await recordUploadedFileSideEffects(req.tenantDb!, {
      file,
      userId: req.user!.id,
      officeId,
      addressSource,
      auditContext: requestAuditContext(req),
    });

    await req.commitTransaction!();

    emitUploadedFileEvent({ file, userId: req.user!.id, officeId });

    res.status(201).json({ file });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/files/:id/address — manual address correction for photos
router.patch("/:id/address", async (req, res, next) => {
  try {
    if (!req.user) throw new AppError(401, "Authentication required.");

    const fileId = req.params.id as string;
    const existing = await getFileById(req.tenantDb!, fileId);
    if (!existing) throw new AppError(404, "File not found");

    if (existing.dealId) {
      const deal = await getDealById(req.tenantDb!, existing.dealId, req.user.role, req.user.id);
      if (!deal) throw new AppError(403, "Access denied: you do not have access to this deal's files.");
    } else if (existing.leadId) {
      const lead = await getLeadById(req.tenantDb!, existing.leadId, req.user.role, req.user.id);
      if (!lead) throw new AppError(403, "Access denied: you do not have access to this lead's files.");
    } else if (req.user.role === "rep" && existing.uploadedBy !== req.user.id) {
      throw new AppError(403, "You can only modify files you uploaded");
    }

    const { address, latitude, longitude } = req.body;
    if (!address || typeof address !== "string") {
      throw new AppError(400, "address is required.");
    }

    const file = await updateFileAddress(req.tenantDb!, req.params.id, {
      address,
      latitude: latitude !== undefined ? Number(latitude) : undefined,
      longitude: longitude !== undefined ? Number(longitude) : undefined,
    });
    if (isPhotoRecord(existing)) {
      await logPhotoEvent(req.tenantDb!, {
        photoId: existing.id,
        eventType: "address_changed",
        userId: req.user.id,
        ...requestAuditContext(req),
        metadata: {
          oldAddress: existing.address ?? null,
          newAddress: file.address ?? null,
          oldAddressSource: existing.addressSource ?? null,
          newAddressSource: "manual_override",
          oldLatitude: existing.latitude ?? null,
          oldLongitude: existing.longitude ?? null,
          newLatitude: file.latitude ?? null,
          newLongitude: file.longitude ?? null,
        },
      });
    }
    await req.commitTransaction!();
    res.json({ file });
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
    if (isRep && !req.query.dealId && !req.query.leadId && !req.query.contactId) {
      throw new AppError(400, "leadId, dealId, or contactId filter is required.");
    }

    // Fix 4: Reps CAN query by contactId without additional access checks.
    // Contact files are intentionally office-shared — all reps in the same
    // office can see contact files, matching the visibility model for contacts.

    // If rep specifies a dealId, verify they have access to it
    if (isRep && req.query.dealId) {
      const deal = await getDealById(req.tenantDb!, req.query.dealId as string, req.user!.role, req.user!.id);
      if (!deal) throw new AppError(403, "Access denied: you do not have access to this deal's files.");
    }
    if (isRep && req.query.leadId) {
      const lead = await getLeadById(req.tenantDb!, req.query.leadId as string, req.user!.role, req.user!.id);
      if (!lead) throw new AppError(403, "Access denied: you do not have access to this lead's files.");
    }

    const filters = {
      dealId: req.query.dealId as string | undefined,
      leadId: req.query.leadId as string | undefined,
      contactId: req.query.contactId as string | undefined,
      procoreProjectId: req.query.procoreProjectId
        ? Number(req.query.procoreProjectId)
        : undefined,
      changeOrderId: req.query.changeOrderId as string | undefined,
      category: req.query.category as FileCategory | undefined,
      fileKind: parseFileKind(req.query.fileKind),
      linkedType: parseLinkedType(req.query.linkedType),
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

// GET /api/files/stats — office-wide library metrics independent of page filters.
router.get("/stats", async (req, res, next) => {
  try {
    if (req.user!.role === "rep") {
      throw new AppError(400, "File library stats are restricted to directors and admins.");
    }

    const stats = await getFileStats(req.tenantDb!, {});
    await req.commitTransaction!();
    res.json({ stats });
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
    const categories = typeof req.query.category === "string" && req.query.category.length > 0
      ? req.query.category.split(",")
      : undefined;
    const uploaderIds = typeof req.query.uploader === "string" && req.query.uploader.length > 0
      ? req.query.uploader.split(",")
      : undefined;

    const result = await getDealPhotoTimeline(req.tenantDb!, req.params.dealId, page, limit, {
      categories,
      uploaderIds,
      from: req.query.from as string | undefined,
      to: req.query.to as string | undefined,
      includeDeleted: req.query.deleted === "1" || req.query.deleted === "true",
    });
    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/files/photos/project-stats — photo counts and metadata grouped by project
router.get("/photos/project-stats", async (req, res, next) => {
  try {
    const result = await getProjectPhotoStats(req.tenantDb!);
    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/files/photos/feed — paginated cross-deal photo feed
router.get("/photos/feed", async (req, res, next) => {
  try {
    const filters = {
      dealId: req.query.dealId as string | undefined,
      uploadedBy: req.query.uploadedBy as string | undefined,
      subcategory: req.query.subcategory as string | undefined,
      dateFrom: req.query.dateFrom as string | undefined,
      dateTo: req.query.dateTo as string | undefined,
      page: req.query.page ? parseInt(req.query.page as string, 10) : undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
    };

    const result = await getPhotoFeed(req.tenantDb!, req.user!.role, req.user!.id, filters);
    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/files/photos/feed/count — count new photos since a timestamp
router.get("/photos/feed/count", async (req, res, next) => {
  try {
    const since = req.query.since as string;
    if (!since) {
      throw new AppError(400, "since query parameter (ISO timestamp) is required.");
    }
    const sinceDate = new Date(since);
    if (isNaN(sinceDate.getTime())) {
      throw new AppError(400, "since must be a valid ISO timestamp.");
    }
    const count = await getNewPhotoCount(req.tenantDb!, req.user!.role, req.user!.id, sinceDate);
    await req.commitTransaction!();
    res.json({ count });
  } catch (err) {
    next(err);
  }
});

// GET /api/files/photo-targets/search — searchable upload targets for field photos
router.get("/photo-targets/search", async (req, res, next) => {
  try {
    const result = await searchPhotoUploadTargets(req.tenantDb!, {
      search: req.query.search as string | undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
    });
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
    } else if (file.leadId) {
      const lead = await getLeadById(req.tenantDb!, file.leadId, req.user!.role, req.user!.id);
      if (!lead) throw new AppError(403, "Access denied: you do not have access to this lead's files.");
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
    } else if (file.leadId) {
      const lead = await getLeadById(req.tenantDb!, file.leadId, req.user!.role, req.user!.id);
      if (!lead) throw new AppError(403, "Access denied: you do not have access to this lead's files.");
    }

    const logDownload = shouldLogFileDownloadEvent(req.query);

    // External-only files can return their source URL. R2-backed imports keep
    // their external URL as metadata, but must render/download through R2.
    if (shouldServeExternalFileUrl(file)) {
      if (logDownload && isPhotoRecord(file)) {
        await logPhotoEvent(req.tenantDb!, {
          photoId: file.id,
          eventType: "downloaded",
          userId: req.user!.id,
          ...requestAuditContext(req),
          metadata: {},
        });
      }
      await req.commitTransaction!();
      res.json({ url: file.externalUrl, filename: file.displayName + file.fileExtension });
      return;
    }

    const result = await getFileDownloadUrl(req.tenantDb!, req.params.id);
    if (logDownload && isPhotoRecord(file)) {
      await logPhotoEvent(req.tenantDb!, {
        photoId: file.id,
        eventType: "downloaded",
        userId: req.user!.id,
        ...requestAuditContext(req),
        metadata: {},
      });
    }
    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/files/:id/audit-log — photo-specific audit history
router.get("/:id/audit-log", async (req, res, next) => {
  try {
    const file = await getFileByIdIncludingDeleted(req.tenantDb!, req.params.id);
    if (!file) throw new AppError(404, "File not found");
    if (!isPhotoRecord(file)) throw new AppError(400, "Audit history is only available for photos.");

    if (file.dealId) {
      const deal = await getDealById(req.tenantDb!, file.dealId, req.user!.role, req.user!.id);
      if (!deal) throw new AppError(403, "Access denied: you do not have access to this deal's files.");
    } else if (file.leadId) {
      const lead = await getLeadById(req.tenantDb!, file.leadId, req.user!.role, req.user!.id);
      if (!lead) throw new AppError(403, "Access denied: you do not have access to this lead's files.");
    } else if (req.user!.role === "rep" && file.uploadedBy !== req.user!.id) {
      throw new AppError(403, "You can only view files you uploaded");
    }

    const events = await getPhotoAuditEvents(req.tenantDb!, file.id);
    await req.commitTransaction!();
    res.json({ events });
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
    } else if (file.leadId) {
      const lead = await getLeadById(req.tenantDb!, file.leadId, req.user!.role, req.user!.id);
      if (!lead) throw new AppError(403, "Access denied: you do not have access to this lead's files.");
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
    const isRestore = req.body.deletedAt === null || req.body.deleted_at === null;
    const existing = isRestore
      ? await getFileByIdIncludingDeleted(req.tenantDb!, req.params.id)
      : await getFileById(req.tenantDb!, req.params.id);
    if (!existing) throw new AppError(404, "File not found");

    // RBAC: deal-scoped files require deal access check
    if (existing.dealId) {
      const deal = await getDealById(req.tenantDb!, existing.dealId, req.user!.role, req.user!.id);
      if (!deal) throw new AppError(403, "Access denied: you do not have access to this deal's files.");
    } else if (existing.leadId) {
      const lead = await getLeadById(req.tenantDb!, existing.leadId, req.user!.role, req.user!.id);
      if (!lead) throw new AppError(403, "Access denied: you do not have access to this lead's files.");
    } else if (req.user!.role === "rep" && existing.uploadedBy !== req.user!.id) {
      // Fix 8: Non-deal files (e.g. contact files) — reps can only modify files they uploaded
      throw new AppError(403, "You can only modify files you uploaded");
    }

    const { displayName, description, notes, tags, category, subcategory, folderPath, photoCategory } = req.body;
    const photoCategoryValues = ["before", "after", "progress", "site_visit", "damage", "safety", "delivery", "other"];
    const categoryTargetsPhotoCategory =
      existing.category === "photo" && (category === null || (typeof category === "string" && photoCategoryValues.includes(category)));
    const resolvedPhotoCategory =
      photoCategory !== undefined
        ? photoCategory
        : categoryTargetsPhotoCategory
          ? category
          : undefined;

    const file = await updateFile(req.tenantDb!, req.params.id, {
      displayName,
      description,
      notes,
      tags,
      category: resolvedPhotoCategory === undefined ? category : undefined,
      subcategory,
      folderPath,
      photoCategory: resolvedPhotoCategory,
      deletedAt: isRestore ? null : undefined,
      deletedByUserId: isRestore ? null : undefined,
    });
    if (isPhotoRecord(existing)) {
      const auditContext = requestAuditContext(req);
      if (resolvedPhotoCategory !== undefined && existing.photoCategory !== file.photoCategory) {
        await logPhotoEvent(req.tenantDb!, {
          photoId: existing.id,
          eventType: "category_changed",
          userId: req.user!.id,
          ...auditContext,
          metadata: {
            oldCategory: existing.photoCategory ?? null,
            newCategory: file.photoCategory ?? null,
          },
        });
      }
      if (description !== undefined && existing.description !== file.description) {
        await logPhotoEvent(req.tenantDb!, {
          photoId: existing.id,
          eventType: "caption_changed",
          userId: req.user!.id,
          ...auditContext,
          metadata: {
            oldCaption: existing.description ?? null,
            newCaption: file.description ?? null,
          },
        });
      }
      if (isRestore && existing.deletedAt) {
        await logPhotoEvent(req.tenantDb!, {
          photoId: existing.id,
          eventType: "restored",
          userId: req.user!.id,
          ...auditContext,
          metadata: {
            previouslyDeletedAt: existing.deletedAt,
          },
        });
      }
    }
    await req.commitTransaction!();
    res.json({ file });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/files/:id — admin-only soft-delete a file
router.delete("/:id", requireAdmin, async (req, res, next) => {
  try {
    const fileId = req.params.id as string;
    const existing = await getFileById(req.tenantDb!, fileId);
    if (!existing) throw new AppError(404, "File not found");

    const deletedFile = await deleteFile(req.tenantDb!, fileId, req.user!.role, req.user!.id);
    if (deletedFile) {
      await writeSoftDeleteAuditLog(req.tenantDb!, {
        actorUserId: req.user!.id,
        entityType: "file",
        entityId: fileId,
        ...requestAuditContext(req),
      });
    }
    if (isPhotoRecord(existing)) {
      await logPhotoEvent(req.tenantDb!, {
        photoId: existing.id,
        eventType: "deleted",
        userId: req.user!.id,
        ...requestAuditContext(req),
        metadata: {},
      });
    }
    await req.commitTransaction!();
    res.status(204).send();
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
