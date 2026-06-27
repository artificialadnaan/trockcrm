import { Router } from "express";
import crypto from "crypto";
import { authLimiter } from "../../middleware/rate-limit.js";
import { getDemoPassword } from "./env.js";
import { DEMO_SESSION_COOKIE, demoSessionCookieOptions, signDemoSession } from "./demoSession.js";

/** Length-independent constant-time string compare. */
function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * POST /api/login — the only way past the page gate. Verifies the submitted password against
 * DEMO_PASSWORD (constant-time) and, on success, sets the signed httpOnly demo session cookie.
 * Public (no CSRF / no session required) — it's the bootstrap, matching how the CRM exempts its
 * own login endpoints.
 */
export function createLoginRouter(): Router {
  const router = Router();
  // Brute-force protection on the demo's only access gate (same limiter as the CRM auth routes):
  // throttle guesses against the shared DEMO_PASSWORD before the password is ever checked.
  router.post("/", authLimiter, (req, res) => {
    const submitted = typeof req.body?.password === "string" ? req.body.password : "";
    if (!timingSafeEqualStr(submitted, getDemoPassword())) {
      res.status(401).json({ error: { message: "Invalid password" } });
      return;
    }
    res.cookie(DEMO_SESSION_COOKIE, signDemoSession(), demoSessionCookieOptions());
    res.json({ ok: true });
  });
  return router;
}
