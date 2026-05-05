import { Router } from "express";
import { requireFieldContractor } from "../../middleware/field-auth.js";

export const fieldRoutes = Router();

fieldRoutes.get("/me", requireFieldContractor, (req, res) => {
  res.json({
    user: {
      id: req.fieldUser!.id,
      email: req.fieldUser!.email,
      firstName: req.fieldUser!.firstName,
      lastName: req.fieldUser!.lastName,
      role: req.fieldUser!.role,
      tenantId: req.fieldUser!.tenantId,
      active: req.fieldUser!.active,
    },
  });
});
