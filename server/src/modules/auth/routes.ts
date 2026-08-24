import { Router } from "express";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import {
  ensureDevDemoWorkspace,
  ensureDevUserPrimaryOffice,
  getAccessibleOffices,
  getDevUsers,
  getUserByEmail,
  getUserById,
  getUserOnboardingGateStatus,
  userHasPendingTaskAssignments,
  signJwt,
} from "./service.js";
import { authMiddleware } from "../../middleware/auth.js";
import { authLimiter } from "../../middleware/rate-limit.js";
import { AppError } from "../../middleware/error-handler.js";
import { requireAdmin } from "../../middleware/rbac.js";
import { isRfpReviewerEmail } from "@trock-crm/shared/lib/rfpReviewerEmails";
import { isRfpVoterEmail } from "@trock-crm/shared/lib/rfpVoterEmails";
import { isDailyActivityLogViewerEmail } from "@trock-crm/shared/lib/dailyActivityLogViewers";
import { isCanvassingReportViewerEmail } from "@trock-crm/shared/lib/canvassingReportViewers";
import { isDealMoveBackApproverEmail } from "@trock-crm/shared/lib/dealMoveBackApprovers";

/**
 * The role floor both allowlisted report routes sit behind (requireAnyRole). Shared by the two flags below
 * so they cannot drift from each other; if that role list changes, this changes with it.
 */
const REPORT_SURFACE_ROLES = new Set(["admin", "director", "rep"]);
import {
  exchangeCodeForTokens,
  getConsentUrl,
  isGraphAuthConfigured,
} from "../email/graph-auth.js";
import { getGraphTokenStatus, revokeGraphTokens } from "../email/graph-token-service.js";
import {
  CSRF_COOKIE_NAME,
  getCsrfCookieOptionsForRequest,
  getLegacyTokenCookieClearsForRequest,
  getLogoutCookieClearsForRequest,
  getTokenCookieOptionsForRequest,
  isDevAuthEnabled,
  shouldExposeCsrfTokenInResponse,
} from "./http-config.js";
import {
  clearStoredProcoreOauthTokens,
  getStoredProcoreOauthTokens,
  upsertProcoreOauthTokens,
} from "../procore/oauth-token-service.js";
import {
  changeLocalPassword,
  loginWithLocalPassword,
} from "./local-auth-service.js";
import { loginMobileUser } from "./mobile-auth-service.js";
// From password-policy.js, NOT local-auth-service.js: several suites mock local-auth-service with a
// plain factory, and reaching the policy through that module made this route depend on whichever mock
// registered first in a worker.
import { validatePasswordPolicy } from "./password-policy.js";
import {
  completePasswordReset,
  dbClient,
  deliverResetEmail,
  finalizePasswordReset,
  isResetTokenUsable,
  issueResetToken,
  lookupUserContact,
  notifyPasswordChanged,
} from "./password-reset-service.js";
import { fieldUserAuthRouter } from "../field-users/routes.js";
import { isAuthDemoBootstrapEnabled } from "../../config/feature-flags.js";

/** The role floor on the return-to-opportunity routes, kept beside the flag that mirrors it. */
const MOVE_BACK_ROLES = new Set(["admin", "director"]);

const router = Router();

function isDevMode(req: import("express").Request): boolean {
  const host = req.hostname || req.get("host") || "";
  return isDevAuthEnabled(process.env, host);
}
function tokenCookieOptionsForRequest(req: import("express").Request) {
  return getTokenCookieOptionsForRequest(process.env, {
    host: req.get("host"),
    hostname: req.hostname,
    origin: req.headers.origin,
  });
}

function logoutCookieClearsForRequest(req: import("express").Request) {
  return getLogoutCookieClearsForRequest(process.env, {
    host: req.get("host"),
    hostname: req.hostname,
    origin: req.headers.origin,
  });
}

function legacyTokenCookieClearsForRequest(req: import("express").Request) {
  return getLegacyTokenCookieClearsForRequest(process.env, {
    host: req.get("host"),
    hostname: req.hostname,
    origin: req.headers.origin,
  });
}

