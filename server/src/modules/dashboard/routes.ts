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
      const data = await getDirectorDashboard(req.tenantDb!, {
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
