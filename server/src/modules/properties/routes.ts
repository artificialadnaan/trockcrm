import { Router } from "express";
import { AppError } from "../../middleware/error-handler.js";
import { requireAdmin } from "../../middleware/rbac.js";
import { createProperty, deleteProperty, getPropertyDetail, listProperties, updateProperty } from "./service.js";

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

router.post("/", async (req, res, next) => {
  try {
    const { companyId, name, address, city, state, zip, buildYear, unitCount, notes } = req.body;
    if (!companyId) {
      throw new AppError(400, "companyId is required");
    }
    if (!name?.trim()) {
      throw new AppError(400, "Property name is required");
    }
    const property = await createProperty(req.tenantDb!, {
      companyId,
      name: name.trim(),
      address,
      city,
      state,
      zip,
      buildYear,
      unitCount,
      notes,
    });
    await req.commitTransaction!();
    res.status(201).json({ property });
  } catch (err) {
    next(err);
  }
});

router.patch("/:id", async (req, res, next) => {
  try {
    const property = await updateProperty(req.tenantDb!, req.params.id, {
      buildYear: req.body.buildYear,
      unitCount: req.body.unitCount,
    });
    if (!property) {
      throw new AppError(404, "Property not found");
    }
    await req.commitTransaction!();
    res.json({ property });
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", requireAdmin, async (req, res, next) => {
  try {
    await deleteProperty(req.tenantDb!, req.params.id as string);
    await req.commitTransaction!();
    res.status(204).send();
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
