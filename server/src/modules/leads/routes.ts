import { Router } from "express";
import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { PoolClient } from "pg";
import * as schema from "@trock-crm/shared/schema";
import { leadSubscriptions } from "@trock-crm/shared/schema";
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
import { resolveCreateOfficeCode } from "../deals/create-context.js";
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
import { getAllStages } from "../pipeline/service.js";
import { buildAuditActorFromUser, logActivity } from "../audit/audit-logger.js";
import {
  assertLeadCollaboratorAccess,
  assertLeadOwnerAccess,
  getCollaborativeReadRole,
  normalizeCollaborativeScope,
} from "../../lib/collaboration-access.js";

const router = Router();

async function isLeadWatchedByUser(tenantDb: any, leadId: string, userId: string) {
  const [row] = await tenantDb
    .select({ id: leadSubscriptions.id })
    .from(leadSubscriptions)
    .where(
      and(
        eq(leadSubscriptions.leadId, leadId),
        eq(leadSubscriptions.userId, userId),
        isNull(leadSubscriptions.deletedAt)
      )
    )
    .limit(1);

  return Boolean(row);
}

function buildRouteAuditContext(req: { user?: any; headers: Record<string, unknown>; ip?: string | undefined }) {
  const actor = buildAuditActorFromUser({
    userId: req.user!.id,
    name: req.user!.displayName ?? req.user!.email ?? req.user!.id,
    role: req.user!.role,
  });
  const userAgentHeader = (req as { headers?: Record<string, unknown> }).headers?.["user-agent"];
  return {
    actor,
    ipAddress: req.ip ?? null,
    userAgent:
      Array.isArray(userAgentHeader)
        ? userAgentHeader.join(", ")
        : typeof userAgentHeader === "string"
          ? userAgentHeader
          : null,
  };
}

async function dispatchDueDiligenceEmailAfterCommit(input: {
  officeSlug: string;
  approvalId: string;
}) {
  let client: PoolClient | null = null;
  let committed = false;
  try {
    client = await pool.connect();
    assertSafeOfficeSlug(input.officeSlug);
    const schemaName = `office_${input.officeSlug}`;
    await client.query("BEGIN");
    await client.query("SELECT set_config('search_path', $1, true)", [`${schemaName},public`]);
    const tenantDb = drizzle(client, { schema });
    await dispatchPendingDueDiligenceEmail(tenantDb, input.approvalId, { now: new Date() });
    await client.query("COMMIT");
    committed = true;
  } catch (err) {
    if (client && !committed) {
      await client.query("ROLLBACK").catch(() => {});
    }
    console.error("[lead-dd] post-commit email dispatch failed", {
      approvalId: input.approvalId,
      err,
    });
  } finally {
    client?.release();
  }
}

