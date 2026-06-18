import { Router } from "express";
import { AppError } from "../../middleware/error-handler.js";
import { requireAdmin } from "../../middleware/rbac.js";
import { requestAuditContext, writeSoftDeleteAuditLog } from "../../lib/soft-delete-audit.js";
import { redactDealList, shouldIncludeHubspotId } from "../deals/redact.js";
import { createProperty, deleteProperty, getPropertyDetail, listProperties, updateProperty } from "./service.js";

const router = Router();

router.get("/", async (req, res, next) => {
  try {
    const { search, companyId, type, sortBy, sortDir, page, limit, isActive } = req.query as Record<string, string>;
    const result = await listProperties(req.tenantDb!, {
      search,
      companyId,
      type,
      sortBy,
      sortDir: sortDir === "asc" ? "asc" : sortDir === "desc" ? "desc" : undefined,
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
    const allowedFields = ["address", "city", "state", "zip", "buildYear", "unitCount"] as const;
    const input: Parameters<typeof updateProperty>[2] = {};
    for (const field of allowedFields) {
      if (Object.prototype.hasOwnProperty.call(req.body, field)) {
        input[field] = req.body[field];
      }
    }
    const property = await updateProperty(req.tenantDb!, req.params.id, input);
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
    const propertyId = req.params.id as string;
    const property = await deleteProperty(req.tenantDb!, propertyId);
    if (property) {
      await writeSoftDeleteAuditLog(req.tenantDb!, {
        actorUserId: req.user!.id,
        entityType: "property",
        entityId: propertyId,
        ...requestAuditContext(req),
      });
    }
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
    const includeHubspotId = shouldIncludeHubspotId(req.query, req.user!.role);
    res.json({ ...result, deals: redactDealList(result.deals ?? [], { includeHubspotId }) });
  } catch (err) {
    next(err);
  }
});

export const propertyRoutes = router;
