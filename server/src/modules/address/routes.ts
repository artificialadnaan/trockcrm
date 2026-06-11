import { Router } from "express";
import { suggestAddresses } from "./service.js";

const router = Router();

// GET /api/address/suggest?q=<text> — proxied Mapbox address autocomplete.
// suggestAddresses never throws (it degrades to []), so this returns 200 { suggestions } always.
router.get("/suggest", async (req, res, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q : "";
    res.json({ suggestions: await suggestAddresses(q) });
  } catch (err) {
    next(err);
  }
});

export default router;
