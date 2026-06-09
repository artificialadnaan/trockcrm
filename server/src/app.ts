import express, { Router } from "express";
import helmet from "helmet";
import compression, { type CompressionFilter } from "compression";
import cors from "cors";
import cookieParser from "cookie-parser";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { errorHandler } from "./middleware/error-handler.js";
import swaggerUi from "swagger-ui-express";
import { apiSpec } from "./api-spec.js";
import { apiLimiter } from "./middleware/rate-limit.js";
import { authRoutes } from "./modules/auth/routes.js";
import { officeRoutes } from "./modules/office/routes.js";
import { notificationRoutes } from "./modules/notifications/routes.js";
import { authMiddleware } from "./middleware/auth.js";
import { requireCrmUser } from "./middleware/field-auth.js";
import { tenantMiddleware } from "./middleware/tenant.js";
import { dealRoutes } from "./modules/deals/routes.js";
import { pipelineRoutes } from "./modules/pipeline/routes.js";
import { contactRoutes } from "./modules/contacts/routes.js";
import { leadRoutes } from "./modules/leads/routes.js";
import { leadDueDiligencePublicRoutes } from "./modules/leads/public-due-diligence-routes.js";
import { projectRoutes } from "./modules/projects/routes.js";
import { emailRoutes } from "./modules/email/routes.js";
import { fileRoutes } from "./modules/files/routes.js";
import { callRecordingRoutes } from "./modules/call-recordings/routes.js";
import { taskRoutes } from "./modules/tasks/routes.js";
import { activityRoutes } from "./modules/activities/routes.js";
import { notificationCrudRoutes } from "./modules/notifications/crud-routes.js";
import { reportRoutes } from "./modules/reports/routes.js";
import { dashboardRoutes } from "./modules/dashboard/routes.js";
import { commissionRoutes } from "./modules/commissions/routes.js";
import { initSsePush } from "./modules/notifications/sse-manager.js";
import { procoreRoutes } from "./modules/procore/routes.js";
import { procoreWebhookRoutes } from "./modules/procore/webhook-routes.js";
import { syncHubRoutes } from "./modules/procore/synchub-routes.js";
import { syncHubProcoreRelayRoutes } from "./modules/synchub/procore-project-relay-routes.js";
import { bidBoardSyncRoutes } from "./modules/bid-board-sync/routes.js";
import { internalRfpRoutes } from "./modules/internal-rfp/routes.js";
import { registerProcoreEventHandlers } from "./modules/procore/event-handlers.js";
import { migrationRouter } from "./modules/migration/routes.js";
import { searchRoutes } from "./modules/search/routes.js";
import { companyRoutes } from "./modules/companies/routes.js";
import { propertyRoutes } from "./modules/properties/routes.js";
import { adminRoutes } from "./modules/admin/routes.js";
import { companycamRoutes } from "./modules/companycam/routes.js";
import { aiCopilotRoutes } from "./modules/ai-copilot/routes.js";
import usageRoutes from "./modules/usage/routes.js";
import { salesReviewRoutes } from "./modules/sales-review/routes.js";
import { userRoutes } from "./modules/users/routes.js";
import { fieldRoutes } from "./modules/field/routes.js";
import {
  adminPhotoTokenRoutes,
  publicPhotoViewerRoutes,
} from "./modules/public-photo-tokens/routes.js";
import { CRM_ONLY_TENANT_ROUTE_MOUNTS } from "./route-access-policy.js";
import {
  createCsrfToken,
  CSRF_COOKIE_NAME,
  FIELD_CSRF_HEADER_NAME,
  CSRF_HEADER_NAME,
  getAllowedCorsOrigins,
  getCsrfCookieOptionsForRequest,
  getRequestOrigin,
  isAllowedCookieAuthOrigin,
  isFieldApiPath,
  isPublicAuthCsrfExempt,
  isUnsafeHttpMethod,
  isValidCsrfPair,
  isValidFieldCsrfHeader,
} from "./modules/auth/http-config.js";
import { getSecurityOptions } from "./middleware/security.js";

