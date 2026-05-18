import express, { Router } from "express";
import { requireFieldContractor } from "../../middleware/field-auth.js";
import { AppError } from "../../middleware/error-handler.js";
import { tenantMiddleware } from "../../middleware/tenant.js";
import { toFieldUserResponse } from "../field-users/service.js";
import {
  confirmFieldPhotoUpload,
  requestFieldPhotoUploadUrl,
} from "./photos-service.js";
import {
  transcribeAndPersistFieldPhotoDescription,
  transcribePhotoDescriptionAudio,
} from "./photo-transcription-service.js";
import {
  deleteFieldPhotoTag,
  replaceFieldPhotoTags,
  searchFieldProjectTags,
} from "./photo-tags-service.js";
import {
  assertAccessibleFieldCaptureTarget,
  listFieldProjects,
  listFieldProjectPhotos,
  listStarredFieldProjects,
  searchFieldCaptureTargets,
  starFieldProject,
  unstarFieldProject,
} from "./projects-service.js";

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

fieldRoutes.get("/projects", ...fieldProjectMiddleware, async (req, res, next) => {
  try {
    const result = await listFieldProjects(req.tenantDb!, {
      userId: req.fieldUser!.id,
      userRole: req.fieldUser!.role,
    }, {
      search: req.query.search as string | undefined,
      status: req.query.status as string | undefined,
      page: req.query.page ? parseInt(req.query.page as string, 10) : undefined,
      perPage: req.query.perPage ? parseInt(req.query.perPage as string, 10) : undefined,
    });
    await req.commitTransaction();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

fieldRoutes.get("/projects/starred", ...fieldProjectMiddleware, async (req, res, next) => {
  try {
    const result = await listStarredFieldProjects(req.tenantDb!, {
      userId: req.fieldUser!.id,
      userRole: req.fieldUser!.role,
    });
    await req.commitTransaction();
    res.json(result);
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

fieldRoutes.get("/projects/:dealId/tags", ...fieldProjectMiddleware, async (req, res, next) => {
  try {
    const result = await searchFieldProjectTags(req.tenantDb!, {
      userId: req.fieldUser!.id,
      userRole: req.fieldUser!.role,
    }, {
      projectId: String(req.params.dealId),
      query: typeof req.query.q === "string" ? req.query.q : undefined,
      limit: req.query.limit ? parseOptionalPositiveInt(req.query.limit) : undefined,
    });
    await req.commitTransaction();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

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

fieldRoutes.get("/projects/:dealId/photos", ...fieldProjectMiddleware, async (req, res, next) => {
  try {
    const categories = typeof req.query.category === "string" && req.query.category.length > 0
      ? req.query.category.split(",")
      : undefined;
    const uploaderIds = typeof req.query.uploader === "string" && req.query.uploader.length > 0
      ? req.query.uploader.split(",")
      : undefined;
    const result = await listFieldProjectPhotos(req.tenantDb!, {
      userId: req.fieldUser!.id,
      userRole: req.fieldUser!.role,
    }, String(req.params.dealId), {
      categories,
      uploaderIds,
      from: req.query.from as string | undefined,
      to: req.query.to as string | undefined,
      includeDeleted: false,
    });
    await req.commitTransaction();
    res.json(result);
  } catch (err) {
    next(err);
  }
});
