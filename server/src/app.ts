import express, { Router } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
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

export function createApp() {
  const app = express();

  // Core middleware
  app.use(cors({
    origin: process.env.FRONTEND_URL || "http://localhost:5173",
    credentials: true,
  }));
  app.use(express.json({ limit: "10mb" }));
  app.use(cookieParser());
  app.use("/api", apiLimiter);

  // Health check
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // Public routes (no auth required for login endpoints)
  app.use("/api/auth", authRoutes);

  // Admin routes (auth required, no tenant context)
  app.use("/api/offices", officeRoutes);

  // SSE notification endpoint (auth required, no tenant context needed for keepalive)
  app.use("/api/notifications", notificationRoutes);

  // Tenant-scoped routes — auth + tenant middleware applied
  // All feature routes (deals, contacts, tasks, etc.) go through this chain
  const tenantRouter = Router();

  // Feature routes
  tenantRouter.use("/deals", dealRoutes);
  tenantRouter.use("/pipeline", pipelineRoutes);
  tenantRouter.use("/contacts", contactRoutes);
  tenantRouter.use("/email", emailRoutes);
  tenantRouter.use("/files", fileRoutes);

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

  // Error handler (must be last)
  app.use(errorHandler);

  return app;
}
