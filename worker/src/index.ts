import dotenv from "dotenv";
dotenv.config();

import { startListener } from "./listener.js";
import { pollJobs, recoverStaleJobs } from "./queue.js";
import { registerAllJobs } from "./jobs/index.js";
import cron from "node-cron";
import { runStaleDealScan } from "./jobs/stale-deals.js";

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

  console.log("[Worker] Ready.");
}

main().catch((err) => {
  console.error("[Worker] Fatal error:", err);
  process.exit(1);
});
