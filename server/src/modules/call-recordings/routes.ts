import { Router } from "express";
import { AppError } from "../../middleware/error-handler.js";
import { getDealById } from "../deals/service.js";
import { getLeadById } from "../leads/service.js";
import { getCompanyById } from "../companies/service.js";
import { getContactById } from "../contacts/service.js";
import {
  confirmUpload,
  createUploadUrl,
  getPlaybackUrl,
  listForEntity,
  softDelete,
  type CallRecordingEntityType,
} from "./service.js";

const router = Router();

function requireAdminRole(role: string) {
  if (role !== "admin") {
    throw new AppError(403, "Only admins can upload or delete call recordings.");
  }
}

async function assertEntityReadable(req: any, entityType: CallRecordingEntityType, entityId: string) {
  if (entityType === "deal") {
    const deal = await getDealById(req.tenantDb!, entityId, req.user!.role, req.user!.id);
    if (!deal) throw new AppError(404, "Deal not found or access denied.");
  } else if (entityType === "lead") {
    const lead = await getLeadById(req.tenantDb!, entityId, req.user!.role, req.user!.id);
    if (!lead) throw new AppError(404, "Lead not found or access denied.");
  } else if (entityType === "company") {
    const company = await getCompanyById(req.tenantDb!, entityId);
    if (!company) throw new AppError(404, "Company not found.");
  } else if (entityType === "contact") {
    const contact = await getContactById(req.tenantDb!, entityId);
    if (!contact) throw new AppError(404, "Contact not found.");
  } else {
    throw new AppError(400, "entityType must be one of deal, lead, company, contact.");
  }
}

router.post("/upload-url", async (req, res, next) => {
  try {
    requireAdminRole(req.user!.role);
    const { entityType, entityId, filename, mimeType, title, notes, callDate } = req.body;
    if (!entityType || !entityId || !filename || !mimeType) {
      throw new AppError(400, "entityType, entityId, filename, and mimeType are required.");
    }

    await assertEntityReadable(req, entityType, entityId);
    const result = await createUploadUrl(req.tenantDb!, {
      tenantId: req.user!.activeOfficeId ?? req.user!.officeId,
      uploadedBy: req.user!.id,
      entityType,
      entityId,
      filename,
      mimeType,
      title,
      notes,
      callDate,
    });

    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/:id/confirm", async (req, res, next) => {
  try {
    requireAdminRole(req.user!.role);
    const { fileSizeBytes, durationSeconds } = req.body;
    const recording = await confirmUpload(req.tenantDb!, req.params.id, {
      fileSizeBytes: Number(fileSizeBytes),
      durationSeconds: durationSeconds == null ? null : Number(durationSeconds),
      userId: req.user!.id,
    });
    await req.commitTransaction!();
    res.json({ recording });
  } catch (err) {
    next(err);
  }
});

router.get("/", async (req, res, next) => {
  try {
    const entityType = req.query.entityType as CallRecordingEntityType | undefined;
    const entityId = req.query.entityId as string | undefined;
    if (!entityType || !entityId) {
      throw new AppError(400, "entityType and entityId are required.");
    }
    await assertEntityReadable(req, entityType, entityId);
    const recordings = await listForEntity(req.tenantDb!, entityType, entityId);
    await req.commitTransaction!();
    res.json({ recordings });
  } catch (err) {
    next(err);
  }
});

router.get("/:id/playback", async (req, res, next) => {
  try {
    const result = await getPlaybackUrl(req.tenantDb!, req.params.id);
    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", async (req, res, next) => {
  try {
    requireAdminRole(req.user!.role);
    await softDelete(req.tenantDb!, req.params.id, req.user!.id, req.user!.role);
    await req.commitTransaction!();
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export const callRecordingRoutes = router;
