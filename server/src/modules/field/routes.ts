import express, { Router } from "express";
import { requireFieldContractor } from "../../middleware/field-auth.js";
import { AppError } from "../../middleware/error-handler.js";
import { tenantMiddleware } from "../../middleware/tenant.js";
import { toFieldUserResponse } from "../field-users/service.js";
import {
  confirmFieldPhotoUpload,
  assignPendingFieldPhotoTarget,
  listPendingFieldPhotos,
  requestFieldPhotoUploadUrl,
} from "./photos-service.js";
import {
  getFieldPhotoTranscriptionConfig,
  transcribeAndPersistFieldPhotoDescription,
  transcribePhotoDescriptionAudio,
} from "./photo-transcription-service.js";
import {
  deleteFieldPhotoTag,
  replaceFieldPhotoTags,
  searchFieldProjectTags,
} from "./photo-tags-service.js";
import {
  generateFieldPhotoReport,
  getFieldProjectReportDownload,
  listFieldProjectReports,
  previewFieldPhotoReport,
} from "./photo-reports-service.js";
import {
  assertAccessibleFieldCaptureTarget,
  FIELD_PROJECTS_MAX_FETCH,
  listFieldProjects,
  listFieldProjectPhotos,
  listStarredFieldProjects,
  mergeFieldCaptureTargets,
  searchFieldCaptureTargets,
  starFieldProject,
  unstarFieldProject,
  type FieldProject,
} from "./projects-service.js";
import { assertValidCaptureTargetIds, assertValidUuid } from "./photos-service.js";
import {
  assertFanOutNotFullyDegraded,
  fanOutActiveOffices,
  getFieldOfficeById,
  isFieldCrossOfficeWritesEnabled,
  officeTag,
  resolveFieldWriteOffice,
  resolveWriteOffice,
  runInOffice,
  runInOfficeTransaction,
  withResolvedOffice,
  type FieldOffice,
  type FieldTenantDb,
} from "./cross-office.js";

// Default capture-target picker page size (mirrors searchPhotoUploadTargets' internal default), used as
// the GLOBAL cap when the cross-office picker merges per-office results.
const FIELD_CAPTURE_TARGET_DEFAULT_LIMIT = 30;

export const fieldRoutes = Router();

function parseOptionalPositiveInt(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new AppError(400, "limit must be a positive integer between 1 and 100");
  }
  return parsed;
}

function requestAuditContext(req: any) {
  const userAgentHeader = req.headers?.["user-agent"];
  return {
    ipAddress: req.ip ?? null,
    userAgent: Array.isArray(userAgentHeader) ? userAgentHeader.join(", ") : userAgentHeader ?? null,
  };
}

// ─── Cross-office write routing (Phase 2b) ───────────────────────────────────────────────────────
// These replace tenantMiddleware on the write routes. Flag OFF (or no target) → the uploader's active
// office in a transaction = byte-for-byte today's behavior. Flag ON → the resolved DEAL/FILE office,
// re-binding search_path (here), the R2 key slug, and job_queue.office_id (in the services).

/** Run a DEAL/LEAD-targeted field write in the resolved (or uploader's) office, transactionally. */
async function runFieldDealWrite<T>(
  req: any,
  target: { dealId?: string; leadId?: string; opportunityId?: string },
  run: (db: FieldTenantDb, office: FieldOffice) => Promise<T>,
  notFoundMessage?: string,
): Promise<T> {
  // Validate id FORMAT before resolving — an invalid uuid must be a clean 400, not a `::uuid` cast
  // error swallowed by the resolver fan-out and surfaced as a misleading 503.
  assertValidCaptureTargetIds(target);
  const office = await resolveFieldWriteOffice(req.fieldUser!.tenantId, target, notFoundMessage);
  return runInOfficeTransaction(office, req.fieldUser!.id, run);
}

/** Run a FILE-targeted field write (tags, transcription) in the photo's resolved (or uploader's) office. */
async function runFieldFileWrite<T>(
  req: any,
  fileId: string,
  run: (db: FieldTenantDb, office: FieldOffice) => Promise<T>,
  notFoundMessage = "Photo not found",
): Promise<T> {
  assertValidUuid(fileId, "photoId");
  const office = isFieldCrossOfficeWritesEnabled()
    ? await resolveWriteOffice("file", fileId, notFoundMessage)
    : await getFieldOfficeById(req.fieldUser!.tenantId);
  return runInOfficeTransaction(office, req.fieldUser!.id, run);
}

