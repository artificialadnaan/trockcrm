import { Router } from "express";
import { getSalesReviewOverview } from "./service.js";

const router = Router();

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

export const salesReviewRoutes = router;
