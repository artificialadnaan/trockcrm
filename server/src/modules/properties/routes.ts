import { Router } from "express";
import { AppError } from "../../middleware/error-handler.js";
import { getPropertyDetail, listProperties } from "./service.js";

const router = Router();

router.get("/", async (req, res, next) => {
  try {
    const { search, companyId, page, limit, isActive } = req.query as Record<string, string>;
    const result = await listProperties(req.tenantDb!, {
      search,
      companyId,
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 100,
      isActive: isActive === "false" ? false : true,
    });
    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const result = await getPropertyDetail(req.tenantDb!, req.params.id);
    if (!result) {
      throw new AppError(404, "Property not found");
    }
    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export const propertyRoutes = router;
