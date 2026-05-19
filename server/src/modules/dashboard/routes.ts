import { Router } from "express";
import { requireRole } from "../../middleware/rbac.js";
import { AppError } from "../../middleware/error-handler.js";
import type { ActivityRange } from "@trock-crm/shared/types";
import {
  getAdminDashboardSummary,
  getRepDashboard,
  getDirectorDashboard,
  getDirectorCommissionWorkspace,
  getRepDetail,
  getRepPerformanceSnapshots,
  REP_PERFORMANCE_PERIOD_KINDS,
  type RepPerformancePeriodKind,
} from "./service.js";

const router = Router();

// GET /api/dashboard/rep?range=week|month|ytd  -- per-rep dashboard (current user)
// `range` controls the activity-by-type window. Invalid/missing values
// silently default to 'week' inside the service (matches house-style query
// param handling — see tasks/contacts route handlers).
router.get("/rep", async (req, res, next) => {
  try {
    const range = req.query.range as ActivityRange | undefined;
    const data = await getRepDashboard(req.tenantDb!, req.user!.id, { range });
    await req.commitTransaction!();
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// GET /api/dashboard/director -- director overview (admin/director only)
router.get(
  "/admin",
  requireRole("admin"),
  async (req, res, next) => {
    try {
      const data = await getAdminDashboardSummary(
        req.tenantDb!,
        req.user!.activeOfficeId ?? req.user!.officeId
      );
      await req.commitTransaction!();
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  "/director",
  requireRole("admin", "director"),
  async (req, res, next) => {
    try {
      const rawScope = req.query.scope;
      const scope = rawScope === "all" || rawScope === "mine" || rawScope === "team" ? rawScope : "mine";
      const periodKind = (req.query.periodKind ?? "mtd") as string;
      if (!REP_PERFORMANCE_PERIOD_KINDS.includes(periodKind as RepPerformancePeriodKind)) {
        throw new AppError(400, "Invalid rep performance period kind");
      }

      if (scope === "team") {
        await req.commitTransaction!();
        res.json({ data: null });
        return;
      }

      const data = await getDirectorDashboard(req.tenantDb!, {
        from: req.query.from as string | undefined,
        to: req.query.to as string | undefined,
        officeId: req.user!.activeOfficeId ?? req.user!.officeId,
        periodKind: periodKind as RepPerformancePeriodKind,
        scope,
        viewerUserId: req.user!.id,
      });
      await req.commitTransaction!();
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  "/director/commissions",
  requireRole("admin", "director"),
  async (req, res, next) => {
    try {
      const data = await getDirectorCommissionWorkspace(req.tenantDb!, {
        from: req.query.from as string | undefined,
        to: req.query.to as string | undefined,
      });
      await req.commitTransaction!();
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  "/director/rep-performance",
  requireRole("admin", "director"),
  async (req, res, next) => {
    try {
      const periodKind = (req.query.periodKind ?? "mtd") as string;
      if (!REP_PERFORMANCE_PERIOD_KINDS.includes(periodKind as RepPerformancePeriodKind)) {
        throw new AppError(400, "Invalid rep performance period kind");
      }

      const data = await getRepPerformanceSnapshots(
        req.tenantDb!,
        req.user!.activeOfficeId ?? req.user!.officeId,
        periodKind as RepPerformancePeriodKind
      );
      await req.commitTransaction!();
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

// GET /api/dashboard/director/rep/:repId -- drill-down into a specific rep (admin/director only)
router.get(
  "/director/rep/:repId",
  requireRole("admin", "director"),
  async (req, res, next) => {
    try {
      const data = await getRepDetail(req.tenantDb!, req.params.repId as string, {
        from: req.query.from as string | undefined,
        to: req.query.to as string | undefined,
      });
      await req.commitTransaction!();
      res.json({ data });
    } catch (err) {
      next(err);
    }
  }
);

export const dashboardRoutes = router;
