import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { errorHandler } from "../middleware/error-handler.js";
import {
  CSRF_COOKIE_NAME,
  createCsrfToken,
  getCsrfCookieOptionsForRequest,
} from "../modules/auth/http-config.js";
import { createLoginRouter } from "./gate/loginRoute.js";
import { requireDemoSession } from "./gate/requireDemoSession.js";
import { createMcpRouter } from "./router.js";

/**
 * The T Rock AI demo Express app.
 *
 * This is a DEDICATED app, separate from the CRM's createApp(). It is deployed as its own Railway
 * service from the same `server` workspace (distinct start command, same build/CI gate). The CRM
 * app is untouched — this build is strictly additive.
 *
 * Surfaces:
 *   GET  /api/health   — public liveness.
 *   POST /api/login    — public page gate (DEMO_PASSWORD → signed session cookie).
 *   *    /mcp          — machine-facing MCP endpoint, Bearer-auth via validateSessionToken.
 *   GET  /api/session  — demo-gated probe (the UI uses it to confirm login).
 *   (Phase 4) POST /api/ai-chat — demo-gated Anthropic chat, behind requireDemoSession.
 */
export function createMcpDemoApp(): Express {
  const app = express();

  app.use(helmet());
  app.use(cookieParser());
  app.use(express.json({ limit: "1mb" }));

  // Ensure a CSRF token cookie exists (double-submit pattern), reusing the app's CSRF primitives.
  // httpOnly:false so the browser UI can read it and echo it in the x-csrf-token header.
  app.use((req, res, next) => {
    if (!req.cookies?.[CSRF_COOKIE_NAME]) {
      res.cookie(
        CSRF_COOKIE_NAME,
        createCsrfToken(),
        getCsrfCookieOptionsForRequest(process.env, {
          host: req.get("host"),
          hostname: req.hostname,
          origin: req.headers.origin,
        })
      );
    }
    next();
  });

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  // Public bootstrap: page-password login. The router self-throttles (authLimiter) so the demo's
  // only access gate can't be brute-forced against the shared DEMO_PASSWORD.
  app.use("/api/login", createLoginRouter());

  // Machine-facing MCP endpoint (its own Bearer auth, not the page cookie).
  app.use("/mcp", createMcpRouter());

  // Demo-gated probe so the UI can check whether the viewer is logged in.
  app.get("/api/session", requireDemoSession, (_req, res) => {
    res.json({ authenticated: true });
  });

  app.use(errorHandler);
  return app;
}
