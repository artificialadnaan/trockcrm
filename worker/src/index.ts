import dotenv from "dotenv";
dotenv.config();

import http from "http";
import { startListener } from "./listener.js";
import { pollBidBoardIngestJobs, pollJobs, recoverStaleJobs } from "./queue.js";
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
import { runProcoreSync, runScheduledCatalogSync } from "./jobs/procore-sync.js";
import { runPortfolioValueRefresh } from "./jobs/portfolio-value-refresh.js";
import { runAiDisconnectDigest } from "./jobs/ai-disconnect-digest.js";
import { runAiDisconnectEscalationScan } from "./jobs/ai-disconnect-escalation.js";
import { runAiDisconnectAdminTaskGeneration } from "./jobs/ai-disconnect-admin-tasks.js";
import { runAiInterventionManagerAlerts } from "./jobs/ai-intervention-manager-alerts.js";
import { runRfpPendingSlaScan } from "./jobs/rfp-pending-sla.js";
import { runCallRecordingCleanup } from "./jobs/call-recording-cleanup.js";
import { runCallRecordingTranscription } from "./jobs/call-recording-transcribe.js";
import { runRfpRequestDeadLetterSweep } from "./jobs/rfp-request-delivery.js";
import {
  runRfpBidBoardCreateDeadLetterSweep,
  runRfpBidBoardCreateStuckDealSweep,
} from "./jobs/rfp-bidboard-create.js";
import { runRfpVoteInvitationDeadLetterSweep } from "./jobs/rfp-vote-invitation.js";
import { runReportsExecutionTick } from "./jobs/reports-execution.js";
import { runRepPerformanceRollup } from "./jobs/rep-performance-rollup.js";
import { runBidBoardIngestInboxRecovery } from "./jobs/bid-board-ingest.js";
import { runCorrectiveActionUploadJanitor } from "./jobs/corrective-action-upload-janitor.js";

const POLL_INTERVAL_MS = 2000; // Poll job queue every 2 seconds
const RFP_DEAD_LETTER_SWEEP_INTERVAL_MS = 60000;
const CALL_RECORDING_TRANSCRIPTION_INTERVAL_MS = parseInt(
  process.env.CALL_RECORDING_TRANSCRIPTION_INTERVAL_MS || "60000",
  10
);

