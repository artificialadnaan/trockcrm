import { Router } from "express";
import { requireFieldContractor } from "../../middleware/field-auth.js";
import { toFieldUserResponse } from "../field-users/service.js";

export const fieldRoutes = Router();

fieldRoutes.get("/me", requireFieldContractor, (req, res) => {
  res.json({
    user: toFieldUserResponse(req.fieldUser!),
  });
});
