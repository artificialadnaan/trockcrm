import express, { Router } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { errorHandler } from "./middleware/error-handler.js";
import { apiLimiter } from "./middleware/rate-limit.js";
import { authRoutes } from "./modules/auth/routes.js";
import { officeRoutes } from "./modules/office/routes.js";
import { notificationRoutes } from "./modules/notifications/routes.js";
import { authMiddleware } from "./middleware/auth.js";
import { tenantMiddleware } from "./middleware/tenant.js";
import { dealRoutes } from "./modules/deals/routes.js";
import { pipelineRoutes } from "./modules/pipeline/routes.js";
import { contactRoutes } from "./modules/contacts/routes.js";
import { emailRoutes } from "./modules/email/routes.js";
import { fileRoutes } from "./modules/files/routes.js";
import { taskRoutes } from "./modules/tasks/routes.js";
import { activityRoutes } from "./modules/activities/routes.js";
import { notificationCrudRoutes } from "./modules/notifications/crud-routes.js";
import { reportRoutes } from "./modules/reports/routes.js";
import { dashboardRoutes } from "./modules/dashboard/routes.js";
import { initSsePush } from "./modules/notifications/sse-manager.js";
import { procoreRoutes } from "./modules/procore/routes.js";
import { procoreWebhookRoutes } from "./modules/procore/webhook-routes.js";
import { syncHubRoutes } from "./modules/procore/synchub-routes.js";
import { registerProcoreEventHandlers } from "./modules/procore/event-handlers.js";
import { migrationRouter } from "./modules/migration/routes.js";
import { searchRoutes } from "./modules/search/routes.js";
import { companyRoutes } from "./modules/companies/routes.js";
import { adminRoutes } from "./modules/admin/routes.js";

export function createApp() {
  const app = express();

  // Core middleware
  app.use(cors({
    origin: process.env.FRONTEND_URL || "http://localhost:5173",
    credentials: true,
  }));

  // Procore webhook route — public (signature-verified, no JWT).
  // MUST be mounted BEFORE express.json() so the raw body is available for
  // HMAC signature verification. The route uses express.raw() internally.
  app.use("/api/webhooks/procore", procoreWebhookRoutes);

  app.use(express.json({ limit: "10mb" }));
  app.use(cookieParser());
  app.use("/api", apiLimiter);

  // Health check
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // SyncHub integration — authenticated by shared secret, no tenant scope
  app.use("/api/integrations/synchub", syncHubRoutes);

  // Public routes (no auth required for login endpoints)
  app.use("/api/auth", authRoutes);

  // Admin routes (auth required, no tenant context)
  app.use("/api/offices", officeRoutes);

  // SSE notification endpoint (auth required, no tenant context needed for keepalive)
  app.use("/api/notifications", notificationRoutes);

  // Migration routes (auth + admin required, no tenant scope — accesses migration schema directly)
  app.use("/api", migrationRouter);

  // Admin routes (offices, users, pipeline config, audit log)
  app.use("/api", adminRoutes);

  // Tenant-scoped routes — auth + tenant middleware applied
  // All feature routes (deals, contacts, tasks, etc.) go through this chain
  const tenantRouter = Router();

  // Feature routes
  tenantRouter.use("/deals", dealRoutes);
  tenantRouter.use("/pipeline", pipelineRoutes);
  tenantRouter.use("/contacts", contactRoutes);
  tenantRouter.use("/email", emailRoutes);
  tenantRouter.use("/files", fileRoutes);
  tenantRouter.use("/tasks", taskRoutes);
  tenantRouter.use("/activities", activityRoutes);
  tenantRouter.use("/notifications", notificationCrudRoutes);
  tenantRouter.use("/reports", reportRoutes);
  tenantRouter.use("/dashboard", dashboardRoutes);
  tenantRouter.use("/procore", procoreRoutes);
  tenantRouter.use("/search", searchRoutes);
  tenantRouter.use("/companies", companyRoutes);

  // Foundation test route — proves tenant middleware works end-to-end
  tenantRouter.get("/tenant-check", async (req, res) => {
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
