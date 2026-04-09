import dotenv from "dotenv";
dotenv.config();

import { createApp } from "./app.js";
import { configureR2Cors } from "./lib/r2-client.js";
import { pool } from "./db.js";

const PORT = parseInt(process.env.PORT || "3001", 10);
const app = createApp();

const server = app.listen(PORT, () => {
  console.log(`[API] T Rock CRM server running on port ${PORT}`);

  // Configure R2 CORS for browser uploads (idempotent, runs once on startup)
  const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";
  configureR2Cors([frontendUrl, "http://localhost:5173", "http://localhost:3000"]);
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
