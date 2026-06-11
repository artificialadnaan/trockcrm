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
  searchFieldCaptureTargets,
  starFieldProject,
  unstarFieldProject,
  type FieldProject,
} from "./projects-service.js";
import {
  fanOutActiveOffices,
  officeTag,
  withResolvedOffice,
} from "./cross-office.js";

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
    const { results, failures } = await fanOutActiveOffices((officeDb) =>
      listFieldProjects(officeDb, access, {
        search: req.query.search as string | undefined,
        status,
        page: 1,
        perPage: fetchPerPage,
      }),
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
    const { results, failures } = await fanOutActiveOffices((officeDb) =>
      listStarredFieldProjects(officeDb, access),
    );
    const projects = results
      .flatMap(({ office, value }) => value.projects.map((project: FieldProject) => ({ ...project, ...officeTag(office) })))
      .sort((a, b) => (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? ""));
    res.json({ projects, degradedOffices: failures.map((failure) => failure.office.slug) });
  } catch (err) {
    next(err);
  }
});

fieldRoutes.post("/projects/:dealId/star", ...fieldProjectMiddleware, async (req, res, next) => {
  try {
    const result = await starFieldProject(req.tenantDb!, {
      userId: req.fieldUser!.id,
      userRole: req.fieldUser!.role,
    }, String(req.params.dealId));
    await req.commitTransaction();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

fieldRoutes.delete("/projects/:dealId/star", ...fieldProjectMiddleware, async (req, res, next) => {
  try {
    const result = await unstarFieldProject(req.tenantDb!, {
      userId: req.fieldUser!.id,
      userRole: req.fieldUser!.role,
    }, String(req.params.dealId));
    await req.commitTransaction();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

fieldRoutes.post("/photos/upload-url", ...fieldProjectMiddleware, async (req, res, next) => {
  try {
    const result = await requestFieldPhotoUploadUrl(req.tenantDb!, {
      officeSlug: req.officeSlug!,
      userId: req.fieldUser!.id,
      userRole: req.fieldUser!.role,
      dealId: typeof req.body.dealId === "string" ? req.body.dealId : undefined,
      leadId: typeof req.body.leadId === "string" ? req.body.leadId : undefined,
      opportunityId: typeof req.body.opportunityId === "string" ? req.body.opportunityId : undefined,
      contentType: String(req.body.contentType),
      sizeBytes: Number(req.body.sizeBytes),
      photoCategory: req.body.category ?? req.body.photoCategory ?? null,
      caption: req.body.caption ?? null,
      tags: Array.isArray(req.body.tags) ? req.body.tags.map(String) : [],
    });
    await req.commitTransaction();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

fieldRoutes.post("/photos/confirm-upload", ...fieldProjectMiddleware, async (req, res, next) => {
  try {
    const result = await confirmFieldPhotoUpload(req.tenantDb!, {
      userId: req.fieldUser!.id,
      userRole: req.fieldUser!.role,
      officeId: req.fieldUser!.tenantId,
      dealId: typeof req.body.dealId === "string" ? req.body.dealId : undefined,
      leadId: typeof req.body.leadId === "string" ? req.body.leadId : undefined,
      opportunityId: typeof req.body.opportunityId === "string" ? req.body.opportunityId : undefined,
      uploadToken: String(req.body.uploadToken),
      objectKey: String(req.body.objectKey),
      latitude: req.body.latitude !== undefined ? Number(req.body.latitude) : undefined,
      longitude: req.body.longitude !== undefined ? Number(req.body.longitude) : undefined,
      addressSource: req.body.addressSource,
      takenAt: req.body.takenAt,
      auditContext: requestAuditContext(req),
    });
    await req.commitTransaction();
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

fieldRoutes.post("/photos/:photoId/assign-target", ...fieldProjectMiddleware, async (req, res, next) => {
  try {
    const result = await assignPendingFieldPhotoTarget(req.tenantDb!, {
      userId: req.fieldUser!.id,
      userRole: req.fieldUser!.role,
    }, {
      photoId: String(req.params.photoId),
      dealId: typeof req.body.dealId === "string" ? req.body.dealId : undefined,
      leadId: typeof req.body.leadId === "string" ? req.body.leadId : undefined,
      opportunityId: typeof req.body.opportunityId === "string" ? req.body.opportunityId : undefined,
    });
    await req.commitTransaction();
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

fieldRoutes.post("/photos/:photoId/transcribe-description", ...fieldProjectMiddleware, rawAudioBody(), async (req, res, next) => {
  try {
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const result = await transcribeAndPersistFieldPhotoDescription(req.tenantDb!, {
      userId: req.fieldUser!.id,
      userRole: req.fieldUser!.role,
    }, {
      photoId: String(req.params.photoId),
      audio: body,
      mimeType: String(req.headers["content-type"] ?? ""),
      fileName: typeof req.headers["x-file-name"] === "string" ? req.headers["x-file-name"] : undefined,
      auditContext: requestAuditContext(req),
    });
    await req.commitTransaction();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

fieldRoutes.post("/photos/:photoId/tags", ...fieldProjectMiddleware, async (req, res, next) => {
  try {
    const result = await replaceFieldPhotoTags(req.tenantDb!, {
      userId: req.fieldUser!.id,
      userRole: req.fieldUser!.role,
    }, {
      photoId: String(req.params.photoId),
      tags: Array.isArray(req.body.tags) ? req.body.tags.map(String) : [],
    });
    await req.commitTransaction();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

fieldRoutes.delete("/photos/:photoId/tags/:tag", ...fieldProjectMiddleware, async (req, res, next) => {
  try {
    const result = await deleteFieldPhotoTag(req.tenantDb!, {
      userId: req.fieldUser!.id,
      userRole: req.fieldUser!.role,
    }, {
      photoId: String(req.params.photoId),
      tag: decodeURIComponent(String(req.params.tag)),
    });
    await req.commitTransaction();
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

fieldRoutes.post("/reports/preview", ...fieldProjectMiddleware, async (req, res, next) => {
  try {
    const result = await previewFieldPhotoReport(req.tenantDb!, {
      userId: req.fieldUser!.id,
      userRole: req.fieldUser!.role,
    }, {
      projectId: String(req.body.projectId),
      photoIds: Array.isArray(req.body.photoIds) ? req.body.photoIds.map(String) : [],
      groupBy: req.body.groupBy === "tag" || req.body.groupBy === "date" ? req.body.groupBy : "none",
      creatorName: [req.fieldUser!.firstName, req.fieldUser!.lastName].filter(Boolean).join(" ") || req.fieldUser!.email,
    });
    await req.commitTransaction();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

fieldRoutes.post("/reports/generate", ...fieldProjectMiddleware, async (req, res, next) => {
  try {
    const result = await generateFieldPhotoReport(req.tenantDb!, {
      userId: req.fieldUser!.id,
      userRole: req.fieldUser!.role,
    }, {
      officeSlug: req.officeSlug!,
      projectId: String(req.body.projectId),
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
    });
    await req.commitTransaction();
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// NOTE: the capture-target picker (/photo-targets/search + /validate) stays SINGLE-office in Phase 2a.
// It feeds the photo-ATTACH (write) flow, which is still single-office — surfacing cross-office targets
// the upload can't yet write to would be a broken UX. These move to cross-office in the Phase 2b writes
// PR, together with the deal→office resolver that re-binds the write to the target's office.
fieldRoutes.get("/photo-targets/search", ...fieldProjectMiddleware, async (req, res, next) => {
  try {
    const result = await searchFieldCaptureTargets(req.tenantDb!, {
      userId: req.fieldUser!.id,
      userRole: req.fieldUser!.role,
    }, {
      search: req.query.search as string | undefined,
      limit: parseOptionalPositiveInt(req.query.limit),
    });
    await req.commitTransaction();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

fieldRoutes.get("/photo-targets/validate", ...fieldProjectMiddleware, async (req, res, next) => {
  try {
    const result = await assertAccessibleFieldCaptureTarget(req.tenantDb!, {
      userId: req.fieldUser!.id,
      userRole: req.fieldUser!.role,
      dealId: typeof req.query.dealId === "string" ? req.query.dealId : undefined,
      leadId: typeof req.query.leadId === "string" ? req.query.leadId : undefined,
      opportunityId: typeof req.query.opportunityId === "string" ? req.query.opportunityId : undefined,
    });
    await req.commitTransaction();
    res.json({ target: result });
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
