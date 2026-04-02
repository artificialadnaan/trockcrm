import { registerJobHandler } from "../queue.js";
import { runStaleDealScan } from "./stale-deals.js";
import { runDedupScan } from "./dedup-scan.js";
import { runEmailSync } from "./email-sync.js";
import { extractExif } from "./exif-extract.js";
import { runDailyTaskGeneration } from "./daily-tasks.js";

/**
 * Test handler that logs the payload. Used to validate the queue works end-to-end.
 * Insert a test job: INSERT INTO job_queue (job_type, payload) VALUES ('test_echo', '{"message":"hello"}');
 */
async function handleTestEcho(payload: any, officeId: string | null): Promise<void> {
  console.log(`[Worker:test_echo] Received payload:`, JSON.stringify(payload));
  console.log(`[Worker:test_echo] Office ID: ${officeId ?? "none"}`);
  // Simulate some work
  await new Promise((resolve) => setTimeout(resolve, 100));
  console.log(`[Worker:test_echo] Done.`);
}

/**
 * Generic domain event handler. emitRemote() writes all cross-process events
 * with job_type = 'domain_event'. This handler dispatches by eventName in payload.
 * Unknown events are logged and completed (not marked dead) — real handlers
 * are added as each feature plan is implemented.
 */
const domainEventHandlers = new Map<string, (payload: any, officeId: string | null) => Promise<void>>();

async function handleDomainEvent(payload: any, officeId: string | null): Promise<void> {
  const eventName = payload.eventName;
  console.log(`[Worker:domain_event] Received: ${eventName}`);

  const handler = domainEventHandlers.get(eventName);
  if (handler) {
    await handler(payload, officeId);
  } else {
    console.log(`[Worker:domain_event] No handler for '${eventName}' yet — completing without action`);
  }
}

export function registerAllJobs() {
  registerJobHandler("test_echo", handleTestEcho);
  registerJobHandler("domain_event", handleDomainEvent);

  // Stale deal scanner (triggered via job_queue or cron)
  registerJobHandler("stale_deal_scan", async () => {
    await runStaleDealScan();
  });

  // Contact dedup scanner (triggered via job_queue or cron)
  registerJobHandler("dedup_scan", async () => {
    await runDedupScan();
  });

  // Email sync (triggered via job_queue or cron)
  registerJobHandler("email_sync", async () => {
    await runEmailSync();
  });

  // Daily task generation (triggered via job_queue or cron)
  registerJobHandler("daily_task_generation", async () => {
    await runDailyTaskGeneration();
  });

  // Domain event handlers for deal lifecycle
  domainEventHandlers.set("deal.won", async (payload, officeId) => {
    console.log(`[Worker] Deal won: ${payload.dealNumber} (${payload.dealName}) - amount: ${payload.awardedAmount}`);
    // Future: Procore project creation, congratulations notification
  });

  domainEventHandlers.set("deal.lost", async (payload, officeId) => {
    console.log(`[Worker] Deal lost: ${payload.dealNumber} (${payload.dealName}) - reason: ${payload.lostReasonId}`);
    // Future: Lost deal analytics, competitor tracking
  });

  domainEventHandlers.set("deal.stage.changed", async (payload, officeId) => {
    console.log(`[Worker] Stage changed: ${payload.dealNumber} from ${payload.fromStageName} to ${payload.toStageName}`);
    // Future: Procore status sync, stage change email notifications
  });

  domainEventHandlers.set("contact.created", async (payload, officeId) => {
    console.log(`[Worker] contact.created: ${payload.contactId}`);
    // Future: trigger welcome email, HubSpot sync, etc.
  });

  // Domain event: email.received -> create notification for rep
  domainEventHandlers.set("email.received", async (payload, _officeId) => {
    console.log(`[Worker] email.received: from ${payload.fromAddress} — subject: ${payload.subject}`);

    // Task creation is handled inline during sync (see email-sync.ts processInboundMessage).
    // This handler creates a notification for the user.
    if (!payload.userId) return;

    const { pool: workerPool } = await import("../db.js");
    const userResult = await workerPool.query(
      "SELECT office_id FROM public.users WHERE id = $1",
      [payload.userId]
    );
    if (userResult.rows.length === 0) return;

    const officeResult = await workerPool.query(
      "SELECT slug FROM public.offices WHERE id = $1 AND is_active = true",
      [userResult.rows[0].office_id]
    );
    if (officeResult.rows.length === 0) return;

    const slug = officeResult.rows[0].slug;
    const slugRegex = /^[a-z][a-z0-9_]*$/;
    if (!slugRegex.test(slug)) return;

    const schemaName = `office_${slug}`;

    // Create notification for the rep
    await workerPool.query(
      `INSERT INTO ${schemaName}.notifications (user_id, type, title, body, link)
       VALUES ($1, 'inbound_email', $2, $3, $4)`,
      [
        payload.userId,
        `New email from ${payload.contactName || payload.fromAddress}`,
        payload.subject?.substring(0, 200) ?? "New email",
        "/email", // Link to inbox page — no per-email route exists yet
      ]
    );
  });

  domainEventHandlers.set("email.sent", async (payload, _officeId) => {
    console.log(`[Worker] email.sent: to ${payload.to?.join(", ")} — subject: ${payload.subject}`);
    // Future: update contact touchpoint count, last_contacted_at
  });

  // Domain event: file.uploaded -> extract EXIF metadata for photo files
  domainEventHandlers.set("file.uploaded", async (payload, officeId) => {
    console.log(`[Worker] file.uploaded: ${payload.fileId} (category: ${payload.category})`);
    if (payload.category === "photo") {
      await extractExif(payload.fileId, officeId, {
        r2Key: payload.r2Key,
        mimeType: payload.mimeType,
        category: payload.category,
      });
    }
  });

  console.log("[Worker] Job handlers registered:", ["test_echo", "domain_event", "stale_deal_scan", "dedup_scan", "email_sync", "daily_task_generation"].join(", "));
}

export { domainEventHandlers };
