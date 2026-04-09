import dotenv from "dotenv";
dotenv.config();

import http from "http";
import { startListener } from "./listener.js";
import { pollJobs, recoverStaleJobs } from "./queue.js";
import { registerAllJobs } from "./jobs/index.js";
import cron from "node-cron";
import { runStaleDealScan } from "./jobs/stale-deals.js";
import { runDedupScan } from "./jobs/dedup-scan.js";
import { runEmailSync } from "./jobs/email-sync.js";
import { runDailyTaskGeneration } from "./jobs/daily-tasks.js";
import { runActivityDropDetection } from "./jobs/activity-alerts.js";
import { runWeeklyDigest } from "./jobs/weekly-digest.js";
import { runColdLeadWarming } from "./jobs/cold-lead-warming.js";
import { runBidDeadlineCountdown } from "./jobs/bid-deadline.js";
import { runProcoreSync } from "./jobs/procore-sync.js";

const POLL_INTERVAL_MS = 2000; // Poll job queue every 2 seconds

async function main() {
  console.log("[Worker] Starting T Rock CRM Worker...");

  // Register job handlers
  registerAllJobs();

  // Recover stale jobs from previous crashes
  await recoverStaleJobs();

  // Start PG LISTEN for real-time events
  await startListener((event) => {
    console.log(`[Worker] Received event: ${event.name}`, {
      officeId: event.officeId,
      timestamp: event.timestamp,
    });
    // Event-specific handlers will be wired here as features are built
  });

  // Start job queue polling
  setInterval(pollJobs, POLL_INTERVAL_MS);
  console.log(`[Worker] Polling job queue every ${POLL_INTERVAL_MS}ms`);

  // Stale deal scan: daily at 6:00 AM CT
  cron.schedule("0 6 * * *", async () => {
    console.log("[Worker:cron] Running stale deal scan...");
    try {
      await runStaleDealScan();
    } catch (err) {
      console.error("[Worker:cron] Stale deal scan failed:", err);
    }
  }, { timezone: "America/Chicago" });
  console.log("[Worker] Cron scheduled: stale deal scan at 6:00 AM CT daily");

  // Contact dedup scan: weekly on Sunday at 2:00 AM CT
  cron.schedule("0 2 * * 0", async () => {
    console.log("[Worker:cron] Running contact dedup scan...");
    try {
      await runDedupScan();
    } catch (err) {
      console.error("[Worker:cron] Contact dedup scan failed:", err);
    }
  }, { timezone: "America/Chicago" });
  console.log("[Worker] Cron scheduled: contact dedup scan at 2:00 AM CT weekly (Sunday)");

  // Email sync: every 5 minutes
  cron.schedule("*/5 * * * *", async () => {
    console.log("[Worker:cron] Running email sync...");
    try {
      await runEmailSync();
    } catch (err) {
      console.error("[Worker:cron] Email sync failed:", err);
    }
  });
  console.log("[Worker] Cron scheduled: email sync every 5 minutes");

  // Daily task generation: daily at 6:00 AM CT (runs alongside stale deal scan)
  cron.schedule("0 6 * * *", async () => {
    console.log("[Worker:cron] Running daily task generation...");
    try {
      await runDailyTaskGeneration();
    } catch (err) {
      console.error("[Worker:cron] Daily task generation failed:", err);
    }
  }, { timezone: "America/Chicago" });
  console.log("[Worker] Cron scheduled: daily task generation at 6:00 AM CT daily");

  // Activity drop detection: daily at 7:00 AM CT
  cron.schedule("0 7 * * *", async () => {
    console.log("[Worker:cron] Running activity drop detection...");
    try {
      await runActivityDropDetection();
    } catch (err) {
      console.error("[Worker:cron] Activity drop detection failed:", err);
    }
  }, { timezone: "America/Chicago" });
  console.log("[Worker] Cron scheduled: activity drop detection at 7:00 AM CT daily");

  // Weekly digest: Monday at 7:00 AM CT
  cron.schedule("0 7 * * 1", async () => {
    console.log("[Worker:cron] Running weekly digest...");
    try {
      await runWeeklyDigest();
    } catch (err) {
      console.error("[Worker:cron] Weekly digest failed:", err);
    }
  }, { timezone: "America/Chicago" });
  console.log("[Worker] Cron scheduled: weekly digest at 7:00 AM CT every Monday");

  // Cold lead warming: daily at 6:15 AM CT (after daily task generation)
  cron.schedule("15 6 * * *", async () => {
    console.log("[Worker:cron] Running cold lead warming...");
    try {
      await runColdLeadWarming();
    } catch (err) {
      console.error("[Worker:cron] Cold lead warming failed:", err);
    }
  }, { timezone: "America/Chicago" });
  console.log("[Worker] Cron scheduled: cold lead warming at 6:15 AM CT daily");

  // Bid deadline countdown: daily at 6:30 AM CT
  cron.schedule("30 6 * * *", async () => {
    console.log("[Worker:cron] Running bid deadline countdown...");
    try {
      await runBidDeadlineCountdown();
    } catch (err) {
      console.error("[Worker:cron] Bid deadline countdown failed:", err);
    }
  }, { timezone: "America/Chicago" });
  console.log("[Worker] Cron scheduled: bid deadline countdown at 6:30 AM CT daily");

  // Procore sync poll: every 15 minutes
  cron.schedule("*/15 * * * *", async () => {
    console.log("[Worker:cron] Running Procore sync poll...");
    try {
      await runProcoreSync();
    } catch (err) {
      console.error("[Worker:cron] Procore sync poll failed:", err);
    }
  });
  console.log("[Worker] Cron scheduled: Procore sync poll every 15 minutes");

  console.log("[Worker] Ready.");
}

// Health check server for Railway
const healthServer = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", timestamp: new Date().toISOString() }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

const HEALTH_PORT = parseInt(process.env.WORKER_HEALTH_PORT || "3002", 10);
healthServer.listen(HEALTH_PORT, () => {
  console.log(`[Worker] Health check on port ${HEALTH_PORT}`);
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("[Worker] SIGTERM received, shutting down gracefully...");
  cron.getTasks().forEach((task) => task.stop());
  healthServer.close(() => {
    console.log("[Worker] Health server closed.");
    process.exit(0);
  });
});

main().catch((err) => {
  console.error("[Worker] Fatal error:", err);
  process.exit(1);
});