function refreshAuthTokenCookie(
  req: import("express").Request,
  res: import("express").Response,
  token: string
) {
  for (const clear of legacyTokenCookieClearsForRequest(req)) {
    res.cookie(clear.name, "", clear.options);
  }
  res.cookie("token", token, tokenCookieOptionsForRequest(req));
  // Refresh the CSRF cookie's expiry in lockstep with the (now 30-day) auth cookie. The global CSRF
  // middleware writes csrf_token only when it is ABSENT, so a returning browser holding a shorter-lived
  // CSRF cookie (e.g. a pre-30d-deploy one) would otherwise keep it; once it lapsed mid-session the
  // next unsafe request would 403 even though the auth session is still valid. Reuse the value the
  // middleware already settled for this request so the double-submit pair stays consistent.
  const csrfToken = csrfTokenForResponse(res);
  if (csrfToken) {
    res.cookie(CSRF_COOKIE_NAME, csrfToken, getCsrfCookieOptionsForRequest(process.env, csrfResponseRequest(req)));
  }
}

function csrfTokenForResponse(res: import("express").Response): string | undefined {
  return typeof res.locals.csrfToken === "string" ? res.locals.csrfToken : undefined;
}

function csrfResponseRequest(req: import("express").Request) {
  return {
    host: req.get("host"),
    hostname: req.hostname,
    origin: req.headers.origin,
  };
}

function withCsrfToken<T extends Record<string, unknown>>(
  req: import("express").Request,
  res: import("express").Response,
  payload: T
) {
  if (!shouldExposeCsrfTokenInResponse(process.env, csrfResponseRequest(req))) return payload;
  const csrfToken = csrfTokenForResponse(res);
  return csrfToken ? { ...payload, csrfToken } : payload;
}

function normalizeOrigin(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed.replace(/\/+$/, "");
  return `https://${trimmed.replace(/\/+$/, "")}`;
}

function safeReturnTo(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  const allowedOrigins = [
    normalizeOrigin(process.env.FRONTEND_URL),
    normalizeOrigin(process.env.ONBOARDING_CLEANUP_URL),
    "https://onboarding.trockcrm.com",
    "http://localhost:5173",
    "http://localhost:5175",
  ].filter((origin): origin is string => Boolean(origin));
  return allowedOrigins.includes(parsed.origin) ? parsed.toString() : null;
}

function isMicrosoftAdminConsentError(error: unknown, description?: unknown): boolean {
  const text = `${String(error ?? "")} ${String(description ?? "")}`.toLowerCase();
  return (
    text.includes("admin consent") ||
    text.includes("administrator has not consented") ||
    text.includes("admin approval") ||
    text.includes("aadsts65001")
  );
}

function graphOAuthErrorRedirect(error: unknown, description?: unknown) {
  const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";
  const code = isMicrosoftAdminConsentError(error, description)
    ? "microsoft_admin_consent_required"
    : String(error || "exchange_failed");
  return `${frontendUrl}/email?error=${encodeURIComponent(code)}`;
}

function graphOAuthExchangeErrorRedirect(error: unknown) {
  const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";
  const code = isMicrosoftAdminConsentError(error)
    ? "microsoft_admin_consent_required"
    : "exchange_failed";
  return `${frontendUrl}/email?error=${encodeURIComponent(code)}`;
}

