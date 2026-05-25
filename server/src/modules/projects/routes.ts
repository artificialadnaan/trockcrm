import { Router, type Request } from "express";
import { requireRole } from "../../middleware/rbac.js";
import { AppError } from "../../middleware/error-handler.js";
import { pool } from "../../db.js";
import { runProjectsBackfill } from "./backfill-service.js";
import {
  getProjectCounts,
  getProjectDetail,
  getProjectDocuments,
  getProjectPhaseHistory,
  getProjectTeam,
  getPortfolioProjectDetail,
  listPortfolioProjectBoard,
  listProjects,
  listProjectsByPhase,
} from "./service.js";

const router = Router();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function readQueryString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readQueryBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

function requireUuid(value: unknown, label: string) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new AppError(400, `${label} must be a valid UUID`);
  }
  return value;
}

function currentSchema(req: Request) {
  if (!req.officeSlug) throw new AppError(500, "Office context not available");
  return `office_${req.officeSlug}`;
}

router.get("/", async (req, res, next) => {
  try {
    const includeInactive = readQueryBoolean(req.query.include_inactive ?? req.query.includeInactive);
    const data = await listProjects(req.tenantClient!, {
      phase: readQueryString(req.query.phase),
      search: readQueryString(req.query.search),
      assignedOwner: readQueryString(req.query.assigned_owner),
      startFrom: readQueryString(req.query.start_from),
      completionTo: readQueryString(req.query.completion_to),
      includeInactive,
      page: Number(req.query.page ?? 1),
      perPage: Number(req.query.perPage ?? req.query.per_page ?? 25),
      sortBy: readQueryString(req.query.sortBy ?? req.query.sort_by),
      sortOrder: readQueryString(req.query.sortOrder ?? req.query.sort_order),
    });
    await req.commitTransaction!();
    res.json(data);
  } catch (error) {
    next(error);
  }
});

router.get("/counts", async (req, res, next) => {
  try {
    const data = await getProjectCounts(req.tenantClient!);
    await req.commitTransaction!();
    res.json(data);
  } catch (error) {
    next(error);
  }
});

router.get("/by-phase", async (req, res, next) => {
  try {
    const includeInactive = readQueryBoolean(req.query.include_inactive ?? req.query.includeInactive);
    const data = await listProjectsByPhase(req.tenantClient!, {
      phase: readQueryString(req.query.phase),
      search: readQueryString(req.query.search),
      assignedOwner: readQueryString(req.query.assigned_owner),
      startFrom: readQueryString(req.query.start_from),
      completionTo: readQueryString(req.query.completion_to),
      includeInactive,
    });
    await req.commitTransaction!();
    res.json(data);
  } catch (error) {
    next(error);
  }
});

router.get("/board", async (req, res, next) => {
  try {
    const data = await listPortfolioProjectBoard(req.tenantClient!);
    await req.commitTransaction!();
    res.json(data);
  } catch (error) {
    next(error);
  }
});

router.post("/backfill", requireRole("admin"), async (req, res, next) => {
  try {
    const schemaName = currentSchema(req);
    const officeSlug = req.officeSlug!;
    // Release the request's tenant transaction before the long-running
    // backfill so its Procore HTTP calls don't keep a connection
    // idle-in-transaction (which Postgres terminates, producing
    // "SAVEPOINT can only be used in transaction blocks" or
    // "current transaction is aborted" on the next query).
    const mirrorAllProjects =
      readQueryString(req.query.mirror_all_projects ?? req.query.mirrorAllProjects) === "true";
    await req.commitTransaction!();
    const data = await runProjectsBackfill(pool, schemaName, officeSlug, { mirrorAllProjects });
    res.json(data);
  } catch (error) {
    next(error);
  }
});

router.get("/legacy/:id", async (req, res, next) => {
  try {
    const projectId = requireUuid(req.params.id, "Project id");
    const project = await getProjectDetail(req.tenantClient!, projectId);
    if (!project) throw new AppError(404, "Project not found");
    const team = await getProjectTeam(req.tenantClient!, projectId);
    const documents = await getProjectDocuments(req.tenantClient!, projectId);
    const phaseHistory = await getProjectPhaseHistory(req.tenantClient!, projectId);
    await req.commitTransaction!();
    res.json({ project, ...team, ...documents, ...phaseHistory });
  } catch (error) {
    next(error);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const projectId = requireUuid(req.params.id, "Project id");
    const project = await getPortfolioProjectDetail(req.tenantClient!, projectId);
    if (!project) throw new AppError(404, "Project not found");
    await req.commitTransaction!();
    res.json({ project });
  } catch (error) {
    next(error);
  }
});

router.get("/:id/team", async (req, res, next) => {
  try {
    const data = await getProjectTeam(req.tenantClient!, requireUuid(req.params.id, "Project id"));
    await req.commitTransaction!();
    res.json(data);
  } catch (error) {
    next(error);
  }
});

router.get("/:id/documents", async (req, res, next) => {
  try {
    const data = await getProjectDocuments(req.tenantClient!, requireUuid(req.params.id, "Project id"));
    await req.commitTransaction!();
    res.json(data);
  } catch (error) {
    next(error);
  }
});

router.get("/:id/phase-history", async (req, res, next) => {
  try {
    const data = await getProjectPhaseHistory(req.tenantClient!, requireUuid(req.params.id, "Project id"));
    await req.commitTransaction!();
    res.json(data);
  } catch (error) {
    next(error);
  }
});

export const projectRoutes = router;
