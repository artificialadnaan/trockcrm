import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { errorHandler } from "../middleware/error-handler.js";
import { apiLimiter } from "../middleware/rate-limit.js";
import {
  CSRF_COOKIE_NAME,
  createCsrfToken,
  getCsrfCookieOptionsForRequest,
} from "../modules/auth/http-config.js";
import { createLoginRouter } from "./gate/loginRoute.js";
import { requireDemoSession } from "./gate/requireDemoSession.js";
import { createMcpRouter } from "./router.js";
import { createAiChatRouter } from "../modules/ai-chat/routes.js";

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

  // Behind Railway's edge proxy: trust one hop so req.ip is the real client (matching the CRM app),
  // otherwise the IP-keyed rate limiters collapse to a single global bucket.
  app.set("trust proxy", 1);

  // The demo serves its own Vite bundle (one external module script — covered by 'self') plus Vega
  // charts. Vega's expression runtime compiles via Function() (needs 'unsafe-eval') and vega-embed
  // injects <style> elements at runtime (needs 'unsafe-inline' style) — under bare helmet() defaults
  // every chart renders blank. Scope the loosening to a trusted, password-gated, single-purpose demo
  // that loads only its OWN bundle: default-src stays 'self', so no third-party script origin is
  // allowed; the rest of helmet's hardened defaults are kept.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          scriptSrc: ["'self'", "'unsafe-eval'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:"],
        },
      },
    })
  );
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

  // Machine-facing MCP endpoint (its own Bearer auth, not the page cookie). Rate-limited so demo
  // tool-call load can't starve the shared Postgres connection budget (also cap DB_POOL_MAX low on
  // the demo service — see .env.example).
  app.use("/mcp", apiLimiter, createMcpRouter());

  // Demo-gated probe so the UI can check whether the viewer is logged in.
  app.get("/api/session", requireDemoSession, (_req, res) => {
    res.json({ authenticated: true });
  });

  // Demo-gated AI chat (SSE). requireDemoSession also enforces CSRF on this POST; apiLimiter caps
  // turn volume per client so the Anthropic + DB load can't be driven unbounded.
  app.use("/api/ai-chat", requireDemoSession, apiLimiter, createAiChatRouter());

  // Serve the built React client (the /ai-demo page + login UI). The page itself is gated by the
  // demo session; the static shell is public. Mounted AFTER the API routes so they take precedence.
  const clientDist = join(dirname(fileURLToPath(import.meta.url)), "../../../client/dist");
  if (existsSync(clientDist)) {
    app.use(express.static(clientDist));
    // Use the { root } form (not an absolute path): send() then validates only "index.html", so a
    // parent dir with a dot-segment (e.g. a .claude worktree) doesn't trip its dotfile guard.
    app.get("/{*path}", (_req, res) => {
      res.sendFile("index.html", { root: clientDist });
    });
  }

  app.use(errorHandler);
  return app;
}