export function createApp() {
  const app = express();

  app.use(helmet(getSecurityOptions(process.env)));

  if (process.env.NODE_ENV === "production" || process.env.TRUST_PROXY === "true") {
    app.set("trust proxy", 1);
  }

  // Core middleware — skip compression for SSE streams (buffering breaks real-time delivery)
  app.use(compression({
    filter: (req, res) => {
      if (req.path === "/api/notifications/stream") return false;
      return (compression.filter as CompressionFilter)(req, res);
    },
  }));
  app.use(cors({
    origin: getAllowedCorsOrigins(process.env),
    credentials: true,
  }));

  // Procore webhook route — public (signature-verified, no JWT).
  // MUST be mounted BEFORE express.json() so the raw body is available for
  // HMAC signature verification. The route uses express.raw() internally.
  app.use("/api/webhooks/procore", procoreWebhookRoutes);

  // SyncHub enriched Procore relay route — public integration route signed by
  // SyncHub. Mounted before express.json() so HMAC verification uses raw body.
  app.use("/api/webhooks/synchub", syncHubProcoreRelayRoutes);

  // Bid Board ingestion route — public integration route signed by SyncHub.
  // Mounted before express.json() so HMAC verification uses the raw body.
  app.use("/api/bid-board-sync", bidBoardSyncRoutes);

  // Internal SyncHub RFP callbacks — signed integration routes. Mounted before
  // express.json() so HMAC verification uses the original raw body bytes.
  app.use("/api/internal", internalRfpRoutes);

  app.use(cookieParser());

  // Public tokenized DD decision page. Mounted before cookie-auth CSRF checks:
  // the route has no auth boundary, uses per-IP rate limits, and POST decisions
  // are protected by high-entropy tokens plus row-level locking.
  app.use(
    "/api/public/lead-due-diligence",
    express.urlencoded({ extended: false }),
    leadDueDiligencePublicRoutes
  );
  app.use("/api/public/photo-viewer", publicPhotoViewerRoutes);

  app.use((req, res, next) => {
    const csrfCookieOptions = getCsrfCookieOptionsForRequest(process.env, {
      host: req.get("host"),
      hostname: req.hostname,
      origin: req.headers.origin,
    });
    const existingCsrfToken =
      typeof req.cookies?.[CSRF_COOKIE_NAME] === "string"
        ? req.cookies[CSRF_COOKIE_NAME]
        : undefined;
    const csrfToken = existingCsrfToken ?? createCsrfToken();
    res.locals.csrfToken = csrfToken;

    if (!existingCsrfToken) {
      res.cookie(CSRF_COOKIE_NAME, csrfToken, csrfCookieOptions);
    }

    const hasAuthCookie = typeof req.cookies?.token === "string";
    if (!hasAuthCookie || !isUnsafeHttpMethod(req.method)) {
      return next();
    }

    if (isPublicAuthCsrfExempt({
      method: req.method,
      path: req.path,
      host: req.hostname || req.get("host"),
      env: process.env,
    })) {
      console.info(`[CSRF] Exempted public auth endpoint ${req.method} ${req.path}`);
      return next();
    }

    if (isFieldApiPath(req.path)) {
      if (!isValidFieldCsrfHeader(req.get(FIELD_CSRF_HEADER_NAME))) {
        res.status(403).json({ error: { message: "Missing required header for cross-origin request." } });
        return;
      }
      console.info(`[CSRF] Accepted field cross-origin header ${req.method} ${req.path}`);
      return next();
    }

    const requestOrigin = getRequestOrigin({
      origin: req.headers.origin,
      referer: req.headers.referer,
      referrer: req.headers.referrer,
    });

    if (!isAllowedCookieAuthOrigin(process.env, requestOrigin)) {
      res.status(403).json({ error: { message: "Forbidden origin" } });
      return;
    }

    const headerToken = req.get(CSRF_HEADER_NAME);
    if (!isValidCsrfPair(csrfToken, headerToken)) {
      res.status(403).json({ error: { message: "Invalid CSRF token" } });
      return;
    }

    next();
  });

  app.use((req, res, next) => {
    // Skip JSON parsing for direct file uploads (handled by express.raw on the route)
    if (req.path === "/api/files/upload-direct") return next();
    express.json({ limit: "10mb" })(req, res, next);
  });

  // API Documentation
  app.use("/api/docs", swaggerUi.serve, swaggerUi.setup(apiSpec, {
    customCss: '.swagger-ui .topbar { display: none }',
    customSiteTitle: "T Rock CRM API Docs",
  }));

  // Health check
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // SyncHub integration — authenticated by shared secret, no tenant scope
  app.use("/api/integrations/synchub", syncHubRoutes);

  // Public routes (no auth required for login endpoints)
  app.use("/api/auth", authRoutes);

  // Field app routes use field-contractor-only middleware and no tenant workspace transaction.
  app.use("/api/field", fieldRoutes);

  // Admin routes (auth required, no tenant context)
  app.use("/api/offices", authMiddleware, requireCrmUser, officeRoutes);

  // SSE notification endpoint (auth required, no tenant context needed for keepalive)
  app.use("/api/notifications", authMiddleware, requireCrmUser, notificationRoutes);

  // Migration routes (auth + admin required, no tenant scope — accesses migration schema directly)
  app.use("/api", migrationRouter);

  // Admin routes (offices, users, pipeline config, audit log)
  app.use("/api", adminPhotoTokenRoutes);
  app.use("/api", adminRoutes);

  // Tenant-scoped routes — auth + tenant middleware applied
  // All feature routes (deals, contacts, tasks, etc.) go through this chain
  const tenantRouter = Router();

  // Rate limit per authenticated user (mounted here so req.user is populated by authMiddleware)
  tenantRouter.use(apiLimiter);

  // Feature routes
  const crmOnlyTenantRoutes = [
    [CRM_ONLY_TENANT_ROUTE_MOUNTS[0], dealRoutes],
    [CRM_ONLY_TENANT_ROUTE_MOUNTS[1], pipelineRoutes],
    [CRM_ONLY_TENANT_ROUTE_MOUNTS[2], contactRoutes],
    [CRM_ONLY_TENANT_ROUTE_MOUNTS[3], leadRoutes],
    [CRM_ONLY_TENANT_ROUTE_MOUNTS[4], projectRoutes],
    [CRM_ONLY_TENANT_ROUTE_MOUNTS[5], emailRoutes],
    [CRM_ONLY_TENANT_ROUTE_MOUNTS[6], callRecordingRoutes],
    [CRM_ONLY_TENANT_ROUTE_MOUNTS[7], taskRoutes],
    [CRM_ONLY_TENANT_ROUTE_MOUNTS[8], userRoutes],
    [CRM_ONLY_TENANT_ROUTE_MOUNTS[9], activityRoutes],
    [CRM_ONLY_TENANT_ROUTE_MOUNTS[10], notificationCrudRoutes],
    [CRM_ONLY_TENANT_ROUTE_MOUNTS[11], reportRoutes],
    [CRM_ONLY_TENANT_ROUTE_MOUNTS[12], commissionRoutes],
    [CRM_ONLY_TENANT_ROUTE_MOUNTS[13], salesReviewRoutes],
    [CRM_ONLY_TENANT_ROUTE_MOUNTS[14], dashboardRoutes],
    [CRM_ONLY_TENANT_ROUTE_MOUNTS[15], procoreRoutes],
    [CRM_ONLY_TENANT_ROUTE_MOUNTS[16], searchRoutes],
    [CRM_ONLY_TENANT_ROUTE_MOUNTS[17], companyRoutes],
    [CRM_ONLY_TENANT_ROUTE_MOUNTS[18], propertyRoutes],
    [CRM_ONLY_TENANT_ROUTE_MOUNTS[19], companycamRoutes],
    [CRM_ONLY_TENANT_ROUTE_MOUNTS[20], aiCopilotRoutes],
    ["/usage", usageRoutes],
  ] as const;

  for (const [mount, routes] of crmOnlyTenantRoutes) {
    tenantRouter.use(mount, requireCrmUser, routes);
  }

  tenantRouter.use("/files", requireCrmUser, fileRoutes);

  // Foundation test route — proves tenant middleware works end-to-end
  tenantRouter.get("/tenant-check", requireCrmUser, async (req, res) => {
    const result = await req.tenantClient!.query("SELECT current_setting('search_path') as path, current_setting('app.current_user_id', true) as uid");
    await req.commitTransaction!();
    res.json({
      officeSlug: req.officeSlug,
      searchPath: result.rows[0].path,
      auditUserId: result.rows[0].uid,
    });
  });

  app.use("/api", authMiddleware, tenantMiddleware, tenantRouter);

  // Register Procore event handlers on the in-process event bus
  registerProcoreEventHandlers();

  // Initialize SSE push listeners for real-time notifications
  initSsePush();

  // Serve frontend static files in production
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const clientDist = join(__dirname, "../../client/dist");
  if (existsSync(clientDist)) {
    app.use(express.static(clientDist));
    // SPA fallback — serve index.html for non-API routes
    app.get("/{*path}", (_req, res) => {
      res.sendFile(join(clientDist, "index.html"));
    });
  }

  // Error handler (must be last)
  app.use(errorHandler);

  return app;
}
