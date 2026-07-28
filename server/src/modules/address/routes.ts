import { Router } from "express";
import { reverseGeocode, suggestAddresses } from "./service.js";

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

/**
 * GET /api/address/reverse?lat=&lng= — "what building am I standing at?".
 *
 * Always 200. `reverseGeocode` degrades to null for a missing token, a malformed coordinate, a non-2xx
 * or a timeout, and `{ address: null }` is the answer the field capture needs: it falls back to the
 * manual address picker. An error status here would put an error screen in front of a rep who is
 * standing at the building they are trying to log.
 */
router.get("/reverse", async (req, res, next) => {
  try {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    res.json({ address: await reverseGeocode(lat, lng) });
  } catch (err) {
    next(err);
  }
});

export default router;
