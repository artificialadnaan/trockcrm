import { Router } from "express";
import { pool } from "../lib/db.js";
import { requireAuth } from "../lib/auth.js";

export const authRouter = Router();

export function logoutCookieClears() {
  const isProduction = process.env.NODE_ENV === "production";
  const sharedCookieDomain = process.env.AUTH_COOKIE_DOMAIN?.trim() || (isProduction ? ".trockcrm.com" : undefined);
  const tokenOptions = {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "lax" : "strict",
    path: "/",
    maxAge: 0,
  } as const;
  const csrfOptions = {
    httpOnly: false,
    secure: isProduction,
    sameSite: isProduction ? "none" : "strict",
    path: "/",
    maxAge: 0,
  } as const;

  return [
    { name: "token", options: sharedCookieDomain ? { ...tokenOptions, domain: sharedCookieDomain } : tokenOptions },
    { name: "token", options: tokenOptions },
    { name: "csrf_token", options: sharedCookieDomain ? { ...csrfOptions, domain: sharedCookieDomain } : csrfOptions },
    { name: "csrf_token", options: csrfOptions },
  ] as const;
}

authRouter.get("/me", requireAuth, async (req, res, next) => {
  try {
    const result = await pool.query(
      `
        SELECT
          users.id,
          users.email,
          users.display_name,
          users.first_name,
          users.last_name,
          users.role::text,
          users.onboarding_completed_at,
          COALESCE(ula.is_enabled AND ula.must_change_password, false) AS must_change_password
        FROM public.users
        LEFT JOIN public.user_local_auth ula ON ula.user_id = users.id
        WHERE users.id = $1
          AND users.is_active = true
        LIMIT 1
      `,
      [req.user!.id],
    );
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: "User not found" });
    return res.json({
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      firstName: user.first_name,
      lastName: user.last_name,
      role: user.role,
      onboardingCompletedAt: user.onboarding_completed_at,
      mustChangePassword: user.must_change_password,
    });
  } catch (error) {
    return next(error);
  }
});

authRouter.post("/logout", (_req, res) => {
  for (const clear of logoutCookieClears()) {
    res.cookie(clear.name, "", clear.options);
  }
  res.json({ success: true });
});
