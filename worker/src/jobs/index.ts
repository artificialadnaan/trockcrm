import { registerJobHandler } from "../queue.js";
import { runStaleDealScan } from "./stale-deals.js";
import { runDedupScan } from "./dedup-scan.js";
import { runEmailSync } from "./email-sync.js";
import { extractExif } from "./exif-extract.js";
import { runDailyTaskGeneration } from "./daily-tasks.js";
import { runActivityDropDetection } from "./activity-alerts.js";
import { runWeeklyDigest } from "./weekly-digest.js";

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

  // Activity drop detection (triggered via job_queue or cron)
  registerJobHandler("activity_drop_detection", async () => {
    await runActivityDropDetection();
  });

  // Weekly digest (triggered via job_queue or cron)
  registerJobHandler("weekly_digest", async () => {
    await runWeeklyDigest();
  });

  // Domain event handlers for deal lifecycle
  domainEventHandlers.set("deal.won", async (payload, officeId) => {
    console.log(`[Worker] Deal won: ${payload.dealNumber} (${payload.dealName}) - amount: ${payload.awardedAmount}`);
    // Future: Procore project creation, congratulations notification

    // --- Cross-sell alert ---
    try {
      const { pool: workerPool } = await import("../db.js");

      // Resolve office from assignedRepId if officeId is null
      let resolvedOfficeId = officeId;
      if (!resolvedOfficeId && payload.assignedRepId) {
        const userRes = await workerPool.query(
          "SELECT office_id FROM public.users WHERE id = $1",
          [payload.assignedRepId]
        );
        resolvedOfficeId = userRes.rows[0]?.office_id ?? null;
      }
      if (!resolvedOfficeId) {
        console.log("[Worker:cross-sell] Cannot resolve office — skipping cross-sell check");
        return;
      }

      // Get office slug
      const officeRes = await workerPool.query(
        "SELECT slug FROM public.offices WHERE id = $1 AND is_active = true",
        [resolvedOfficeId]
      );
      if (officeRes.rows.length === 0) return;

      const slug = officeRes.rows[0].slug;
      const slugRegex = /^[a-z][a-z0-9_]*$/;
      if (!slugRegex.test(slug)) return;

      const schemaName = `office_${slug}`;

      // Get the won deal's project_type_id and primary contact's company_name
      const dealRes = await workerPool.query(
        `SELECT d.project_type_id, d.primary_contact_id, c.company_name
         FROM ${schemaName}.deals d
         LEFT JOIN ${schemaName}.contact_deal_associations cda
           ON cda.deal_id = d.id AND cda.is_primary = true
         LEFT JOIN ${schemaName}.contacts c
           ON c.id = cda.contact_id
         WHERE d.id = $1`,
        [payload.dealId]
      );

      if (dealRes.rows.length === 0) return;

      const { project_type_id, company_name } = dealRes.rows[0];
      if (!project_type_id || !company_name) {
        console.log("[Worker:cross-sell] Deal missing project_type_id or company_name — skipping");
        return;
      }

      // Find all active project types that are NOT the won deal's type
      const allTypesRes = await workerPool.query(
        `SELECT id, name, parent_id FROM public.project_type_config
         WHERE is_active = true AND id != $1`,
        [project_type_id]
      );

      if (allTypesRes.rows.length === 0) return;

      // Check which project types the company already has deals in
      const existingTypesRes = await workerPool.query(
        `SELECT DISTINCT d.project_type_id
         FROM ${schemaName}.deals d
         JOIN ${schemaName}.contact_deal_associations cda ON cda.deal_id = d.id
         JOIN ${schemaName}.contacts c ON c.id = cda.contact_id
         WHERE c.company_name = $1
           AND d.project_type_id IS NOT NULL
           AND d.is_active = true`,
        [company_name]
      );

      const existingTypeIds = new Set(
        existingTypesRes.rows.map((r: any) => r.project_type_id)
      );

      // Find untapped project types
      const untappedTypes = allTypesRes.rows.filter(
        (pt: any) => !existingTypeIds.has(pt.id)
      );

      if (untappedTypes.length === 0) {
        console.log("[Worker:cross-sell] No untapped project types for", company_name);
        return;
      }

      // Create a cross-sell task for each untapped type (limit to top 3 to avoid noise)
      const tasksToCreate = untappedTypes.slice(0, 3);
      for (const pt of tasksToCreate) {
        // Check if a cross-sell task already exists for this company + project type
        const existingTask = await workerPool.query(
          `SELECT id FROM ${schemaName}.tasks
           WHERE type = 'system'
             AND title LIKE $1
             AND status IN ('pending', 'in_progress')
           LIMIT 1`,
          [`%${pt.name}%${company_name}%`]
        );

        if (existingTask.rows.length > 0) continue;

        const dueDate = new Date();
        dueDate.setDate(dueDate.getDate() + 14);

        await workerPool.query(
          `INSERT INTO ${schemaName}.tasks
           (title, description, type, priority, status, assigned_to, deal_id, due_date)
           VALUES ($1, $2, 'system', 'normal', 'pending', $3, $4, $5)`,
          [
            `Explore ${pt.name} opportunities with ${company_name}`,
            `${company_name} just won deal "${payload.dealName}" (${payload.dealNumber}). Consider cross-selling ${pt.name} services.`,
            payload.assignedRepId,
            payload.dealId,
            dueDate.toISOString().split("T")[0],
          ]
        );

        console.log(`[Worker:cross-sell] Created task: Explore ${pt.name} with ${company_name}`);
      }
    } catch (err) {
      console.error("[Worker:cross-sell] Error:", err);
      // Non-blocking — don't re-throw
    }
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

  // Domain event: task.assigned -> create notification for assignee
  domainEventHandlers.set("task.assigned", async (payload, _officeId) => {
    console.log(`[Worker] task.assigned: ${payload.taskId} — ${payload.title}`);

    if (!payload.assignedTo) return;

    const { pool: workerPool } = await import("../db.js");
    const userResult = await workerPool.query(
      "SELECT office_id FROM public.users WHERE id = $1",
      [payload.assignedTo]
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

    await workerPool.query(
      `INSERT INTO ${schemaName}.notifications (user_id, type, title, body, link)
       VALUES ($1, 'task_assigned', $2, $3, $4)`,
      [
        payload.assignedTo,
        `New task assigned: ${payload.title}`,
        payload.title,
        "/tasks",
      ]
    );
  });

  // Domain event: task.completed -> create activity record
  domainEventHandlers.set("task.completed", async (payload, _officeId) => {
    console.log(`[Worker] task.completed: ${payload.taskId} — ${payload.title}`);

    // Create a task_completed activity
    if (!payload.completedBy) return;

    const { pool: workerPool } = await import("../db.js");
    const userResult = await workerPool.query(
      "SELECT office_id FROM public.users WHERE id = $1",
      [payload.completedBy]
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

    await workerPool.query(
      `INSERT INTO ${schemaName}.activities
       (type, user_id, deal_id, contact_id, subject, occurred_at)
       VALUES ('task_completed', $1, $2, $3, $4, NOW())`,
      [
        payload.completedBy,
        payload.dealId ?? null,
        payload.contactId ?? null,
        `Completed: ${payload.title}`,
      ]
    );
  });

  domainEventHandlers.set("ai.suggest_action", async (payload, officeId) => {
    console.log("[Worker] ai.suggest_action (Phase 2 stub):", payload);
    // Phase 2: Will call Claude API to analyze deal stage, contact touchpoints,
    // and email history to suggest the optimal next action for the rep
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

  console.log("[Worker] Job handlers registered:", ["test_echo", "domain_event", "stale_deal_scan", "dedup_scan", "email_sync", "daily_task_generation", "activity_drop_detection", "weekly_digest"].join(", "));
}

export { domainEventHandlers };
