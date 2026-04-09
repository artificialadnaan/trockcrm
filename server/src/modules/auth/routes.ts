import { Router } from "express";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { getDevUsers, getUserByEmail, signJwt } from "./service.js";
import { authMiddleware } from "../../middleware/auth.js";
import { authLimiter } from "../../middleware/rate-limit.js";
import { AppError } from "../../middleware/error-handler.js";
import {
  exchangeCodeForTokens,
  getConsentUrl,
  isGraphAuthConfigured,
} from "../email/graph-auth.js";
import { getGraphTokenStatus, revokeGraphTokens } from "../email/graph-token-service.js";
import { getTokenCookieOptions } from "./http-config.js";

const router = Router();

// Never allow dev mode in production — AZURE_CLIENT_ID must be set.
if (process.env.NODE_ENV === "production" && !process.env.AZURE_CLIENT_ID) {
  console.error("[Auth] FATAL: AZURE_CLIENT_ID is required in production. Dev mode is not allowed.");
}

// Dev mode: enabled only when Azure SSO is not configured AND we are in a local dev environment.
// DEV_MODE env var is intentionally NOT honoured — it was too easy to accidentally leave set on Railway.
const nodeEnv = process.env.NODE_ENV;
const isLocalDevEnv = nodeEnv === "development" || nodeEnv === "test";
const isDevModeFlag = !process.env.AZURE_CLIENT_ID && isLocalDevEnv;

// Additional safety: verify the request is from localhost before allowing dev login
function isDevMode(req: import("express").Request): boolean {
  if (!isDevModeFlag) return false;
  const host = req.hostname || req.get("host") || "";
  const isLocalhost = host === "localhost" || host === "127.0.0.1" || host === "::1" || host.startsWith("localhost:");
  return isLocalhost;
}
const tokenCookieOptions = getTokenCookieOptions(process.env);

// Dev-mode: list available users for picker
router.get("/dev/users", authLimiter, async (req, res, next) => {
  try {
    if (!isDevMode(req)) {
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
    if (!isDevMode(req)) {
      throw new AppError(404, "Dev mode not available");
    }
    const { email } = req.body;
    if (!email) {
      throw new AppError(400, "Email is required");
    }
    if (!email.endsWith("@trock.dev")) {
      throw new AppError(403, "Dev login restricted to test accounts");
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

    res.cookie("token", token, tokenCookieOptions);

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
  res.clearCookie("token", {
    httpOnly: tokenCookieOptions.httpOnly,
    secure: tokenCookieOptions.secure,
    sameSite: tokenCookieOptions.sameSite,
  });
  res.json({ success: true });
});

// --- MS Graph OAuth (Email Integration) ---

// GET /api/auth/graph/consent — redirect user to Microsoft consent screen
router.get("/graph/consent", authMiddleware, (req, res, next) => {
  try {
    if (!isGraphAuthConfigured()) {
      // Dev mode: no Azure credentials, return mock status
      res.json({ url: null, devMode: true, message: "Graph auth not configured — using dev mode" });
      return;
    }

    const redirectUri = `${process.env.API_BASE_URL || "http://localhost:3001"}/api/auth/graph/callback`;
    // Sign the state parameter to prevent tampering (binds callback to this user, expires in 10 min)
    const nonce = crypto.randomUUID();

    // Store nonce in HttpOnly cookie so it can be verified on callback (prevents replay)
    res.cookie("graph_auth_nonce", nonce, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 600_000, // 10 minutes
    });

    const state = jwt.sign(
      { userId: req.user!.id, nonce },
      process.env.JWT_SECRET!,
      { expiresIn: "10m" }
    );
    const url = getConsentUrl(redirectUri, state);
    res.json({ url });
  } catch (err) {
    next(err);
  }
});

// GET /api/auth/graph/callback — handle Microsoft OAuth callback
router.get("/graph/callback", async (req, res, next) => {
  try {
    if (!isGraphAuthConfigured()) {
      res.redirect(`${process.env.FRONTEND_URL || "http://localhost:5173"}/email?error=not_configured`);
      return;
    }

    const code = req.query.code as string;
    const stateToken = req.query.state as string;
    const error = req.query.error as string;

    if (error) {
      console.error(`[GraphAuth] OAuth error: ${error} — ${req.query.error_description}`);
      res.redirect(`${process.env.FRONTEND_URL || "http://localhost:5173"}/email?error=${error}`);
      return;
    }

    if (!code || !stateToken) {
      res.redirect(`${process.env.FRONTEND_URL || "http://localhost:5173"}/email?error=missing_code`);
      return;
    }

    // Verify the signed state token and nonce cookie to prevent callback tampering + replay
    let userId: string;
    try {
      const payload = jwt.verify(stateToken, process.env.JWT_SECRET!) as { userId: string; nonce: string };
      const cookieNonce = req.cookies?.graph_auth_nonce;
      if (!cookieNonce || payload.nonce !== cookieNonce) {
        console.error("[GraphAuth] Nonce mismatch — possible OAuth state replay");
        res.redirect(`${process.env.FRONTEND_URL || "http://localhost:5173"}/email?error=invalid_state`);
        return;
      }
      // Clear the nonce cookie after successful verification (single use)
      res.clearCookie("graph_auth_nonce");
      userId = payload.userId;
    } catch (stateErr: any) {
      console.error("[GraphAuth] Invalid or expired state token:", stateErr.message);
      res.redirect(`${process.env.FRONTEND_URL || "http://localhost:5173"}/email?error=invalid_state`);
      return;
    }

    const redirectUri = `${process.env.API_BASE_URL || "http://localhost:3001"}/api/auth/graph/callback`;
    await exchangeCodeForTokens(userId, code, redirectUri);

    // Redirect back to CRM email page on success
    res.redirect(`${process.env.FRONTEND_URL || "http://localhost:5173"}/email?connected=true`);
  } catch (err) {
    console.error("[GraphAuth] Callback error:", err);
    res.redirect(`${process.env.FRONTEND_URL || "http://localhost:5173"}/email?error=exchange_failed`);
  }
});

// GET /api/auth/graph/status — check if current user has connected Graph
router.get("/graph/status", authMiddleware, async (req, res, next) => {
  try {
    const status = await getGraphTokenStatus(req.user!.id);
    res.json(status);
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/graph/disconnect — revoke Graph tokens
router.post("/graph/disconnect", authMiddleware, async (req, res, next) => {
  try {
    await revokeGraphTokens(req.user!.id);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export const authRoutes = router;
