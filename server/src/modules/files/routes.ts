import express, { Router } from "express";
import { files } from "@trock-crm/shared/schema";
import { FILE_CATEGORIES, isScopeLockedFileAction, PHOTO_CATEGORIES } from "@trock-crm/shared/types";
import { AppError } from "../../middleware/error-handler.js";
import { requireAdmin } from "../../middleware/rbac.js";
import { writeSoftDeleteAuditLog } from "../../lib/soft-delete-audit.js";
import { writeAuditLog } from "../../lib/audit-log.js";
import type { FileCategory } from "@trock-crm/shared/types";
import {
  requestUploadUrl,
  confirmUpload,
  uploadNewVersion,
  getFiles,
  getFileStats,
  getFileById,
  getFileByIdIncludingDeleted,
  getPendingUploadMetadata,
  getFileDownloadUrl,
  resolveFileDownloadAuditPurpose,
  shouldLogFileDownloadEvent,
  shouldServeExternalFileUrl,
  updateFile,
  updateFileAddress,
  deleteFile,
  getFileVersions,
  getTagSuggestions,
  getDealFolderTree,
  getDealPhotoTimeline,
  getDealPhotoUploaders,
  searchPhotoUploadTargets,
} from "./service.js";
import { getDealById } from "../deals/service.js";
import { assertDealScopingWriteAllowed } from "../deals/scoping-service.js";
import { getLeadById } from "../leads/service.js";
import {
  getPhotoFeed,
  getNewPhotoCount,
  getPhotoFeedFacets,
  getProjectPhotoStats,
  getUnassignedCompanyCamProjects,
  getUnassignedCompanyCamPhotos,
  assignUnassignedCompanyCamProjectToDeal,
  PHOTO_FEED_SOURCES,
  PROJECT_PHOTO_SORTS,
  type PhotoFeedFilters,
  type PhotoFeedSource,
  type ProjectPhotoSort,
} from "./feed-service.js";
import { getPhotoAuditEvents, logPhotoEvent } from "./audit-log-service.js";
import { emitUploadedFileEvent, recordUploadedFileSideEffects } from "./upload-workflow.js";
import { parseFileDateParam } from "./file-constants.js";
import { assertDealCollaboratorAccess, assertLeadCollaboratorAccess } from "../../lib/collaboration-access.js";

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

function parseForceEditAfterRfp(req: express.Request) {
  return req.body?.forceEditAfterRfp === true ||
    req.query.forceEditAfterRfp === "true" ||
    req.query.forceEditAfterRfp === "1";
}