async function withOnboardingGate<T extends { id: string; email: string; officeId: string; activeOfficeId?: string; role: string }>(user: T) {
  const officeId = user.activeOfficeId ?? user.officeId;
  // Run alongside the gate rather than after it. This builder is on the critical path of every page
  // boot (/auth/me calls it), so the added F6 lookup costs latency only if it is serialised behind the
  // gate's own queries — and allSettled keeps it strictly optional: a failed lookup means "no modal",
  // never a failed sign-in. Somebody who cannot log in because a task query timed out is a far worse
  // outcome than somebody who misses one popup.
  const [gateResult, pendingTasksResult] = await Promise.allSettled([
    getUserOnboardingGateStatus({
      userId: user.id,
      officeId,
      role: user.role,
    }),
    // Wrapped in an async thunk rather than called directly into the array. A direct call that throws
    // SYNCHRONOUSLY — the function is missing, an argument is malformed — throws while the array is
    // still being built, before allSettled ever sees it, and takes the whole login down with a 500.
    // That is the precise failure this arrangement exists to make impossible, so the sync path has to
    // be inside the boundary too.
    (async () => userHasPendingTaskAssignments({ userId: user.id, officeId }))(),
  ]);

  if (gateResult.status === "rejected") throw gateResult.reason;
  const gate = gateResult.value;

  return {
    ...user,
    /**
     * F6 — does this person have an assignment they have not been shown yet? The client opens the
     * new-assignment modal on it.
     *
     * It rides HERE, in the shared builder, rather than on /auth/me alone: localLogin sets `user` in
     * place from the login response and never refetches /auth/me, and a newly provisioned person is
     * held on <ForcePasswordChangeScreen/> until /local/change-password answers — so for the exact
     * population this feature was written for, that response is the only user object their app ever
     * receives. One insertion point covers all five paths.
     */
    hasPendingTaskAssignments:
      pendingTasksResult.status === "fulfilled" ? pendingTasksResult.value : false,
    onboardingCompletedAt: gate.onboardingCompletedAt,
    onboardingPendingCount: gate.onboardingPendingCount,
    requiresOnboarding: gate.requiresOnboarding,
    cleanupUrl: gate.cleanupUrl,
    // Whether this user is one of the designated RFP override reviewers (Takashi/Adam). Lets the frontend gate
    // the /rfp-review page; the server endpoints enforce the same allowlist as the hard boundary.
    isRfpReviewer: isRfpReviewerEmail(user.email, process.env),
    // Whether this user is one of the 3 RFP voters (Sidney/Tim/James). Gates the vote UI + /rfp-vote page;
    // the vote endpoint enforces the same allowlist (requireRfpVoter) as the hard boundary.
    isRfpVoter: isRfpVoterEmail(user.email, process.env),
    // Whether this user can actually OPEN each allowlisted report. Both endpoints carry TWO guards —
    // requireAnyRole then the allowlist — so both flags mirror BOTH. Reporting the allowlist alone would set
    // a flag true for an allowlisted sales_manager or construction user, who would then be offered a card
    // whose route bounces them to "/" with no explanation. The endpoints enforce both as the hard boundary.
    canViewDailyActivityLog:
      REPORT_SURFACE_ROLES.has(user.role) && isDailyActivityLogViewerEmail(user.email, process.env),
    canViewCanvassingReport:
      REPORT_SURFACE_ROLES.has(user.role) && isCanvassingReportViewerEmail(user.email, process.env),
    // Same two-guard rule, for the destructive move-back action: the admin/director floor AND the
    // DEAL_MOVE_BACK_APPROVER_EMAILS allowlist, so the deal menu never offers what the endpoint refuses.
    canMoveDealBackToOpportunity:
      MOVE_BACK_ROLES.has(user.role) && isDealMoveBackApproverEmail(user.email, process.env),
  };
}

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

    if (isAuthDemoBootstrapEnabled()) {
      await ensureDevDemoWorkspace(resolvedUser.id, demoDefaultOfficeSlug);
    }

    const token = signJwt({
      userId: resolvedUser.id,
      email: resolvedUser.email,
      officeId: resolvedUser.officeId,
      role: resolvedUser.role,
      tokenVersion: resolvedUser.tokenVersion,
      authMethod: "dev",
    });

    refreshAuthTokenCookie(req, res, token);

    const responseUser = await withOnboardingGate({
        id: resolvedUser.id,
        email: resolvedUser.email,
        displayName: resolvedUser.displayName,
        role: resolvedUser.role,
        officeId: resolvedUser.officeId,
        activeOfficeId: resolvedUser.officeId,
        mustChangePassword: false,
      });

    res.json(withCsrfToken(req, res, { user: responseUser, returnTo: safeReturnTo(req.body?.returnTo) }));
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

    const { user, tokenVersion } = await loginWithLocalPassword({ email, password });

    const token = signJwt({
      userId: user.id,
      email: user.email,
      officeId: user.officeId,
      role: user.role,
      tokenVersion,
      authMethod: "local",
    });

    refreshAuthTokenCookie(req, res, token);
    res.json(withCsrfToken(req, res, { user: await withOnboardingGate({ ...user, activeOfficeId: user.officeId }), returnTo: safeReturnTo(req.body?.returnTo) }));
  } catch (err) {
    next(err);
  }
});

