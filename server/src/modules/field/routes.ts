import { Router } from "express";
import { requireFieldContractor } from "../../middleware/field-auth.js";
import { tenantMiddleware } from "../../middleware/tenant.js";
import { toFieldUserResponse } from "../field-users/service.js";
import {
  confirmFieldPhotoUpload,
  requestFieldPhotoUploadUrl,
} from "./photos-service.js";
import {
  listFieldProjects,
  listFieldProjectPhotos,
  listStarredFieldProjects,
  starFieldProject,
  unstarFieldProject,
} from "./projects-service.js";

export const fieldRoutes = Router();

function requestAuditContext(req: any) {
  const userAgentHeader = req.headers?.["user-agent"];
  return {
    ipAddress: req.ip ?? null,
    userAgent: Array.isArray(userAgentHeader) ? userAgentHeader.join(", ") : userAgentHeader ?? null,
  };
}

fieldRoutes.get("/me", requireFieldContractor, (req, res) => {
  res.json({
    user: toFieldUserResponse(req.fieldUser!),
  });
});

const fieldProjectMiddleware = [requireFieldContractor, tenantMiddleware] as const;

fieldRoutes.get("/projects", ...fieldProjectMiddleware, async (req, res, next) => {
  try {
    const result = await listFieldProjects(req.tenantDb!, req.fieldUser!.id, {
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
    const result = await listStarredFieldProjects(req.tenantDb!, req.fieldUser!.id);
    await req.commitTransaction();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

fieldRoutes.post("/projects/:dealId/star", ...fieldProjectMiddleware, async (req, res, next) => {
  try {
    const result = await starFieldProject(req.tenantDb!, req.fieldUser!.id, String(req.params.dealId));
    await req.commitTransaction();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

fieldRoutes.delete("/projects/:dealId/star", ...fieldProjectMiddleware, async (req, res, next) => {
  try {
    const result = await unstarFieldProject(req.tenantDb!, req.fieldUser!.id, String(req.params.dealId));
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
      dealId: String(req.body.dealId),
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
      officeId: req.fieldUser!.tenantId,
      dealId: String(req.body.dealId),
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

fieldRoutes.get("/projects/:dealId/photos", ...fieldProjectMiddleware, async (req, res, next) => {
  try {
    const categories = typeof req.query.category === "string" && req.query.category.length > 0
      ? req.query.category.split(",")
      : undefined;
    const uploaderIds = typeof req.query.uploader === "string" && req.query.uploader.length > 0
      ? req.query.uploader.split(",")
      : undefined;
    const result = await listFieldProjectPhotos(req.tenantDb!, String(req.params.dealId), {
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
