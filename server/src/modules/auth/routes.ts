import { Router } from "express";
import { getDevUsers, getUserByEmail, signJwt } from "./service.js";
import { authMiddleware } from "../../middleware/auth.js";
import { authLimiter } from "../../middleware/rate-limit.js";
import { AppError } from "../../middleware/error-handler.js";

const router = Router();

// Dev-mode: list available users for picker
router.get("/dev/users", authLimiter, async (_req, res, next) => {
  try {
    if (process.env.AZURE_CLIENT_ID) {
      throw new AppError(404, "Dev mode not available");
    }
    const devUsers = await getDevUsers();
    res.json({ users: devUsers });
  } catch (err) {
    next(err);
  }
});

// Dev-mode: login as a specific user
router.post("/dev/login", authLimiter, async (req, res, next) => {
  try {
    if (process.env.AZURE_CLIENT_ID) {
      throw new AppError(404, "Dev mode not available");
    }
    const { email } = req.body;
    if (!email) {
      throw new AppError(400, "Email is required");
    }

    const user = await getUserByEmail(email);
    if (!user) {
      throw new AppError(404, "User not found");
    }

    // Issue #16 fix: check isActive before issuing token
    if (!user.isActive) {
      throw new AppError(403, "User is inactive");
    }

    const token = signJwt({
      userId: user.id,
      email: user.email,
      officeId: user.officeId,
      role: user.role,
    });

    res.cookie("token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
    });

    res.json({
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        role: user.role,
        officeId: user.officeId,
      },
    });
  } catch (err) {
    next(err);
  }
});

// MS Entra SSO routes — will be added when Azure credentials are provided.
// For MVP, the dev-mode user picker handles authentication.
// TODO: POST /api/auth/sso/callback — exchange authorization code for tokens
// TODO: GET /api/auth/sso/login — redirect to Microsoft authorization endpoint

// Get current user
router.get("/me", authMiddleware, (req, res) => {
  res.json({ user: req.user });
});

// Logout
router.post("/logout", (_req, res) => {
  res.clearCookie("token");
  res.json({ success: true });
});

export const authRoutes = router;
