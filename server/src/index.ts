import dotenv from "dotenv";
dotenv.config();

import { createApp } from "./app.js";
import { configureR2Cors, getAllowedR2CorsOrigins } from "./lib/r2-client.js";
import { pool } from "./db.js";
import {
  assertSafeDevAuthConfig,
  getDevAuthProductionWarning,
} from "./modules/auth/http-config.js";

assertSafeDevAuthConfig(process.env);
const devAuthProductionWarning = getDevAuthProductionWarning(process.env);
if (devAuthProductionWarning) console.warn(devAuthProductionWarning);

const PORT = parseInt(process.env.PORT || "3001", 10);
const app = createApp();

const server = app.listen(PORT, () => {
  console.log(`[API] T Rock CRM server running on port ${PORT}`);

  // Configure R2 CORS for browser uploads (idempotent, runs once on startup)
  configureR2Cors(getAllowedR2CorsOrigins());
});

function gracefulShutdown(signal: string) {
  console.log(`[API] Received ${signal}, shutting down gracefully...`);
  server.close(async () => {
    console.log("[API] HTTP server closed");
    try {
      await pool.end();
      console.log("[API] Database pool closed");
    } catch (err) {
      console.error("[API] Error closing pool:", err);
    }
    process.exit(0);
  });
  // Force exit after 15 seconds
  setTimeout(() => {
    console.error("[API] Forced shutdown after timeout");
    process.exit(1);
  }, 15000);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
