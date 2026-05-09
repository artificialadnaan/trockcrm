import { Router, type Request } from "express";
import {
  getCommissionEarned,
  getCommissionPotential,
  getRepCommissionDashboard,
  getCommissionSummary,
  normalizeCommissionPeriod,
  type CommissionReportFilters,
} from "./reporting-service.js";

const router = Router();

function parseStages(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => parseStages(item));
  }
  if (typeof value !== "string") return [];
  return value.split(",").map((stage) => stage.trim()).filter(Boolean);
}

function filtersFromQuery(req: Request): CommissionReportFilters {
  return {
    role: req.user!.role,
    userId: req.user!.id,
    repId: typeof req.query.repId === "string" ? req.query.repId : undefined,
    from: typeof req.query.from === "string" ? req.query.from : undefined,
    to: typeof req.query.to === "string" ? req.query.to : undefined,
    stages: parseStages(req.query.stage ?? req.query.stages),
  };
}

router.get("/potential", async (req, res, next) => {
  try {
    const data = await getCommissionPotential(req.tenantDb!, filtersFromQuery(req));
    await req.commitTransaction!();
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.get("/dashboard", async (req, res, next) => {
  try {
    const data = await getRepCommissionDashboard(req.tenantDb!, {
      ...filtersFromQuery(req),
      period: normalizeCommissionPeriod(req.query.period),
    });
    await req.commitTransaction!();
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.get("/earned", async (req, res, next) => {
  try {
    const data = await getCommissionEarned(req.tenantDb!, filtersFromQuery(req));
    await req.commitTransaction!();
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

router.get("/summary", async (req, res, next) => {
  try {
    const data = await getCommissionSummary(req.tenantDb!, filtersFromQuery(req));
    await req.commitTransaction!();
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

export const commissionRoutes = router;