async function assertDealLinkedFileMutationAllowed(
  req: express.Request,
  file: {
    id: string;
    dealId?: string | null;
    intakeSource?: string | null;
    intakeRequirementKey?: string | null;
  },
  action: string
) {
  if (!file.dealId) {
    return;
  }

  if (!isScopeLockedFileAction({
    action,
    intakeRequirementKey: file.intakeRequirementKey,
    intakeSource: file.intakeSource,
  })) {
    return;
  }

  const writePolicy = await assertDealScopingWriteAllowed(req.tenantDb!, file.dealId, {
    role: req.user!.role,
    forceEditAfterRfp: parseForceEditAfterRfp(req),
  });

  if (writePolicy.adminOverride) {
    await writeAuditLog(req.tenantDb!, {
      tableName: "deal_scoping_intake",
      recordId: file.dealId,
      action: "update",
      changedBy: req.user!.id,
      changes: {
        linkedFileMutation: {
          from: null,
          to: action,
        },
      },
      fullRow: {
        override: "admin_force_edit_after_rfp",
        route: "files",
        action,
        fileId: file.id,
        intakeRequirementKey: file.intakeRequirementKey,
        reason: writePolicy.lockState.reason,
      },
    });
  }
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

async function assertDealFileAccess(req: express.Request, dealId: string) {
  await assertDealCollaboratorAccess(req.tenantDb!, dealId, req.user!);
}

async function assertLeadFileAccess(req: express.Request, leadId: string) {
  await assertLeadCollaboratorAccess(req.tenantDb!, leadId, req.user!);
}

// POST /api/files/upload-url — Step 1: request presigned URL
router.post("/upload-url", async (req, res, next) => {
  try {
    const {
      originalFilename,
      mimeType,
      fileSizeBytes,
      category,
      autoCategorize,
      subcategory,
      dealId,
      leadId,
      contactId,
      procoreProjectId,
      changeOrderId,
      description,
      displayName,
      tags,
    } = req.body;

    // "Auto-detect": the client didn't choose a category, so the server infers it. Otherwise a category
    // is required + validated and the explicit choice (incl. "other"/Uncategorized) is respected.
    const autoDetect = autoCategorize === true;

    if (!originalFilename || !mimeType || !fileSizeBytes || (!autoDetect && !category)) {
      throw new AppError(
        400,
        autoDetect
          ? "originalFilename, mimeType, and fileSizeBytes are required."
          : "originalFilename, mimeType, fileSizeBytes, and category are required."
      );
    }

    if (!autoDetect && !FILE_CATEGORIES.includes(category)) {
      throw new AppError(400, `Invalid category "${category}". Valid: ${FILE_CATEGORIES.join(", ")}`);
    }

    // Validate deal access if dealId provided
    if (dealId) {
      await assertDealFileAccess(req, dealId);
    }
    if (leadId) {
      await assertLeadFileAccess(req, leadId);
    }

    const result = await requestUploadUrl(
      req.tenantDb!,
      req.officeSlug!,
      req.user!.id,
      {
        originalFilename,
        mimeType,
        fileSizeBytes: Number(fileSizeBytes),
        category: (autoDetect ? "other" : category) as FileCategory,
        autoCategorize: autoDetect,
        subcategory,
        dealId,
        leadId,
        contactId,
        procoreProjectId: procoreProjectId ? Number(procoreProjectId) : undefined,
        changeOrderId,
        description,
        displayName: typeof displayName === "string" ? displayName : undefined,
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
    const displayNameHeader = req.headers["x-file-display-name"] as string | undefined;
    let displayNameOverride: string | undefined;
    if (typeof displayNameHeader === "string" && displayNameHeader.length > 0) {
      try {
        displayNameOverride = decodeURIComponent(displayNameHeader);
      } catch {
        // Malformed percent-encoding — use the raw header value rather than 500 the upload.
        displayNameOverride = displayNameHeader;
      }
    }
    const tagsRaw = req.headers["x-file-tags"] as string | undefined;
    const tags = tagsRaw ? tagsRaw.split(",") : undefined;

    // "Auto-detect" via header: infer when the client didn't pick a category; otherwise require + respect.
    const autoDetect = (req.headers["x-auto-categorize"] as string) === "true";

    if (!originalFilename || (!autoDetect && !category)) {
      throw new AppError(
        400,
        autoDetect
          ? "x-original-filename header is required."
          : "x-original-filename and x-file-category headers are required."
      );
    }

    if (!autoDetect && !FILE_CATEGORIES.includes(category as any)) {
      throw new AppError(400, `Invalid category "${category}".`);
    }

    const body = req.body as Buffer;
    if (!body || body.length === 0) {
      throw new AppError(400, "Request body (file) is empty.");
    }

    // Validate deal access if dealId provided
    if (dealId) {
      await assertDealFileAccess(req, dealId);
    }
    if (leadId) {
      await assertLeadFileAccess(req, leadId);
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
        category: (autoDetect ? "other" : category) as FileCategory,
        autoCategorize: autoDetect,
        subcategory: subcategory || undefined,
        dealId,
        leadId,
        contactId,
        description,
        displayName: displayNameOverride,
        tags,
      }
    );

    // Upload to R2 server-side (no CORS needed)
    const { putObject, isR2Configured } = await import("../../lib/r2-client.js");
    if (isR2Configured()) {
      await putObject(result.r2Key, body, mimeType);
    }

    // Confirm the upload (creates the file record)
    const { file, created } = await confirmUpload(req.tenantDb!, req.user!.id, {
      uploadToken: result.uploadToken,
    });

    const officeId = req.user!.activeOfficeId ?? req.user!.officeId;
    if (created) {
      await recordUploadedFileSideEffects(req.tenantDb!, {
        file,
        userId: req.user!.id,
        officeId,
        auditContext: requestAuditContext(req),
      });
    }

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

    const pendingUpload = getPendingUploadMetadata(uploadToken);

    if (addressSource !== undefined && addressSource !== "exif" && addressSource !== "live_gps") {
      throw new AppError(400, "addressSource must be either exif or live_gps.");
    }

    const { file, created } = await confirmUpload(req.tenantDb!, req.user!.id, {
      uploadToken,
      takenAt,
      geoLat: geoLat !== undefined ? Number(geoLat) : undefined,
      geoLng: geoLng !== undefined ? Number(geoLng) : undefined,
      latitude: latitude !== undefined ? Number(latitude) : undefined,
      longitude: longitude !== undefined ? Number(longitude) : undefined,
      addressSource,
    });

    const officeId = req.user!.activeOfficeId ?? req.user!.officeId;
    if (created) {
      await recordUploadedFileSideEffects(req.tenantDb!, {
        file,
        userId: req.user!.id,
        officeId,
        addressSource,
        auditContext: requestAuditContext(req),
      });
    }

    await req.commitTransaction!();

    if (created) emitUploadedFileEvent({ file, userId: req.user!.id, officeId });

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
      await assertDealFileAccess(req, existing.dealId);
    } else if (existing.leadId) {
      await assertLeadFileAccess(req, existing.leadId);
    } else if (req.user.role === "rep" && existing.uploadedBy !== req.user.id) {
      throw new AppError(403, "You can only modify files you uploaded");
    }
    await assertDealLinkedFileMutationAllowed(req, existing, "address_update");

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
      await assertDealFileAccess(req, parentFile.dealId);
    }
    await assertDealLinkedFileMutationAllowed(req, parentFile, "new_version");

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
      await assertDealFileAccess(req, req.query.dealId as string);
    }
    if (isRep && req.query.leadId) {
      await assertLeadFileAccess(req, req.query.leadId as string);
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
      // Validated/normalized so a malformed date is dropped, not passed to the SQL cast (→500).
      dateFrom: parseFileDateParam(req.query.dateFrom),
      dateTo: parseFileDateParam(req.query.dateTo),
      page: req.query.page ? parseInt(req.query.page as string, 10) : undefined,
      // Cap the page size: getFiles now batch-presigns a thumbnail URL per row (Task 7), so an arbitrarily
      // large client-supplied limit would fan into an arbitrarily large presign pass. 200 mirrors the
      // photo-timeline ceiling and is >= every real caller (deal Files tab = 25, global /files browser =
      // 200). `|| 50` guards a non-numeric/zero limit.
      limit: req.query.limit
        ? Math.min(200, Math.max(1, parseInt(req.query.limit as string, 10) || 50))
        : undefined,
      sortBy: req.query.sortBy as
        | "display_name"
        | "created_at"
        | "file_size_bytes"
        | "taken_at"
        | "file_type"
        | "category"
        | "extension"
        | undefined,
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
    await assertDealFileAccess(req, req.params.dealId);

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
    await assertDealFileAccess(req, req.params.dealId);

    // Parse defensively — parseInt of non-numeric text is NaN, and Math.max/min won't coerce it, so guard
    // for finite values and fall back to the defaults (else NaN would reach getDealPhotoTimeline).
    const pageRaw = parseInt(req.query.page as string, 10);
    const page = Number.isFinite(pageRaw) ? Math.max(1, pageRaw) : 1;
    // Numbered pages: clamp the page size to [1, 200]. The server batch-presigns every photo on the page,
    // so the cap bounds that work (and keeps each page snappy) regardless of what the client requests.
    const limitRaw = parseInt(req.query.limit as string, 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(200, Math.max(1, limitRaw)) : 60;
    const categories = typeof req.query.category === "string" && req.query.category.length > 0
      ? req.query.category.split(",")
      : undefined;
    const tags = typeof req.query.tags === "string" && req.query.tags.length > 0
      ? req.query.tags.split(",")
      : undefined;
    const uploaderIds = typeof req.query.uploader === "string" && req.query.uploader.length > 0
      ? req.query.uploader.split(",")
      : undefined;

    const includeDeleted = req.query.deleted === "1" || req.query.deleted === "true";
    // req.tenantDb is a single transaction-bound pg client — running these two queries with Promise.all
    // would trip "client already executing" and 500 the page. Await them sequentially on the same client.
    const result = await getDealPhotoTimeline(req.tenantDb!, req.params.dealId, page, limit, {
      categories,
      tags,
      uploaderIds,
      from: req.query.from as string | undefined,
      to: req.query.to as string | undefined,
      includeDeleted,
    });
    // Deal-wide uploader facet so the filter dropdown is stable across pages (not just this page's set).
    const uploaders = await getDealPhotoUploaders(req.tenantDb!, req.params.dealId, { includeDeleted });
    await req.commitTransaction!();
    res.json({ ...result, facets: { uploaders } });
  } catch (err) {
    next(err);
  }
});

function optionalQueryString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

const UUID_QUERY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Absent stays absent; present-but-malformed is a 400 rather than a 500 from a failed uuid cast.
 *
 * Checked locally rather than by importing field/photos-service's `assertValidUuid`: that module pulls
 * in the public-photo-token service, the upload workflow and the field projects service behind it, which
 * is a lot of graph (and a plausible import cycle, since it imports files/service.js) to acquire one
 * regex. `procore/routes.ts` and `internal-rfp/routes.ts` already keep their own local `isUuid` for the
 * same reason.
 */
function optionalUuidQueryParam(raw: unknown, field: string): string | undefined {
  const value = optionalQueryString(raw);
  if (value === undefined) return undefined;
  if (!UUID_QUERY_PATTERN.test(value)) throw new AppError(400, `${field} must be a valid uuid.`);
  return value;
}

/**
 * One parser for BOTH photo-feed tabs, so the Projects tab and the Photos tab can never interpret the
 * same query string differently (a filter honoured on one tab and dropped on the other is exactly how
 * the two surfaces end up reporting different totals for the same selection).
 *
 * Two different failure policies here, on purpose:
 *
 * DROPPED — the enum dimensions and the dates. These name a VALUE within a dimension, so a stale
 * `?source=…` or `?dateFrom=…` from a bookmarked or shared URL should degrade to "unfiltered" rather
 * than 400 a page the user did not do anything wrong to reach. Dates go through `parseFileDateParam`
 * for the same reason the `photoCategory` predicate compares the cast COLUMN: the filter reaches SQL as
 * `${value}::timestamptz`, so an unparseable string raises PG 22007 and surfaces as a 500.
 *
 * REJECTED — `dealId` and `uploadedBy`. These are compared against uuid COLUMNS (`files.deal_id`,
 * `files.uploaded_by`), so a malformed value raises PG 22P02 and the generic handler turns it into a
 * 500. Dropping them silently would be worse than 400-ing: the caller asked to narrow to one project
 * and would get the WHOLE library back, presented as if it were filtered. A well-formed uuid that no
 * longer exists still degrades quietly to an empty result, which is the stale-bookmark case that
 * actually happens.
 *
 * Both hazards predate this change on `/photos/feed`, but this parser is what routes the same params
 * into `/photos/project-stats`, which took no filters at all before.
 */
export function parseFeedFilterQuery(query: express.Request["query"]): PhotoFeedFilters {
  const source = optionalQueryString(query.source);
  return {
    dealId: optionalUuidQueryParam(query.dealId, "dealId"),
    uploadedBy: optionalUuidQueryParam(query.uploadedBy, "uploadedBy"),
    subcategory: optionalQueryString(query.subcategory),
    photoCategory: optionalQueryString(query.photoCategory),
    source: PHOTO_FEED_SOURCES.includes(source as PhotoFeedSource) ? (source as PhotoFeedSource) : undefined,
    dateFrom: parseFileDateParam(query.dateFrom),
    dateTo: parseFileDateParam(query.dateTo),
    page: query.page ? parseInt(query.page as string, 10) : undefined,
    limit: query.limit ? parseInt(query.limit as string, 10) : undefined,
  };
}

// GET /api/files/photos/project-stats — photo counts and metadata grouped by project, sorted and paged
// SERVER-SIDE. The sort must not move to the client: it would only ever reorder the rows the server
// already chose, so "most photos" would silently mean "most-photographed of the most recent page".
router.get("/photos/project-stats", async (req, res, next) => {
  try {
    const sort = optionalQueryString(req.query.sort);
    const result = await getProjectPhotoStats(req.tenantDb!, {
      ...parseFeedFilterQuery(req.query),
      sort: PROJECT_PHOTO_SORTS.includes(sort as ProjectPhotoSort) ? (sort as ProjectPhotoSort) : undefined,
      // "My Projects" resolves to the CALLER, never to a client-supplied id — otherwise the pill would
      // double as an arbitrary rep filter that no other surface offers.
      assignedRepId: req.query.mine === "1" ? req.user!.id : undefined,
      search: optionalQueryString(req.query.q),
    });
    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/files/photos/feed/facets — options for the feed's filter dropdowns. Separate from the row
// endpoints (rather than embedded in every response) because the options are filter-independent, so the
// client fetches them once per mount instead of on every sort/filter change.
router.get("/photos/feed/facets", async (req, res, next) => {
  try {
    const facets = await getPhotoFeedFacets(req.tenantDb!);
    await req.commitTransaction!();
    res.json(facets);
  } catch (err) {
    next(err);
  }
});

// GET /api/files/photos/unassigned-companycam — rescued CompanyCam photos with no deal, grouped by
// their source CompanyCam project (the "Unassigned" tab).
router.get("/photos/unassigned-companycam", async (req, res, next) => {
  try {
    const result = await getUnassignedCompanyCamProjects(req.tenantDb!);
    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/files/photos/unassigned-companycam/:companycamProjectId — paginated photos for one
// unassigned CompanyCam project (drill-in from the "Unassigned" tab).
router.get("/photos/unassigned-companycam/:companycamProjectId", async (req, res, next) => {
  try {
    const result = await getUnassignedCompanyCamPhotos(
      req.tenantDb!,
      req.params.companycamProjectId,
      req.query.page ? parseInt(req.query.page as string, 10) : undefined,
      req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
    );
    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/files/photos/unassigned-companycam/:companycamProjectId/assign — assign EVERY unassigned photo
// in one CompanyCam project to a deal (the "Assign to deal" action on the Unassigned tab). Universal: any
// authenticated CRM user, no role gate — mirrors the GET endpoints on this tab so the whole team can
// consolidate the rescued-photo backlog onto the right deals.
router.post("/photos/unassigned-companycam/:companycamProjectId/assign", async (req, res, next) => {
  try {
    const dealId = typeof req.body?.dealId === "string" ? req.body.dealId.trim() : "";
    if (!dealId) throw new AppError(400, "dealId is required");
    const result = await assignUnassignedCompanyCamProjectToDeal(
      req.tenantDb!,
      req.params.companycamProjectId,
      dealId,
    );
    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/files/photos/feed — paginated cross-deal photo feed
router.get("/photos/feed", async (req, res, next) => {
  try {
    const result = await getPhotoFeed(req.tenantDb!, req.user!.role, req.user!.id, parseFeedFilterQuery(req.query));
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
      await assertDealFileAccess(req, file.dealId);
    } else if (file.leadId) {
      await assertLeadFileAccess(req, file.leadId);
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
      await assertDealFileAccess(req, file.dealId);
    } else if (file.leadId) {
      await assertLeadFileAccess(req, file.leadId);
    }

    const logDownload = shouldLogFileDownloadEvent(req.query);
    const auditPurpose = resolveFileDownloadAuditPurpose(req.query);

    // External-only files can return their source URL. R2-backed imports keep
    // their external URL as metadata, but must render/download through R2.
    if (shouldServeExternalFileUrl(file)) {
      if (logDownload && isPhotoRecord(file)) {
        await logPhotoEvent(req.tenantDb!, {
          photoId: file.id,
          eventType: "downloaded",
          userId: req.user!.id,
          ...requestAuditContext(req),
          metadata: { purpose: auditPurpose },
        });
      }
      await req.commitTransaction!();
      res.json({ url: file.externalUrl, filename: file.displayName + file.fileExtension });
      return;
    }

    // `?disposition=inline` opts into an inline preview; the service allowlists which mimes may actually
    // render inline (image/* except svg, application/pdf, text/plain) and forces attachment otherwise.
    // (This param pass-through is typecheck-only; the disposition SELECTION is proven in
    // download-disposition.runtime.test.ts and the real signed header in src/lib/r2-client.test.ts.)
    const result = await getFileDownloadUrl(
      req.tenantDb!,
      req.params.id,
      req.query.disposition as string | undefined,
    );
    if (logDownload && isPhotoRecord(file)) {
      await logPhotoEvent(req.tenantDb!, {
        photoId: file.id,
        eventType: "downloaded",
        userId: req.user!.id,
        ...requestAuditContext(req),
        metadata: { purpose: auditPurpose },
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
      await assertDealFileAccess(req, file.dealId);
    } else if (file.leadId) {
      await assertLeadFileAccess(req, file.leadId);
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
      await assertDealFileAccess(req, file.dealId);
    } else if (file.leadId) {
      await assertLeadFileAccess(req, file.leadId);
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
      await assertDealFileAccess(req, existing.dealId);
    } else if (existing.leadId) {
      await assertLeadFileAccess(req, existing.leadId);
    } else if (req.user!.role === "rep" && existing.uploadedBy !== req.user!.id) {
      // Fix 8: Non-deal files (e.g. contact files) — reps can only modify files they uploaded
      throw new AppError(403, "You can only modify files you uploaded");
    }
    await assertDealLinkedFileMutationAllowed(req, existing, isRestore ? "restore" : "metadata_update");

    const { displayName, description, notes, tags, category, subcategory, folderPath, photoCategory } = req.body;
    // A legacy client may send the photo's phase category in the `category` field. Treat an incoming
    // `category` as a photo-PHASE edit ONLY when it is a photo-EXCLUSIVE value (in PHOTO_CATEGORIES but
    // NOT also a real file category). "other" is BOTH a legacy photo phase and a genuine file category,
    // so without the exclusion a photo->Other reclassification from the generic edit modal would be
    // silently swallowed (category stays "photo"), clobber the existing phase to "other", and drop the
    // photo subfolder. `category === null` still clears the phase for true legacy phase-in-category
    // clients (a null file category is meaningless — the column is NOT NULL).
    const categoryTargetsPhotoCategory =
      existing.category === "photo" &&
      (category === null ||
        (typeof category === "string" &&
          (PHOTO_CATEGORIES as readonly string[]).includes(category) &&
          !(FILE_CATEGORIES as readonly string[]).includes(category)));
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
    await assertDealLinkedFileMutationAllowed(req, existing, "delete");

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
