import { Router } from "express";
import { AppError } from "../../middleware/error-handler.js";
import {
  createLead,
  deleteLead,
  getLeadById,
  listLeadBoard,
  listLeadStagePage,
  listLeads,
  transitionLeadStage,
  updateLead,
} from "./service.js";
import { convertLead } from "./conversion-service.js";

const router = Router();

function readBoardInput(req: Parameters<typeof router.get>[1] extends never ? never : any) {
  return {
    role: req.user!.role,
    userId: req.user!.id,
    activeOfficeId: req.user!.activeOfficeId ?? req.user!.officeId,
    scope: (req.query.scope as "mine" | "team" | "all" | undefined) ?? "mine",
  };
}

function readStageInput(req: Parameters<typeof router.get>[1] extends never ? never : any) {
  return {
    ...readBoardInput(req),
    stageId: req.params.stageId,
    page: Number(req.query.page ?? 1),
    pageSize: Number(req.query.pageSize ?? 25),
    search: req.query.search as string | undefined,
    sort: req.query.sort as string | undefined,
    assignedRepId: req.query.assignedRepId as string | undefined,
    staleOnly: req.query.staleOnly === "true",
    status: req.query.status as string | undefined,
    workflowRoute: req.query.workflowRoute as string | undefined,
    source: req.query.source as string | undefined,
  };
}

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
        isActive:
          req.query.isActive === "all"
            ? "all"
            : req.query.isActive === "false"
              ? false
              : true,
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

router.get("/board", async (req, res, next) => {
  try {
    const board = await listLeadBoard(req.tenantDb!, readBoardInput(req));
    await req.commitTransaction!();
    res.json(board);
  } catch (err) {
    next(err);
  }
});

router.get("/stages/:stageId", async (req, res, next) => {
  try {
    const stagePage = await listLeadStagePage(req.tenantDb!, readStageInput(req));
    await req.commitTransaction!();
    res.json(stagePage);
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
      actorUserId: req.user!.id,
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

// POST /api/leads/:id/stage-transition
router.post("/:id/stage-transition", async (req, res, next) => {
  try {
    const result = await transitionLeadStage(req.tenantDb!, {
      leadId: req.params.id,
      targetStageId: req.body.targetStageId,
      userId: req.user!.id,
      userRole: req.user!.role,
      officeId: req.user!.activeOfficeId,
      inlinePatch: req.body.inlinePatch,
    });

    await req.commitTransaction!();
    res.status(result.ok ? 200 : 409).json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/leads/:id/convert
router.post("/:id/convert", async (req, res, next) => {
  try {
    const body = { ...req.body };
    const { dealStageId, ...rest } = body;
    if (!dealStageId) {
      throw new AppError(400, "dealStageId is required");
    }

    if (req.user!.role === "rep" && body.assignedRepId !== undefined) {
      delete rest.assignedRepId;
    }

    const result = await convertLead(req.tenantDb!, {
      leadId: req.params.id,
      dealStageId,
      userId: req.user!.id,
      userRole: req.user!.role,
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
