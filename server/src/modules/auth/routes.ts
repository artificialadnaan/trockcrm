import { Router } from "express";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { ensureDevDemoWorkspace, ensureDevUserPrimaryOffice, getDevUsers, getUserByEmail, getUserById, signJwt } from "./service.js";
import { authMiddleware } from "../../middleware/auth.js";
import { authLimiter } from "../../middleware/rate-limit.js";
import { AppError } from "../../middleware/error-handler.js";
import { requireAdmin } from "../../middleware/rbac.js";
import {
  exchangeCodeForTokens,
  getConsentUrl,
  isGraphAuthConfigured,
} from "../email/graph-auth.js";
import { getGraphTokenStatus, revokeGraphTokens } from "../email/graph-token-service.js";
import { getTokenCookieOptions, isDevAuthEnabled } from "./http-config.js";
import {
  clearStoredProcoreOauthTokens,
  getStoredProcoreOauthTokens,
  upsertProcoreOauthTokens,
} from "../procore/oauth-token-service.js";
import {
  changeLocalPassword,
  loginWithLocalPassword,
} from "./local-auth-service.js";

const router = Router();

function isDevMode(req: import("express").Request): boolean {
  const host = req.hostname || req.get("host") || "";
  return isDevAuthEnabled(process.env, host);
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

    const demoDefaultOfficeSlug = process.env.DEMO_DEFAULT_OFFICE_SLUG?.trim().toLowerCase() || "dallas";
    const resolvedUser = await ensureDevUserPrimaryOffice(user.id, demoDefaultOfficeSlug);
    if (!resolvedUser) {
      throw new AppError(404, "User not found");
    }

    await ensureDevDemoWorkspace(resolvedUser.id, demoDefaultOfficeSlug);

    const token = signJwt({
      userId: resolvedUser.id,
      email: resolvedUser.email,
      officeId: resolvedUser.officeId,
      role: resolvedUser.role,
    });

    res.cookie("token", token, tokenCookieOptions);

    res.json({
      user: {
        id: resolvedUser.id,
        email: resolvedUser.email,
        displayName: resolvedUser.displayName,
        role: resolvedUser.role,
        officeId: resolvedUser.officeId,
        activeOfficeId: resolvedUser.officeId,
        mustChangePassword: false,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.post("/local/login", authLimiter, async (req, res, next) => {
  try {
    const email = typeof req.body?.email === "string" ? req.body.email : "";
    const password =
      typeof req.body?.password === "string" ? req.body.password : "";

    if (!email || !password) {
      throw new AppError(400, "Email and password are required");
    }

    const { user } = await loginWithLocalPassword({ email, password });

    const token = signJwt({
      userId: user.id,
      email: user.email,
      officeId: user.officeId,
      role: user.role,
    });

    res.cookie("token", token, tokenCookieOptions);
    res.json({ user });
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

router.post("/local/change-password", authMiddleware, async (req, res, next) => {
  try {
    const currentPassword =
      typeof req.body?.currentPassword === "string"
        ? req.body.currentPassword
        : "";
    const newPassword =
      typeof req.body?.newPassword === "string" ? req.body.newPassword : "";

    if (!currentPassword || !newPassword) {
      throw new AppError(400, "Current password and new password are required");
    }

    await changeLocalPassword({
      userId: req.user!.id,
      currentPassword,
      newPassword,
    });

    res.json({
      user: {
        ...req.user!,
        mustChangePassword: false,
      },
    });
  } catch (err) {
    next(err);
  }
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
      // Consent starts from the frontend origin and sets this cookie on the API origin via fetch.
      // In production that is a cross-site request, so the nonce cookie must allow cross-site storage.
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
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

export async function exchangeProcoreCodeForTokens(code: string, redirectUri: string) {
  const response = await fetch("https://login.procore.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: process.env.PROCORE_CLIENT_ID,
      client_secret: process.env.PROCORE_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`PROCORE_OAUTH_CODE_EXCHANGE_FAILED:${errorText}`);
  }

  return response.json() as Promise<{
    access_token: string;
    refresh_token: string;
    expires_in: number;
    scope?: string;
  }>;
}

function getProcoreAuthErrorRedirect(reason: string) {
  return `${process.env.FRONTEND_URL || "http://localhost:5173"}/admin/procore?procore=error&reason=${encodeURIComponent(reason)}`;
}

// GET /api/auth/procore/url — get Procore OAuth authorize URL
router.get("/procore/url", authMiddleware, requireAdmin, async (req, res, next) => {
  try {
    if (!process.env.PROCORE_CLIENT_ID || !process.env.PROCORE_CLIENT_SECRET) {
      res.json({
        url: null,
        authMode: "dev",
        message: "Procore auth not configured — using dev mode",
      });
      return;
    }

    const redirectUri = `${process.env.API_BASE_URL || "http://localhost:3001"}/api/auth/procore/callback`;
    const state = jwt.sign({
      sub: req.user!.id,
      role: req.user!.role,
      officeId: req.user!.activeOfficeId ?? req.user!.officeId,
      purpose: "procore_oauth",
    }, process.env.JWT_SECRET!, { expiresIn: "10m" });

    const params = new URLSearchParams({
      response_type: "code",
      client_id: process.env.PROCORE_CLIENT_ID!,
      redirect_uri: redirectUri,
      state,
    });

    res.json({ url: `https://login.procore.com/oauth/authorize?${params.toString()}` });
  } catch (err) {
    next(err);
  }
});

// GET /api/auth/procore/callback — handle Procore OAuth callback
router.get("/procore/callback", async (req, res) => {
  const code = req.query.code as string | undefined;
  const state = req.query.state as string | undefined;
  const error = req.query.error as string | undefined;
  const apiBaseUrl = process.env.API_BASE_URL || "http://localhost:3001";
  const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";

  if (error) {
    res.redirect(getProcoreAuthErrorRedirect(error));
    return;
  }

  if (!code || !state) {
    res.redirect(getProcoreAuthErrorRedirect("missing_code"));
    return;
  }

  if (!process.env.JWT_SECRET || !process.env.PROCORE_CLIENT_ID || !process.env.PROCORE_CLIENT_SECRET) {
    res.redirect(getProcoreAuthErrorRedirect("oauth_not_configured"));
    return;
  }

  let payload: {
    sub: string;
    role: string;
    purpose: string;
  };

  try {
    payload = jwt.verify(state, process.env.JWT_SECRET) as {
      sub: string;
      role: string;
      purpose: string;
    };

    if (payload.purpose !== "procore_oauth" || payload.role !== "admin") {
      throw new AppError(403, "Invalid Procore OAuth state");
    }
  } catch {
    res.redirect(getProcoreAuthErrorRedirect("invalid_state"));
    return;
  }

  const stateUser = await getUserById(payload.sub);
  if (!stateUser || !stateUser.isActive || stateUser.role !== "admin") {
    res.redirect(getProcoreAuthErrorRedirect("invalid_state"));
    return;
  }

  let tokenResponse: {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    scope?: string;
  };

  try {
    tokenResponse = await exchangeProcoreCodeForTokens(
      code,
      `${apiBaseUrl}/api/auth/procore/callback`
    );
  } catch {
    res.redirect(getProcoreAuthErrorRedirect("token_exchange_failed"));
    return;
  }

  try {
    await upsertProcoreOauthTokens({
      accessToken: tokenResponse.access_token,
      refreshToken: tokenResponse.refresh_token,
      expiresAt: new Date(Date.now() + tokenResponse.expires_in * 1000),
      scopes: tokenResponse.scope?.split(" ") ?? [],
      accountEmail: null,
      accountName: null,
    });

    res.redirect(`${frontendUrl}/admin/procore?procore=connected`);
  } catch {
    res.redirect(getProcoreAuthErrorRedirect("token_storage_failed"));
  }
});

// GET /api/auth/procore/status — get current Procore OAuth connection status
router.get("/procore/status", authMiddleware, requireAdmin, async (_req, res, next) => {
  try {
    const tokens = await getStoredProcoreOauthTokens();
    const authMode =
      tokens
        ? "oauth"
        : !process.env.PROCORE_CLIENT_ID || !process.env.PROCORE_CLIENT_SECRET
          ? "dev"
          : "client_credentials";

    res.json({
      connected: tokens?.status === "active",
      expiresAt: tokens?.expiresAt?.toISOString() ?? null,
      accountEmail: tokens?.accountEmail ?? null,
      accountName: tokens?.accountName ?? null,
      status: tokens?.status ?? null,
      errorMessage: tokens?.lastError ?? null,
      authMode,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/procore/disconnect — clear stored Procore OAuth tokens
router.post("/procore/disconnect", authMiddleware, requireAdmin, async (_req, res, next) => {
  try {
    await clearStoredProcoreOauthTokens();
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export const authRoutes = router;
