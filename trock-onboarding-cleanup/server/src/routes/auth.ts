import { Router } from "express";
import { pool } from "../lib/db.js";
import { requireAuth } from "../lib/auth.js";

export const authRouter = Router();

const isProduction = process.env.NODE_ENV === "production";
const tokenCookieOptions = {
  httpOnly: true,
  secure: isProduction,
  sameSite: isProduction ? "none" : "strict",
  path: "/",
} as const;

authRouter.get("/me", requireAuth, async (req, res, next) => {
  try {
    const result = await pool.query(
      `
        SELECT
          id,
          email,
          display_name,
          first_name,
          last_name,
          role::text,
          onboarding_completed_at
        FROM public.users
        WHERE id = $1
          AND is_active = true
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
    });
  } catch (error) {
    return next(error);
  }
});

authRouter.post("/logout", (_req, res) => {
  res.clearCookie("token", tokenCookieOptions);
  res.clearCookie("csrf_token", {
    httpOnly: false,
    secure: isProduction,
    sameSite: isProduction ? "none" : "strict",
    path: "/",
  });
  res.json({ success: true });
});
