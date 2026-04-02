import dotenv from "dotenv";
dotenv.config();

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

  console.log("[Worker] Ready.");
}

main().catch((err) => {
  console.error("[Worker] Fatal error:", err);
  process.exit(1);
});
