import dotenv from "dotenv";
dotenv.config();

import { startListener } from "./listener.js";
import { pollJobs, recoverStaleJobs } from "./queue.js";
import { registerAllJobs } from "./jobs/index.js";

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

  console.log("[Worker] Ready.");
}

main().catch((err) => {
  console.error("[Worker] Fatal error:", err);
  process.exit(1);
});