function readBoardInput(req: Parameters<typeof router.get>[1] extends never ? never : any) {
  const scope = normalizeCollaborativeScope(
    req.user!.role,
    req.query.scope as "mine" | "team" | "all" | undefined
  );
  return {
    role: getCollaborativeReadRole(req.user!.role, scope),
    userId: req.user!.id,
    activeOfficeId: req.user!.activeOfficeId ?? req.user!.officeId,
    scope,
    assignedRepId: req.query.assignedRepId as string | undefined,
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

function readListScope(value: unknown): "mine" | "team" | "all" {
  return value === "mine" || value === "team" || value === "all" ? value : "all";
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
        scope: normalizeCollaborativeScope(req.user!.role, readListScope(req.query.scope)),
        activeOfficeId: req.user!.activeOfficeId ?? req.user!.officeId,
        status: req.query.status as "open" | "converted" | "disqualified" | undefined,
        isActive:
          req.query.isActive === "all"
            ? "all"
            : req.query.isActive === "false"
              ? false
              : true,
      },
      getCollaborativeReadRole(req.user!.role, normalizeCollaborativeScope(req.user!.role, readListScope(req.query.scope))),
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

router.get("/stages", async (req, res, next) => {
  try {
    const stages = await getAllStages("lead");
    await req.commitTransaction!();
    res.json({ stages });
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
    const access = await assertLeadCollaboratorAccess(req.tenantDb!, req.params.id, req.user!);
    const lead = await getLeadById(
      req.tenantDb!,
      req.params.id,
      getCollaborativeReadRole(req.user!.role, access.assignedRepId === req.user!.id ? "mine" : "all"),
      req.user!.id
    );
    if (!lead) {
      throw new AppError(404, "Lead not found");
    }
    const isWatching = await isLeadWatchedByUser(req.tenantDb!, req.params.id, req.user!.id);

    if (!isLeadEditV2Enabled()) {
      await req.commitTransaction!();
      res.json({ lead: { ...lead, isWatching } });
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
        isWatching,
        leadQuestionnaire: questionnaire,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.post("/:id/watch", async (req, res, next) => {
  try {
    await assertLeadCollaboratorAccess(req.tenantDb!, req.params.id, req.user!);
    await req.tenantDb!
      .insert(leadSubscriptions)
      .values({
        leadId: req.params.id,
        userId: req.user!.id,
        createdAt: new Date(),
        deletedAt: null,
      })
      .onConflictDoUpdate({
        target: [leadSubscriptions.leadId, leadSubscriptions.userId],
        set: {
          deletedAt: null,
        },
      });
    await req.commitTransaction!();
    res.status(200).json({ watching: true });
  } catch (err) {
    next(err);
  }
});

router.delete("/:id/watch", async (req, res, next) => {
  try {
    await assertLeadCollaboratorAccess(req.tenantDb!, req.params.id, req.user!);
    await req.tenantDb!
      .update(leadSubscriptions)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(leadSubscriptions.leadId, req.params.id),
          eq(leadSubscriptions.userId, req.user!.id),
          isNull(leadSubscriptions.deletedAt)
        )
      );
    await req.commitTransaction!();
    res.status(200).json({ watching: false });
  } catch (err) {
    next(err);
  }
});

// GET /api/leads/:id/qualification
router.get("/:id/qualification", async (req, res, next) => {
  try {
    await assertLeadCollaboratorAccess(req.tenantDb!, req.params.id, req.user!);
    const lead = await getLeadById(
      req.tenantDb!,
      req.params.id,
      getCollaborativeReadRole(req.user!.role, "all"),
      req.user!.id
    );
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
    await assertLeadCollaboratorAccess(req.tenantDb!, req.params.id, req.user!);
    const lead = await getLeadById(
      req.tenantDb!,
      req.params.id,
      getCollaborativeReadRole(req.user!.role, "all"),
      req.user!.id
    );
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
    await assertLeadOwnerAccess(req.tenantDb!, req.params.id, req.user!, {
      message: "Only the assigned rep can modify this lead",
    });
    const lead = await getLeadById(req.tenantDb!, req.params.id, getCollaborativeReadRole(req.user!.role, "mine"), req.user!.id);
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
    const trimmedName = typeof name === "string" ? name.trim() : "";
    if (!companyId || !propertyId || !trimmedName) {
      throw new AppError(400, "companyId, propertyId, and name are required");
    }

    const repId = req.user!.role === "rep" ? req.user!.id : (assignedRepId || salesRepId || req.user!.id);
    const leadSalesRepId = salesRepId === undefined ? repId : salesRepId;
    const officeCodeResolution = resolveCreateOfficeCode({
      requestedOfficeCode: rest.officeCode,
      officeSlug: req.officeSlug,
      recordType: "lead",
    });
    if ("error" in officeCodeResolution) {
      throw new AppError(400, officeCodeResolution.error);
    }

    const lead = await createLead(req.tenantDb!, {
      companyId,
      propertyId,
      stageId: undefined,
      assignedRepId: repId,
      actorUserId: req.user!.id,
      salesRepId: leadSalesRepId,
      officeId: req.user!.activeOfficeId,
      name: trimmedName,
      bidDueDate,
      ...rest,
      officeCode: officeCodeResolution.officeCode,
      auditContext: buildRouteAuditContext(req),
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
    await assertLeadOwnerAccess(req.tenantDb!, req.params.id, req.user!, {
      message: "Only the assigned rep can modify this lead",
    });
    const result = await transitionLeadStage(req.tenantDb!, {
      leadId: req.params.id,
      targetStageId: req.body.targetStageId,
      userId: req.user!.id,
      userRole: req.user!.role,
      officeId: req.user!.activeOfficeId,
      inlinePatch: req.body.inlinePatch,
      auditContext: buildRouteAuditContext(req),
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
    const patchKeys = Object.keys(body);
    const isAssignmentTransferOnly = patchKeys.length > 0 && patchKeys.every((field) => field === "assignedRepId" || field === "salesRepId");
    if (isAssignmentTransferOnly) {
      const access = await assertLeadCollaboratorAccess(req.tenantDb!, req.params.id, req.user!);
      if (req.user!.role !== "admin" && access.assignedRepId !== req.user!.id) {
        throw new AppError(403, "Only the assigned rep or an admin can transfer this lead");
      }
    } else {
      await assertLeadOwnerAccess(req.tenantDb!, req.params.id, req.user!, {
        message: "Only the assigned rep can modify this lead",
      });
    }
    if (body.stageId !== undefined) {
      const existing = await getLeadById(req.tenantDb!, req.params.id, getCollaborativeReadRole(req.user!.role, "mine"), req.user!.id);
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

    if (body.name !== undefined) {
      const trimmedName = typeof body.name === "string" ? body.name.trim() : "";
      if (!trimmedName) {
        throw new AppError(400, "Lead name is required");
      }
      body.name = trimmedName;
    }

    const lead = await updateLead(
      req.tenantDb!,
      req.params.id,
      { ...body, officeId: req.user!.activeOfficeId, auditContext: buildRouteAuditContext(req) },
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
    await assertLeadOwnerAccess(req.tenantDb!, req.params.id, req.user!, {
      message: "Only the assigned rep can modify this lead",
    });
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
      auditContext: buildRouteAuditContext(req),
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

// DELETE /api/leads/:id — owner/admin soft-delete
router.delete("/:id", async (req, res, next) => {
  try {
    const leadId = req.params.id as string;
    await assertLeadOwnerAccess(req.tenantDb!, leadId, req.user!, {
      allowAdmin: true,
      message: "Only the assigned rep or an admin can delete this lead",
    });
    const lead = await deleteLead(req.tenantDb!, leadId, "admin", req.user!.id);
    if (lead) {
      const auditContext = buildRouteAuditContext(req);
      await logActivity({
        tenantDb: req.tenantDb!,
        actor: auditContext.actor,
        action: "soft_delete",
        entity: {
          tableName: "leads",
          entityType: "lead",
          recordId: leadId,
          nameSnapshot: lead.name,
          secondaryIdSnapshot: null,
        },
        fieldChanges: {
          isActive: { from: true, to: false },
        },
        ipAddress: auditContext.ipAddress ?? null,
        userAgent: auditContext.userAgent ?? null,
      });
    }
    await req.commitTransaction!();
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export const leadRoutes = router;