function rawAudioBody() {
  if (process.env.NODE_ENV === "test") {
    return (_req: any, _res: any, next: (err?: unknown) => void) => next();
  }
  return express.raw({
    type: ["audio/*", "application/octet-stream"],
    limit: "25mb",
  });
}

fieldRoutes.get("/me", requireFieldContractor, (req, res) => {
  res.json({
    user: toFieldUserResponse(req.fieldUser!),
  });
});

const fieldProjectMiddleware = [requireFieldContractor, tenantMiddleware] as const;

// Cross-office (field is office-agnostic): fan out the active-project list over ALL active offices,
// stamp each project with its owning office (dealNumber/name are unique per-schema only, so cross-office
// rows can be visually identical), merge by recency, and paginate over the merged set. One office
// failing degrades gracefully — its slug is surfaced in `degradedOffices`, the rest still return.
fieldRoutes.get("/projects", requireFieldContractor, async (req, res, next) => {
  try {
    const access = { userId: req.fieldUser!.id, userRole: req.fieldUser!.role };
    const status = req.query.status as string | undefined;
    if (status && status !== "active") {
      throw new AppError(400, "Only active field projects are supported");
    }
    const page = req.query.page ? Math.max(1, parseInt(req.query.page as string, 10)) : 1;
    const perPage = req.query.perPage ? Math.min(100, Math.max(1, parseInt(req.query.perPage as string, 10))) : 50;
    const offset = (page - 1) * perPage;
    // Fetch enough from EACH office to cover the requested window before merging (cross-office offset
    // can't be pushed into per-office SQL). Bounded by FIELD_PROJECTS_MAX_FETCH so a single dominant
    // office (e.g. Dallas with 1,275 active projects) can still be paged through up to that depth — the
    // earlier 100-row cap silently returned empty/wrong pages beyond page 2. Beyond the bound, narrow
    // via search.
    const fetchPerPage = Math.min(FIELD_PROJECTS_MAX_FETCH, offset + perPage);
    const { results, failures } = assertFanOutNotFullyDegraded(
      await fanOutActiveOffices((officeDb) =>
        listFieldProjects(officeDb, access, {
          search: req.query.search as string | undefined,
          status,
          page: 1,
          perPage: fetchPerPage,
        }),
      ),
    );
    const merged = results.flatMap(({ office, value }) =>
      value.projects.map((project: FieldProject) => ({ ...project, ...officeTag(office) })),
    );
    merged.sort((a, b) => (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? ""));
    const total = results.reduce((sum, { value }) => sum + value.total, 0);
    res.json({
      projects: merged.slice(offset, offset + perPage),
      total,
      page,
      perPage,
      degradedOffices: failures.map((failure) => failure.office.slug),
    });
  } catch (err) {
    next(err);
  }
});

fieldRoutes.get("/projects/starred", requireFieldContractor, async (req, res, next) => {
  try {
    const access = { userId: req.fieldUser!.id, userRole: req.fieldUser!.role };
    const { results, failures } = assertFanOutNotFullyDegraded(
      await fanOutActiveOffices((officeDb) => listStarredFieldProjects(officeDb, access)),
    );
    const projects = results
      .flatMap(({ office, value }) => value.projects.map((project: FieldProject) => ({ ...project, ...officeTag(office) })))
      .sort((a, b) => (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? ""));
    res.json({ projects, degradedOffices: failures.map((failure) => failure.office.slug) });
  } catch (err) {
    next(err);
  }
});

