import { Router } from "express";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@trock-crm/shared/schema";
import { pool } from "../../db.js";
import { AppError } from "../../middleware/error-handler.js";
import { requireAdmin } from "../../middleware/rbac.js";
import { LeadStageTransitionError } from "./stage-transition-service.js";
import {
  createLead,
  deleteLead,
  getLeadById,
  LeadCreateRequirementsError,
  listLeadBoard,
  listLeadStagePage,
  listLeads,
  transitionLeadStage,
  updateLead,
} from "./service.js";
import { convertLead } from "./conversion-service.js";
import { preflightLeadStageCheck } from "./stage-gate.js";
import { getLeadQualificationByLeadId } from "./qualification-service.js";
import { getLeadScopingSnapshot, upsertLeadScopingIntake } from "./scoping-service.js";
import {
  getLeadQuestionnaireSnapshot,
  getQuestionnaireTemplateSnapshot,
  isLeadEditV2Enabled,
} from "./questionnaire-service.js";
import {
  assertSafeOfficeSlug,
  dispatchPendingDueDiligenceEmail,
  getLeadDueDiligenceApprovalForLead,
} from "./due-diligence-service.js";

const router = Router();

async function dispatchDueDiligenceEmailAfterCommit(input: {
  officeSlug: string;
  approvalId: string;
}) {
  const client = await pool.connect();
  let committed = false;
  try {
    assertSafeOfficeSlug(input.officeSlug);
    const schemaName = `office_${input.officeSlug}`;
    await client.query("BEGIN");
    await client.query("SELECT set_config('search_path', $1, true)", [`${schemaName},public`]);
    const tenantDb = drizzle(client, { schema });
    await dispatchPendingDueDiligenceEmail(tenantDb, input.approvalId, { now: new Date() });
    await client.query("COMMIT");
    committed = true;
  } catch (err) {
    if (!committed) {
      await client.query("ROLLBACK").catch(() => {});
    }
    console.error("[lead-dd] post-commit email dispatch failed", {
      approvalId: input.approvalId,
      err,
    });
  } finally {
    client.release();
  }
}