/**
 * Native CRM app login (mobile-crm). Same credentials and same guards as /local/login — it delegates to
 * the identical service — but returns the JWT in the BODY, because a native client cannot read the
 * httpOnly cookie that /local/login sets. Additive: no existing route, middleware or token shape changes.
 *
 * Deliberately does NOT call refreshAuthTokenCookie or withCsrfToken. Setting the cookie here would be
 * actively harmful: the global CSRF gate in app.ts engages only when a `token` cookie is PRESENT, so a
 * cookie-bearing native client would then have to carry a CSRF token on every write it makes. Staying
 * Bearer-only keeps this client outside that gate entirely.
 */
router.post("/mobile-login", authLimiter, async (req, res, next) => {
  try {
    const email = typeof req.body?.email === "string" ? req.body.email : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";

    if (!email || !password) {
      throw new AppError(400, "Email and password are required");
    }

    const { token, user } = await loginMobileUser({ email, password });

    // Clear every auth-cookie variant — the same set logout clears.
    //
    // This is not tidiness, it is what makes the returned token actually the credential in play.
    // authMiddleware reads `req.cookies?.token || req.headers.authorization`, i.e. the COOKIE WINS. A
    // native client is Bearer-only but can still carry a cookie (RN's fetch shares the system cookie
    // store, so any webview opened against this host leaves one behind), and a stale one would silently
    // out-rank the token we just minted — authenticating every request as whoever that cookie belongs to,
    // not as the user who just signed in. It would also keep tripping the cookie-triggered CSRF gate on
    // every write. Clearing at the moment we hand out a Bearer token closes both.
    for (const clear of logoutCookieClearsForRequest(req)) {
      res.cookie(clear.name, "", clear.options);
    }

    // withOnboardingGate supplies isRfpVoter / isRfpReviewer / canViewDailyActivityLog / requiresOnboarding —
    // the same flags the web client gates its RFP and reporting screens on, so the app can hide exactly what
    // the web hides. The server endpoints still enforce those allowlists as the hard boundary.
    res.json({ token, user: await withOnboardingGate({ ...user, activeOfficeId: user.officeId }) });
  } catch (err) {
    next(err);
  }
});

router.use(fieldUserAuthRouter);

// MS Entra SSO routes — will be added when Azure credentials are provided.
// For MVP, the dev-mode user picker handles authentication.
// TODO: POST /api/auth/sso/callback — exchange authorization code for tokens
// TODO: GET /api/auth/sso/login — redirect to Microsoft authorization endpoint

// Get current user
router.get("/me", authMiddleware, async (req, res, next) => {
  try {
    res.json(withCsrfToken(req, res, { user: await withOnboardingGate(req.user!) }));
  } catch (err) {
    next(err);
  }
});

router.get("/accessible-offices", authMiddleware, async (req, res, next) => {
  try {
    const offices = await getAccessibleOffices(req.user!.id, req.user!.role, req.user!.activeOfficeId ?? req.user!.officeId);
    res.json({ offices });
  } catch (err) {
    next(err);
  }
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

    const { tokenVersion } = await changeLocalPassword({
      userId: req.user!.id,
      currentPassword,
      newPassword,
    });

    // The change bumped users.token_version, which invalidates EVERY session including this one. Hand
    // the caller a token at the new version so the device they just used stays signed in while all the
    // others die. Role/office come from the HOME values (baseRole, officeId) exactly as /local/login
    // mints them — the active-office override is request scoped and must never be baked into a token.
    //
    // Only for a caller who actually presented a cookie. The native CRM app is Bearer-only and
    // /mobile-login deliberately CLEARS every auth cookie so it stays outside the cookie-triggered
    // CSRF gate; handing it one here would quietly put it back inside, and authMiddleware reads the
    // cookie before the Authorization header.
    if (req.cookies?.token) {
      const token = signJwt({
        userId: req.user!.id,
        email: req.user!.email,
        officeId: req.user!.officeId,
        role: req.user!.baseRole ?? req.user!.role,
        tokenVersion,
        authMethod: req.user!.authMethod ?? "local",
      });
      refreshAuthTokenCookie(req, res, token);
    }

    res.json(withCsrfToken(req, res, {
      user: await withOnboardingGate({
        ...req.user!,
        mustChangePassword: false,
      }),
    }));
  } catch (err) {
    next(err);
  }
});

