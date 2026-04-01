import { Router } from "express";
import { authMiddleware } from "../../middleware/auth.js";
import { requireAdmin } from "../../middleware/rbac.js";
import { getAllOffices, getOfficeById, createOffice } from "./service.js";
import { AppError } from "../../middleware/error-handler.js";

const router = Router();

// List all offices (admin only — Issue #17 fix)
router.get("/", authMiddleware, requireAdmin, async (_req, res, next) => {
  try {
    const officeList = await getAllOffices();
    res.json({ offices: officeList });
  } catch (err) {
    next(err);
  }
});

// Get single office (admin only — Issue #17 fix)
router.get("/:id", authMiddleware, requireAdmin, async (req, res, next) => {
  try {
    const office = await getOfficeById(req.params.id as string);
    if (!office) throw new AppError(404, "Office not found");
    res.json({ office });
  } catch (err) {
    next(err);
  }
});

// Create new office (admin only)
router.post("/", authMiddleware, requireAdmin, async (req, res, next) => {
  try {
    const { name, slug, address, phone } = req.body;
    if (!name || !slug) {
      throw new AppError(400, "Name and slug are required");
    }
    const office = await createOffice(name, slug, address, phone);
    res.status(201).json({ office });
  } catch (err) {
    next(err);
  }
});

export const officeRoutes = router;
