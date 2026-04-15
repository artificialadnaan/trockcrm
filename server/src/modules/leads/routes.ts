import { Router } from "express";
import { AppError } from "../../middleware/error-handler.js";
import {
  createLead,
  deleteLead,
  getLeadById,
  listLeads,
  updateLead,
} from "./service.js";
import { convertLead } from "./conversion-service.js";

const router = Router();

// GET /api/leads
router.get("/", async (req, res, next) => {
  try {
    const result = await listLeads(
      req.tenantDb!,
      {
        search: req.query.search as string | undefined,
        companyId: req.query.companyId as string | undefined,
        propertyId: req.query.propertyId as string | undefined,
        assignedRepId: req.query.assignedRepId as string | undefined,
        status: req.query.status as "open" | "converted" | "disqualified" | undefined,
        isActive: req.query.isActive === "false" ? false : true,
      },
      req.user!.role,
      req.user!.id
    );
    await req.commitTransaction!();
    res.json({ leads: result });
  } catch (err) {
    next(err);
  }
});

// GET /api/leads/:id
router.get("/:id", async (req, res, next) => {
  try {
    const lead = await getLeadById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!lead) {
      throw new AppError(404, "Lead not found");
    }
    await req.commitTransaction!();
    res.json({ lead });
  } catch (err) {
    next(err);
  }
});

// POST /api/leads
router.post("/", async (req, res, next) => {
  try {
    const { companyId, propertyId, stageId, assignedRepId, name, ...rest } = req.body;
    if (!companyId || !propertyId || !stageId || !name) {
      throw new AppError(400, "companyId, propertyId, stageId, and name are required");
    }

    const repId = req.user!.role === "rep" ? req.user!.id : (assignedRepId || req.user!.id);

    const lead = await createLead(req.tenantDb!, {
      companyId,
      propertyId,
      stageId,
      assignedRepId: repId,
      officeId: req.user!.activeOfficeId,
      name,
      ...rest,
    });

    await req.commitTransaction!();
    res.status(201).json({ lead });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/leads/:id
router.patch("/:id", async (req, res, next) => {
  try {
    const body = { ...req.body };
    if (req.user!.role === "rep" && body.assignedRepId !== undefined) {
      delete body.assignedRepId;
    }

    const lead = await updateLead(
      req.tenantDb!,
      req.params.id,
      { ...body, officeId: req.user!.activeOfficeId },
      req.user!.role,
      req.user!.id
    );

    await req.commitTransaction!();
    res.json({ lead });
  } catch (err) {
    next(err);
  }
});

// POST /api/leads/:id/convert
router.post("/:id/convert", async (req, res, next) => {
  try {
    const { dealStageId, ...rest } = req.body;
    if (!dealStageId) {
      throw new AppError(400, "dealStageId is required");
    }

    const result = await convertLead(req.tenantDb!, {
      leadId: req.params.id,
      dealStageId,
      officeId: req.user!.activeOfficeId,
      ...rest,
    });

    await req.commitTransaction!();
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/leads/:id
router.delete("/:id", async (req, res, next) => {
  try {
    await deleteLead(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    await req.commitTransaction!();
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export const leadRoutes = router;