fieldRoutes.post("/projects/:dealId/star", requireFieldContractor, async (req, res, next) => {
  try {
    const dealId = String(req.params.dealId);
    const result = await runFieldDealWrite(req, { dealId }, (db) =>
      starFieldProject(db, { userId: req.fieldUser!.id, userRole: req.fieldUser!.role }, dealId),
      "Project not found",
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
});

fieldRoutes.delete("/projects/:dealId/star", requireFieldContractor, async (req, res, next) => {
  try {
    const dealId = String(req.params.dealId);
    const result = await runFieldDealWrite(req, { dealId }, (db) =>
      unstarFieldProject(db, { userId: req.fieldUser!.id, userRole: req.fieldUser!.role }, dealId),
      "Project not found",
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
});

fieldRoutes.post("/photos/upload-url", requireFieldContractor, async (req, res, next) => {
  try {
    const target = {
      dealId: typeof req.body.dealId === "string" ? req.body.dealId : undefined,
      leadId: typeof req.body.leadId === "string" ? req.body.leadId : undefined,
      opportunityId: typeof req.body.opportunityId === "string" ? req.body.opportunityId : undefined,
    };
    // The R2 key (b) is bound to the resolved office via `officeSlug: office.slug`; the deal-number
    // lookup inside requestUploadUrl runs in that same office's schema (a).
    const result = await runFieldDealWrite(req, target, (db, office) =>
      requestFieldPhotoUploadUrl(db, {
        officeSlug: office.slug,
        userId: req.fieldUser!.id,
        userRole: req.fieldUser!.role,
        ...target,
        contentType: String(req.body.contentType),
        sizeBytes: Number(req.body.sizeBytes),
        photoCategory: req.body.category ?? req.body.photoCategory ?? null,
        caption: req.body.caption ?? null,
        tags: Array.isArray(req.body.tags) ? req.body.tags.map(String) : [],
      }),
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
});

fieldRoutes.post("/photos/confirm-upload", requireFieldContractor, async (req, res, next) => {
  try {
    const target = {
      dealId: typeof req.body.dealId === "string" ? req.body.dealId : undefined,
      leadId: typeof req.body.leadId === "string" ? req.body.leadId : undefined,
      opportunityId: typeof req.body.opportunityId === "string" ? req.body.opportunityId : undefined,
    };
    // job_queue.office_id (c) is bound to the resolved office via `officeId: office.id`; officeSlug lets
    // confirmFieldPhotoUpload assert the token's r2Key was minted under this same office.
    const result = await runFieldDealWrite(req, target, (db, office) =>
      confirmFieldPhotoUpload(db, {
        userId: req.fieldUser!.id,
        userRole: req.fieldUser!.role,
        officeId: office.id,
        officeSlug: office.slug,
        ...target,
        uploadToken: String(req.body.uploadToken),
        objectKey: String(req.body.objectKey),
        latitude: req.body.latitude !== undefined ? Number(req.body.latitude) : undefined,
        longitude: req.body.longitude !== undefined ? Number(req.body.longitude) : undefined,
        addressSource: req.body.addressSource,
        takenAt: req.body.takenAt,
        auditContext: requestAuditContext(req),
      }),
    );
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

fieldRoutes.get("/photos/pending", ...fieldProjectMiddleware, async (req, res, next) => {
  try {
    const result = await listPendingFieldPhotos(req.tenantDb!, {
      userId: req.fieldUser!.id,
      userRole: req.fieldUser!.role,
    });
    await req.commitTransaction();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

fieldRoutes.post("/photos/:photoId/assign-target", requireFieldContractor, async (req, res, next) => {
  try {
    const photoId = String(req.params.photoId);
    assertValidUuid(photoId, "photoId");
    const target = {
      dealId: typeof req.body.dealId === "string" ? req.body.dealId : undefined,
      leadId: typeof req.body.leadId === "string" ? req.body.leadId : undefined,
      opportunityId: typeof req.body.opportunityId === "string" ? req.body.opportunityId : undefined,
    };
    assertValidCaptureTargetIds(target);

    const crossOffice = isFieldCrossOfficeWritesEnabled();
    // The PENDING photo physically lives in the office it was uploaded into (unassigned uploads park in
    // the uploader's office). The chosen target must live in that SAME office — otherwise binding it is a
    // cross-schema row move, which we reject (the files.deal_id FK is the structural backstop). Direct
    // capture (select a cross-office project, then shoot) is unaffected: that row is born in the deal's
    // office via upload-url + confirm.
    const photoOffice = crossOffice
      ? await resolveWriteOffice("file", photoId, "Pending photo not found")
      : await getFieldOfficeById(req.fieldUser!.tenantId);
    if (crossOffice) {
      const targetOffice = await resolveFieldWriteOffice(req.fieldUser!.tenantId, target, "Capture target not found");
      if (targetOffice.id !== photoOffice.id) {
        throw new AppError(
          409,
          `This photo was captured under ${photoOffice.slug} and can't be reassigned to a project in ${targetOffice.slug}. Re-capture it from that project instead.`,
        );
      }
    }

    const result = await runInOfficeTransaction(photoOffice, req.fieldUser!.id, (db) =>
      assignPendingFieldPhotoTarget(db, { userId: req.fieldUser!.id, userRole: req.fieldUser!.role }, {
        photoId,
        ...target,
      }),
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
});

fieldRoutes.get("/photos/transcribe-description", requireFieldContractor, (_req, res) => {
  res.json(getFieldPhotoTranscriptionConfig());
});

fieldRoutes.post("/photos/transcribe-description", requireFieldContractor, rawAudioBody(), async (req, res, next) => {
  try {
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const result = await transcribePhotoDescriptionAudio({
      audio: body,
      mimeType: String(req.headers["content-type"] ?? ""),
      fileName: typeof req.headers["x-file-name"] === "string" ? req.headers["x-file-name"] : undefined,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

fieldRoutes.post("/photos/:photoId/transcribe-description", requireFieldContractor, rawAudioBody(), async (req, res, next) => {
  try {
    const photoId = String(req.params.photoId);
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const result = await runFieldFileWrite(req, photoId, (db) =>
      transcribeAndPersistFieldPhotoDescription(db, {
        userId: req.fieldUser!.id,
        userRole: req.fieldUser!.role,
      }, {
        photoId,
        audio: body,
        mimeType: String(req.headers["content-type"] ?? ""),
        fileName: typeof req.headers["x-file-name"] === "string" ? req.headers["x-file-name"] : undefined,
        auditContext: requestAuditContext(req),
      }),
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
});

fieldRoutes.post("/photos/:photoId/tags", requireFieldContractor, async (req, res, next) => {
  try {
    const photoId = String(req.params.photoId);
    const result = await runFieldFileWrite(req, photoId, (db) =>
      replaceFieldPhotoTags(db, {
        userId: req.fieldUser!.id,
        userRole: req.fieldUser!.role,
      }, {
        photoId,
        tags: Array.isArray(req.body.tags) ? req.body.tags.map(String) : [],
      }),
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
});

fieldRoutes.delete("/photos/:photoId/tags/:tag", requireFieldContractor, async (req, res, next) => {
  try {
    const photoId = String(req.params.photoId);
    const result = await runFieldFileWrite(req, photoId, (db) =>
      deleteFieldPhotoTag(db, {
        userId: req.fieldUser!.id,
        userRole: req.fieldUser!.role,
      }, {
        photoId,
        tag: decodeURIComponent(String(req.params.tag)),
      }),
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
});

fieldRoutes.get("/projects/:dealId/tags", requireFieldContractor, async (req, res, next) => {
  try {
    const access = { userId: req.fieldUser!.id, userRole: req.fieldUser!.role };
    const projectId = String(req.params.dealId);
    const { value, office } = await withResolvedOffice(
      "deal",
      projectId,
      (officeDb) =>
        searchFieldProjectTags(officeDb, access, {
          projectId,
          query: typeof req.query.q === "string" ? req.query.q : undefined,
          limit: req.query.limit ? parseOptionalPositiveInt(req.query.limit) : undefined,
        }),
      "Project not found",
    );
    res.json({ ...value, ...officeTag(office) });
  } catch (err) {
    next(err);
  }
});

fieldRoutes.get("/projects/:dealId/reports", requireFieldContractor, async (req, res, next) => {
  try {
    const access = { userId: req.fieldUser!.id, userRole: req.fieldUser!.role };
    const dealId = String(req.params.dealId);
    const { value, office } = await withResolvedOffice(
      "deal",
      dealId,
      (officeDb) => listFieldProjectReports(officeDb, access, dealId),
      "Project not found",
    );
    res.json({ ...value, ...officeTag(office) });
  } catch (err) {
    next(err);
  }
});

fieldRoutes.get("/reports/:reportId/download", requireFieldContractor, async (req, res, next) => {
  try {
    const access = { userId: req.fieldUser!.id, userRole: req.fieldUser!.role };
    const reportId = String(req.params.reportId);
    const { value, office } = await withResolvedOffice(
      "file",
      reportId,
      (officeDb) => getFieldProjectReportDownload(officeDb, access, reportId),
      "Report not found",
    );
    res.json({ ...value, ...officeTag(office) });
  } catch (err) {
    next(err);
  }
});

fieldRoutes.post("/reports/preview", requireFieldContractor, async (req, res, next) => {
  try {
    const projectId = String(req.body.projectId);
    const result = await runFieldDealWrite(req, { dealId: projectId }, (db) =>
      previewFieldPhotoReport(db, {
        userId: req.fieldUser!.id,
        userRole: req.fieldUser!.role,
      }, {
        projectId,
        photoIds: Array.isArray(req.body.photoIds) ? req.body.photoIds.map(String) : [],
        groupBy: req.body.groupBy === "tag" || req.body.groupBy === "date" ? req.body.groupBy : "none",
        creatorName: [req.fieldUser!.firstName, req.fieldUser!.lastName].filter(Boolean).join(" ") || req.fieldUser!.email,
      }),
      "Project not found",
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
});

fieldRoutes.post("/reports/generate", requireFieldContractor, async (req, res, next) => {
  try {
    const projectId = String(req.body.projectId);
    const result = await runFieldDealWrite(req, { dealId: projectId }, (db, office) =>
      generateFieldPhotoReport(db, {
        userId: req.fieldUser!.id,
        userRole: req.fieldUser!.role,
      }, {
        officeSlug: office.slug,
        projectId,
      reportTitle: String(req.body.reportTitle ?? ""),
      coverData: {
        creatorName: String(req.body.coverData?.creatorName ?? ""),
        companyName: req.body.coverData?.companyName ?? null,
        reportDateLabel: req.body.coverData?.reportDateLabel ?? null,
        projectName: req.body.coverData?.projectName ?? null,
      },
      sections: Array.isArray(req.body.sections)
        ? req.body.sections.map((section: any) => ({
            title: String(section?.title ?? ""),
            photoIds: Array.isArray(section?.photoIds) ? section.photoIds.map(String) : [],
            photoOverrides: Array.isArray(section?.photoOverrides)
              ? section.photoOverrides.map((entry: any) => ({
                  id: String(entry?.id),
                  description: entry?.description == null ? null : String(entry.description),
                }))
              : [],
          }))
        : [],
      }),
      "Project not found",
    );
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// The capture-target picker feeds the photo-ATTACH (write) flow. It goes cross-office IN LOCKSTEP with
// the writes (gated on the same flag): flag-on surfaces every active office's targets (so a user can
// attach to a project in any office the now-cross-office write path can reach); flag-off stays single
// office (uploader's), so it never surfaces a target the single-office upload can't write to.
fieldRoutes.get("/photo-targets/search", requireFieldContractor, async (req, res, next) => {
  try {
    const access = { userId: req.fieldUser!.id, userRole: req.fieldUser!.role };
    const search = req.query.search as string | undefined;
    const limit = parseOptionalPositiveInt(req.query.limit);

    if (!isFieldCrossOfficeWritesEnabled()) {
      const office = await getFieldOfficeById(req.fieldUser!.tenantId);
      const result = await runInOffice(office, (db) => searchFieldCaptureTargets(db, access, { search, limit }));
      res.json(result);
      return;
    }

    const globalLimit = limit ?? FIELD_CAPTURE_TARGET_DEFAULT_LIMIT;
    const { results, failures } = assertFanOutNotFullyDegraded(
      await fanOutActiveOffices((db) => searchFieldCaptureTargets(db, access, { search, limit: globalLimit })),
    );
    const targets = mergeFieldCaptureTargets(
      results.map(({ office, value }) => ({ office, targets: value.targets })),
      globalLimit,
    );
    res.json({ targets, degradedOffices: failures.map((failure) => failure.office.slug) });
  } catch (err) {
    next(err);
  }
});

fieldRoutes.get("/photo-targets/validate", requireFieldContractor, async (req, res, next) => {
  try {
    const access = { userId: req.fieldUser!.id, userRole: req.fieldUser!.role };
    const target = {
      dealId: typeof req.query.dealId === "string" ? req.query.dealId : undefined,
      leadId: typeof req.query.leadId === "string" ? req.query.leadId : undefined,
      opportunityId: typeof req.query.opportunityId === "string" ? req.query.opportunityId : undefined,
    };
    assertValidCaptureTargetIds(target);
    const office = await resolveFieldWriteOffice(req.fieldUser!.tenantId, target);
    const result = await runInOffice(office, (db) =>
      assertAccessibleFieldCaptureTarget(db, { ...access, ...target }),
    );
    // Stamp the owning office only when cross-office writes are on — keeps the flag-off payload contract
    // byte-for-byte identical to today's single-office response (`{ target }`).
    res.json(isFieldCrossOfficeWritesEnabled() ? { target: result, ...officeTag(office) } : { target: result });
  } catch (err) {
    next(err);
  }
});

fieldRoutes.get("/projects/:dealId/photos", requireFieldContractor, async (req, res, next) => {
  try {
    const access = { userId: req.fieldUser!.id, userRole: req.fieldUser!.role };
    const dealId = String(req.params.dealId);
    const categories = typeof req.query.category === "string" && req.query.category.length > 0
      ? req.query.category.split(",")
      : undefined;
    const uploaderIds = typeof req.query.uploader === "string" && req.query.uploader.length > 0
      ? req.query.uploader.split(",")
      : undefined;
    const { value, office } = await withResolvedOffice(
      "deal",
      dealId,
      (officeDb) =>
        listFieldProjectPhotos(officeDb, access, dealId, {
          categories,
          uploaderIds,
          from: req.query.from as string | undefined,
          to: req.query.to as string | undefined,
          includeDeleted: false,
        }),
      "Project not found",
    );
    res.json({ ...value, ...officeTag(office) });
  } catch (err) {
    next(err);
  }
});
