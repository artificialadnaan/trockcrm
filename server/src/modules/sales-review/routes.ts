import { Router, type Request } from "express";
import { getSalesReviewOverview } from "./service.js";
import {
  applyOwnershipSync,
  listAssignableOfficeUsers,
  previewOwnershipSync,
  reassignOwnedDeal,
} from "./ownership-sync-service.js";
import { AppError } from "../../middleware/error-handler.js";

const router = Router();

function requireRole(req: Request, roles: Array<"admin" | "director" | "rep">) {
  if (!req.user || !roles.includes(req.user.role as "admin" | "director" | "rep")) {
    throw new AppError(403, "Forbidden");
  }
}

router.get("/", async (req, res, next) => {
  try {
    const overview = await getSalesReviewOverview(
      req.tenantDb!,
      {
        from: req.query.from as string | undefined,
        to: req.query.to as string | undefined,
        repId: req.query.repId as string | undefined,
        forecastWindow: req.query.forecastWindow as any,
      },
      {
        role: req.user!.role as "admin" | "director" | "rep",
        userId: req.user!.id,
      }
    );
    await req.commitTransaction!();
    res.json(overview);
  } catch (err) {
    next(err);
  }
});

router.post("/ownership-sync/preview", async (req, res, next) => {
  try {
    requireRole(req, ["admin"]);
    const result = await previewOwnershipSync(req.tenantDb!, req.user!.activeOfficeId);
    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/ownership-sync/apply", async (req, res, next) => {
  try {
    requireRole(req, ["admin"]);
    const summary = await applyOwnershipSync(req.tenantDb!, req.user!.activeOfficeId);
    await req.commitTransaction!();
    res.json(summary);
  } catch (err) {
    next(err);
  }
});

router.get("/assignable-users", async (req, res, next) => {
  try {
    requireRole(req, ["admin", "director"]);
    const users = await listAssignableOfficeUsers(req.tenantDb!, req.user!.activeOfficeId);
    await req.commitTransaction!();
    res.json({ users });
  } catch (err) {
    next(err);
  }
});

router.post("/ownership-reassign", async (req, res, next) => {
  try {
    requireRole(req, ["admin", "director"]);
    const { dealId, userId } = req.body as { dealId?: string; userId?: string };
    if (!dealId || !userId) {
      throw new AppError(400, "dealId and userId are required");
    }
    await reassignOwnedDeal({
      tenantDb: req.tenantDb!,
      actor: {
        id: req.user!.id,
        role: req.user!.role as "admin" | "director" | "rep",
        activeOfficeId: req.user!.activeOfficeId,
      },
      dealId,
      userId,
    });
    await req.commitTransaction!();
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export const salesReviewRoutes = router;
