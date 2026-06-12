import { Router } from "express";
import { pool } from "../../db.js";
import { readDailySummaryByToken } from "./service.js";

// Public, token-guarded daily summary. Mounted at /api/public/daily-summary and allowlisted in
// route-access-policy.ts (no session). The token in the query string is the only credential and is
// validated server-side; a bad/missing/expired/revoked token is a 404.
export const dailySummaryPublicRoutes = Router();

dailySummaryPublicRoutes.get("/", async (req, res, next) => {
  try {
    const token = typeof req.query.token === "string" ? req.query.token : "";
    const client = { query: (text: string, params?: unknown[]) => pool.query(text, params as unknown[]) };
    const payload = await readDailySummaryByToken(client, token);
    if (!payload) {
      res.status(404).json({ error: "This summary link is invalid or has expired." });
      return;
    }
    res.json({ data: payload });
  } catch (err) {
    next(err);
  }
});