function readBoardInput(req: Parameters<typeof router.get>[1] extends never ? never : any) {
  return {
    role: req.user!.role,
    userId: req.user!.id,
    activeOfficeId: req.user!.activeOfficeId ?? req.user!.officeId,
    scope: (req.query.scope as "mine" | "team" | "all" | undefined) ?? "mine",
    previewLimit: req.query.previewLimit ? Number(req.query.previewLimit) : undefined,
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

router.get("/questionnaire-template", async (req, res, next) => {
  try {
    if (!isLeadEditV2Enabled()) {
      await req.commitTransaction!();
      res.json({ enabled: false, questionnaire: null });
      return;
    }

    const projectTypeId =
      typeof req.query.projectTypeId === "string" && req.query.projectTypeId.trim().length > 0
        ? req.query.projectTypeId
        : null;
    const questionnaire = await getQuestionnaireTemplateSnapshot(req.tenantDb!, projectTypeId);
    await req.commitTransaction!();
    res.json({ enabled: true, questionnaire });
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

    if (!isLeadEditV2Enabled()) {
      await req.commitTransaction!();
      res.json({ lead });
      return;
    }

    const questionnaire = await getLeadQuestionnaireSnapshot(req.tenantDb!, {
      leadId: lead.id,
      projectTypeId: lead.projectTypeId ?? null,
    });
    await req.commitTransaction!();
    res.json({
      lead: {
        ...lead,
        leadQuestionnaire: questionnaire,
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/leads/:id/qualification
router.get("/:id/qualification", async (req, res, next) => {
  try {
    const lead = await getLeadById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!lead) {
      throw new AppError(404, "Lead not found");
    }

    const qualification = await getLeadQualificationByLeadId(req.tenantDb!, req.params.id);
    await req.commitTransaction!();
    res.json({ qualification });
  } catch (err) {
    next(err);
  }
});

// GET /api/leads/:id/scoping
router.get("/:id/scoping", async (req, res, next) => {
  try {
    const lead = await getLeadById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!lead) {
      throw new AppError(404, "Lead not found");
    }

    const snapshot = await getLeadScopingSnapshot(req.tenantDb!, req.params.id);
    await req.commitTransaction!();
    res.json(snapshot);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/leads/:id/scoping
router.patch("/:id/scoping", async (req, res, next) => {
  try {
    const lead = await getLeadById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    if (!lead) {
      throw new AppError(404, "Lead not found");
    }

    const sectionData =
      req.body?.sectionData &&
      typeof req.body.sectionData === "object" &&
      !Array.isArray(req.body.sectionData)
        ? req.body.sectionData
        : {};

    const snapshot = await upsertLeadScopingIntake(req.tenantDb!, {
      leadId: req.params.id,
      officeId: req.user!.activeOfficeId ?? req.user!.officeId,
      userId: req.user!.id,
      sectionData,
    });

    await req.commitTransaction!();
    res.json(snapshot);
  } catch (err) {
    next(err);
  }
});

// POST /api/leads
router.post("/", async (req, res, next) => {
  try {
    const { companyId, propertyId, assignedRepId, salesRepId, name, bidDueDate, ...rest } = req.body;
    if (!companyId || !propertyId || !name) {
      throw new AppError(400, "companyId, propertyId, and name are required");
    }

    const repId = req.user!.role === "rep" ? req.user!.id : (assignedRepId || salesRepId || req.user!.id);
    const leadSalesRepId = salesRepId === undefined ? repId : salesRepId;

    const lead = await createLead(req.tenantDb!, {
      companyId,
      propertyId,
      stageId: undefined,
      assignedRepId: repId,
      actorUserId: req.user!.id,
      salesRepId: leadSalesRepId,
      officeId: req.user!.activeOfficeId,
      name,
      bidDueDate,
      ...rest,
    });
    const dueDiligenceApproval =
      lead.verificationStatus === "pending"
        ? await getLeadDueDiligenceApprovalForLead(req.tenantDb!, lead.id)
        : null;

    await req.commitTransaction!();
    res.status(201).json({ lead });

    if (dueDiligenceApproval && req.officeSlug) {
      setImmediate(() => {
        void dispatchDueDiligenceEmailAfterCommit({
          officeSlug: req.officeSlug!,
          approvalId: dueDiligenceApproval.id,
        });
      });
    }
  } catch (err) {
    if (err instanceof LeadCreateRequirementsError) {
      res.status(400).json({
        error: {
          message: err.message,
          code: err.code,
          missingRequirements: err.missingRequirements,
        },
      });
      return;
    }
    next(err);
  }
});

// POST /api/leads/:id/stage/preflight
router.post("/:id/stage/preflight", async (req, res, next) => {
  try {
    const result = await preflightLeadStageCheck(
      req.tenantDb!,
      req.params.id,
      req.body.targetStageId,
      req.user!.role,
      req.user!.id
    );

    await req.commitTransaction!();
    res.json(result);
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
    if (err instanceof LeadStageTransitionError) {
      res.status(err.statusCode).json({
        error: {
          message: err.message,
          code: err.code,
          missingRequirements: err.result.missingRequirements,
          currentStage: err.result.currentStage,
          targetStage: err.result.targetStage,
        },
      });
      return;
    }
    next(err);
  }
});

// PATCH /api/leads/:id
router.patch("/:id", async (req, res, next) => {
  try {
    const body = { ...req.body };
    if (body.stageId !== undefined) {
      const existing = await getLeadById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
      if (!existing) {
        throw new AppError(404, "Lead not found");
      }
      if (body.stageId !== existing.stageId) {
        res.status(400).json({
          error: "Stage changes must use POST /api/leads/:id/stage-transition. Direct stage updates via PATCH are not supported.",
          code: "STAGE_CHANGE_NOT_ALLOWED_VIA_PATCH",
        });
        return;
      }
      delete body.stageId;
    }

    if (body.salesRepId !== undefined && body.salesRepId !== null && body.assignedRepId === undefined) {
      body.assignedRepId = body.salesRepId;
    }

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
    if (err instanceof LeadStageTransitionError) {
      res.status(err.statusCode).json({
        error: {
          message: err.message,
          code: err.code,
          missingRequirements: err.result.missingRequirements,
          currentStage: err.result.currentStage,
          targetStage: err.result.targetStage,
        },
      });
      return;
    }
    next(err);
  }
});

// POST /api/leads/:id/convert
router.post("/:id/convert", async (req, res, next) => {
  try {
    const body = { ...req.body };
    const {
      dealStageId,
      leadId: _ignoredLeadId,
      userId: _ignoredUserId,
      userRole: _ignoredUserRole,
      officeId: _ignoredOfficeId,
      ...rest
    } = body;
    if (rest.salesRepId !== undefined && rest.salesRepId !== null && rest.assignedRepId === undefined) {
      rest.assignedRepId = rest.salesRepId;
    }
    delete rest.salesRepId;

    if (req.user!.role === "rep" && body.assignedRepId !== undefined) {
      delete rest.assignedRepId;
    }

    const result = await convertLead(req.tenantDb!, {
      ...rest,
      leadId: req.params.id,
      dealStageId,
      userId: req.user!.id,
      userRole: req.user!.role,
      officeId: req.user!.activeOfficeId,
    });

    await req.commitTransaction!();
    res.status(201).json(result);
  } catch (err) {
    if (err instanceof LeadStageTransitionError) {
      res.status(err.statusCode).json({
        error: {
          message: err.message,
          code: err.code,
          missingRequirements: err.result.missingRequirements,
          currentStage: err.result.currentStage,
          targetStage: err.result.targetStage,
        },
      });
      return;
    }
    next(err);
  }
});

// DELETE /api/leads/:id — admin-only soft-delete
router.delete("/:id", requireAdmin, async (req, res, next) => {
  try {
    await deleteLead(req.tenantDb!, req.params.id as string, req.user!.role, req.user!.id);
    await req.commitTransaction!();
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export const leadRoutes = router;