// Logout
router.post("/logout", (req, res) => {
  for (const clear of logoutCookieClearsForRequest(req)) {
    res.cookie(clear.name, "", clear.options);
  }
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
      res.redirect(graphOAuthErrorRedirect(error, req.query.error_description));
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
    res.redirect(graphOAuthExchangeErrorRedirect(err instanceof Error ? err.message : err));
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

// --- Self-service password reset (unauthenticated) ---
//
// One message for every failure mode. "Expired", "already used", "never existed" and "invalidated" are
// deliberately indistinguishable: a distinguishable response is an oracle, and none of the distinctions
// help a legitimate user, who needs exactly one instruction either way.
const GENERIC_RESET_FAILURE = "This reset link is no longer valid. Request a new one.";

router.post("/password-reset/request", authLimiter, (req, res) => {
  const email = typeof req.body?.email === "string" ? req.body.email.trim() : "";
  const requestedIp = req.ip ?? null;

  // Respond FIRST, before ANY database work.
  //
  // Deferring only the email was not enough. The number of round trips before the response still gave
  // the account away: an unknown address costs one query (the eligibility lookup), an eligible one
  // costs five, and an eligible one that has hit the per-account cap costs two. That is measurable
  // WITHOUT absolute timing -- send four requests for the same address and watch the fourth get faster
  // as the cap trips, which only happens for an account that exists. Doing everything after the
  // response makes the handler's cost identical in every case, because nothing is left in it.
  res.status(200).json({ ok: true });

  if (!email) return;

  void (async () => {
    try {
      const issued = await issueResetToken(dbClient, email, requestedIp);
      if (issued) await deliverResetEmail(dbClient, issued);
    } catch (err) {
      console.error("[password-reset] request failed", err);
    }
  })();
});

router.post("/password-reset/validate", authLimiter, async (req, res, next) => {
  try {
    const token = typeof req.body?.token === "string" ? req.body.token : "";
    // UX only -- it lets the page say "this link is dead" without burning the token. Carries no
    // security weight; complete() re-checks every condition atomically.
    const valid = token ? await isResetTokenUsable(dbClient, token) : false;
    res.json({ valid });
  } catch (err) {
    next(err);
  }
});

router.post("/password-reset/complete", authLimiter, async (req, res, next) => {
  try {
    const token = typeof req.body?.token === "string" ? req.body.token : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!token || !password) {
      res.status(400).json({ error: { message: GENERIC_RESET_FAILURE } });
      return;
    }

    // Policy check BEFORE consuming, because consuming is destructive. Validating afterwards would burn
    // the user's single-use link on a typo -- they would be told their password was too short AND have
    // to request a whole new email to try again.
    validatePasswordPolicy(password);

    // Consume and apply are ONE transaction. Consuming separately left a window where a failure
    // between the two burned the link without changing the password, telling the user their link was
    // invalid and making them request another email.
    const userId = await completePasswordReset(dbClient, token, password);
    if (!userId) {
      // Covers an unusable token AND an account whose eligibility lapsed inside the TTL -- the same
      // generic message, because neither distinction helps a legitimate user and both help an attacker.
      res.status(400).json({ error: { message: GENERIC_RESET_FAILURE } });
      return;
    }

    res.json({ ok: true });

    // Post-commit side effects (SSE teardown, audit row, change notice) run outside the try above and
    // are individually guarded inside. A throw here would otherwise reach the error handler, which has
    // no headersSent guard and would try to write a 500 onto a finished response -- and none of these
    // may turn a committed password change into a failure the user is told about.
    void finalizePasswordReset(dbClient, userId);
  } catch (err) {
    next(err);
  }
});

export const authRoutes = router;
