import { Router } from "express";
import { reverseGeocode, suggestAddresses } from "./service.js";

const router = Router();

function readCoordinate(raw: unknown, limit: number): number | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && Math.abs(value) <= limit ? value : null;
}

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
    // Blank-checked before coercion: Number("") is 0, so `?lat=&lng=-78` would geocode a point in the
    // Atlantic and hand back a confident, wrong address rather than degrading to the manual picker.
    const lat = readCoordinate(req.query.lat, 90);
    const lng = readCoordinate(req.query.lng, 180);
    res.json({ address: lat == null || lng == null ? null : await reverseGeocode(lat, lng) });
  } catch (err) {
    next(err);
  }
});

export default router;