async function main() {
  console.log("[Worker] Starting T Rock CRM Worker...");

  // Register job handlers
  registerAllJobs();

  // Recover stale jobs from previous crashes
  await recoverStaleJobs();

  // Re-enqueue any Bid Board ingestion inbox rows left orphaned by a crash between accept + enqueue, or a
  // worker death mid-import (never throws).
  await runBidBoardIngestInboxRecovery();

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

  // Dedicated poller for the long-running bid_board_ingest import, on its OWN reentrancy guard: a multi-minute
  // import must not hold the main poller's guard across its run phase and stall email/domain-event/delivery
  // jobs. pollJobs excludes bid_board_ingest; this poller claims only that type (one at a time).
  setInterval(pollBidBoardIngestJobs, POLL_INTERVAL_MS);
  console.log(`[Worker] Polling bid_board_ingest queue every ${POLL_INTERVAL_MS}ms (dedicated)`);

  setInterval(async () => {
    try {
      const handled = await runRfpRequestDeadLetterSweep();
      if (handled > 0) {
        console.log(`[Worker:rfp_request_delivery] Marked ${handled} dead delivery job(s) as send_failed`);
      }
    } catch (err) {
      console.error("[Worker:rfp_request_delivery] Dead-letter sweep failed:", err);
    }
    try {
      const handledCreates = await runRfpBidBoardCreateDeadLetterSweep();
      if (handledCreates > 0) {
        console.log(`[Worker:rfp_bidboard_create] Marked ${handledCreates} dead Bid Board create job(s) as override 'failed'`);
      }
    } catch (err) {
      console.error("[Worker:rfp_bidboard_create] Dead-letter sweep failed:", err);
    }
    // Deal-keyed watchdog: recover deals the per-JOB sweep above marked dealHandled='true' but never actually
    // flipped (its deal UPDATE matched 0 rows), which are otherwise orphaned in "creating Bid Board…" forever.
    try {
      const flippedStuck = await runRfpBidBoardCreateStuckDealSweep();
      if (flippedStuck > 0) {
        console.log(`[Worker:rfp_bidboard_create] Stuck-deal sweep flipped ${flippedStuck} orphaned deal(s) to send_failed`);
      }
    } catch (err) {
      console.error("[Worker:rfp_bidboard_create] Stuck-deal sweep failed:", err);
    }
    try {
      const handledInvites = await runRfpVoteInvitationDeadLetterSweep();
      if (handledInvites > 0) {
        console.log(`[Worker:rfp_vote_invitation] Marked ${handledInvites} stranded vote round(s) as send_failed (recoverable)`);
      }
    } catch (err) {
      console.error("[Worker:rfp_vote_invitation] Dead-letter sweep failed:", err);
    }
    // Re-enqueue orphaned Bid Board ingestion inbox rows (self-healing; never throws).
    await runBidBoardIngestInboxRecovery();
  }, RFP_DEAD_LETTER_SWEEP_INTERVAL_MS);
  console.log(`[Worker] RFP dead-letter sweeps (request delivery + Bid Board create + vote invitation) every ${RFP_DEAD_LETTER_SWEEP_INTERVAL_MS}ms`);

  setInterval(async () => {
    try {
      await runCallRecordingTranscription();
    } catch (err) {
      console.error("[Worker:call-recordings] Transcription poll failed:", err);
    }
  }, CALL_RECORDING_TRANSCRIPTION_INTERVAL_MS);
  console.log(`[Worker] Call recording transcription poll every ${CALL_RECORDING_TRANSCRIPTION_INTERVAL_MS}ms`);

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

  // Call recording retention cleanup: daily at 3:30 AM CT
  cron.schedule("30 3 * * *", async () => {
    console.log("[Worker:cron] Running call recording cleanup...");
    try {
      await runCallRecordingCleanup();
    } catch (err) {
      console.error("[Worker:cron] Call recording cleanup failed:", err);
    }
  }, { timezone: "America/Chicago" });
  console.log("[Worker] Cron scheduled: call recording cleanup at 3:30 AM CT daily");

  // Corrective-action abandoned-upload janitor: daily at 3:45 AM CT. Reclaims STALE, UNATTACHED
  // corrective-action response uploads (a scorecard_corrective_action_uploads ledger row whose file has no
  // field_scorecard_photos link and is older than the threshold) that the client's unreliable browser-side
  // discard missed — soft-deletes the file + removes the ledger row, per active office, best-effort + logged.
  cron.schedule("45 3 * * *", async () => {
    console.log("[Worker:cron] Running corrective-action upload janitor...");
    try {
      const { reclaimed, officesSwept } = await runCorrectiveActionUploadJanitor();
      console.log(
        `[Worker:cron] Corrective-action upload janitor reclaimed ${reclaimed} upload(s) across ${officesSwept} office(s)`
      );
    } catch (err) {
      console.error("[Worker:cron] Corrective-action upload janitor failed:", err);
    }
  }, { timezone: "America/Chicago" });
  console.log("[Worker] Cron scheduled: corrective-action upload janitor at 3:45 AM CT daily");

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

  // Public Procore cost catalog refresh: every 6 hours at minute 7
  cron.schedule("7 */6 * * *", async () => {
    console.log("[Worker:cron] Running public Procore catalog refresh...");
    try {
      await runScheduledCatalogSync();
    } catch (err) {
      console.error("[Worker:cron] Public Procore catalog refresh failed:", err);
    }
  });
  console.log("[Worker] Cron scheduled: public Procore catalog refresh every 6 hours");

  // Portfolio Contract Value refresh: every 4 hours at minute 23.
  // Pulls SyncHub Procore values (public.procore_projects) into office_*.portfolio_projects
  // (total_value / value_synced_at) so the Projects board Contract Values stay well within
  // the client's 7-day staleness window. Cross-DB read — needs SYNCHUB_DATABASE_URL /
  // SYNCHUB_DATABASE_PUBLIC_URL on the worker; the job skips (logs) when it is unset and
  // never throws, so a SyncHub outage cannot take down the worker or its other crons.
  cron.schedule("23 */4 * * *", async () => {
    console.log("[Worker:cron] Running portfolio value refresh...");
    try {
      await runPortfolioValueRefresh();
    } catch (err) {
      console.error("[Worker:cron] Portfolio value refresh failed:", err);
    }
  });
  console.log("[Worker] Cron scheduled: portfolio value refresh every 4 hours");

  // Reports execution stub: every 5 minutes. Real execution is post-rollout.
  cron.schedule("*/5 * * * *", async () => {
    console.log("[Worker:cron] Running reports execution stub...");
    try {
      await runReportsExecutionTick();
    } catch (err) {
      console.error("[Worker:cron] Reports execution stub failed:", err);
    }
  });
  console.log("[Worker] Cron scheduled: reports execution stub every 5 minutes");

  // Disconnect digest: weekdays at 7:15 AM CT
  cron.schedule("15 7 * * 1-5", async () => {
    console.log("[Worker:cron] Running disconnect digest...");
    try {
      await runAiDisconnectDigest();
    } catch (err) {
      console.error("[Worker:cron] Disconnect digest failed:", err);
    }
  }, { timezone: "America/Chicago" });
  console.log("[Worker] Cron scheduled: disconnect digest at 7:15 AM CT weekdays");

  // Disconnect admin tasks: weekdays at 7:30 AM CT
  cron.schedule("30 7 * * 1-5", async () => {
    console.log("[Worker:cron] Running disconnect admin task generation...");
    try {
      await runAiDisconnectAdminTaskGeneration();
    } catch (err) {
      console.error("[Worker:cron] Disconnect admin task generation failed:", err);
    }
  }, { timezone: "America/Chicago" });
  console.log("[Worker] Cron scheduled: disconnect admin task generation at 7:30 AM CT weekdays");

  // Disconnect escalation scan: weekdays at 7:45 AM CT
  cron.schedule("45 7 * * 1-5", async () => {
    console.log("[Worker:cron] Running disconnect escalation scan...");
    try {
      await runAiDisconnectEscalationScan();
    } catch (err) {
      console.error("[Worker:cron] Disconnect escalation scan failed:", err);
    }
  }, { timezone: "America/Chicago" });
  console.log("[Worker] Cron scheduled: disconnect escalation scan at 7:45 AM CT weekdays");

  // Rep performance snapshots: daily at 4:00 AM CT
  cron.schedule("0 4 * * *", async () => {
    console.log("[Worker:cron] Running rep performance rollup...");
    try {
      await runRepPerformanceRollup();
    } catch (err) {
      console.error("[Worker:cron] Rep performance rollup failed:", err);
    }
  }, { timezone: "America/Chicago" });
  console.log("[Worker] Cron scheduled: rep performance rollup at 4:00 AM CT daily");

  // Pending RFP 24h SLA: hourly scan that emails leadership once per pending cycle when an RFP has been
  // awaiting approval > 24h. Inert until RFP_PENDING_SLA_ENABLED=true (the job self-gates); a receipts
  // ledger keeps it exactly-once, so scanning hourly never double-sends.
  cron.schedule("0 * * * *", async () => {
    console.log("[Worker:cron] Running pending RFP SLA scan...");
    try {
      await runRfpPendingSlaScan();
    } catch (err) {
      console.error("[Worker:cron] Pending RFP SLA scan failed:", err);
    }
  }, { timezone: "America/Chicago" });
  console.log("[Worker] Cron scheduled: pending RFP SLA scan hourly");

  // Manager alerts: evaluate every 5 minutes and let office-local due gating decide when to send.
  cron.schedule("*/5 * * * *", async () => {
    console.log("[Worker:cron] Running intervention manager alerts...");
    try {
      await runAiInterventionManagerAlerts();
    } catch (err) {
      console.error("[Worker:cron] Intervention manager alerts failed:", err);
    }
  });
  console.log("[Worker] Cron scheduled: intervention manager alerts every 5 minutes");

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
