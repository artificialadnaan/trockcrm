import { registerJobHandler } from "../queue.js";
import { runStaleDealScan } from "./stale-deals.js";
import { runDedupScan } from "./dedup-scan.js";
import { runEmailSync } from "./email-sync.js";
import { extractExif } from "./exif-extract.js";
import { runDailyTaskGeneration } from "./daily-tasks.js";
import { runActivityDropDetection } from "./activity-alerts.js";
import { runWeeklyDigest } from "./weekly-digest.js";
import { runColdLeadWarming } from "./cold-lead-warming.js";
import { runBidDeadlineCountdown } from "./bid-deadline.js";
import { addBusinessDays } from "../utils/date-helpers.js";
import { handleProcoreSyncJob, handleProcoreWebhookJob, runProcoreSync } from "./procore-sync.js";

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

  // Cold lead warming (triggered via job_queue or cron)
  registerJobHandler("cold_lead_warming", async () => {
    await runColdLeadWarming();
  });

  // Bid deadline countdown (triggered via job_queue or cron)
  registerJobHandler("bid_deadline_countdown", async () => {
    await runBidDeadlineCountdown();
  });

  // Procore sync job (dispatched by event handlers in the API server)
  registerJobHandler("procore_sync", async (payload) => {
    await handleProcoreSyncJob(payload);
  });

  // Procore webhook processing (dispatched by webhook receiver)
  registerJobHandler("procore_webhook", async (payload) => {
    await handleProcoreWebhookJob(payload);
  });

  // Procore periodic poll (triggered via cron)
  registerJobHandler("procore_poll", async () => {
    await runProcoreSync();
  });

  // Domain event handlers for deal lifecycle
  domainEventHandlers.set("deal.won", async (payload, officeId) => {
    console.log(`[Worker] Deal won: ${payload.dealNumber} (${payload.dealName}) - amount: ${payload.awardedAmount}`);

    // --- Task 17: Won deal handoff checklist ---
    try {
      const { pool: handoffPool } = await import("../db.js");

      // Resolve office
      let handoffOfficeId = officeId;
      if (!handoffOfficeId && payload.assignedRepId) {
        const userRes = await handoffPool.query(
          "SELECT office_id FROM public.users WHERE id = $1",
          [payload.assignedRepId]
        );
        handoffOfficeId = userRes.rows[0]?.office_id ?? null;
      }
      if (!handoffOfficeId) {
        console.log("[Worker:handoff] Cannot resolve office — skipping handoff checklist");
      } else {
        const handoffOfficeRes = await handoffPool.query(
          "SELECT slug FROM public.offices WHERE id = $1 AND is_active = true",
          [handoffOfficeId]
        );
        if (handoffOfficeRes.rows.length > 0) {
          const handoffSlug = handoffOfficeRes.rows[0].slug;
          const slugRegex = /^[a-z][a-z0-9_]*$/;
          if (slugRegex.test(handoffSlug)) {
            const handoffSchema = `office_${handoffSlug}`;
            const dealName = payload.dealName ?? "deal";
            const assignedTo = payload.assignedRepId ?? payload.assignedTo;

            if (assignedTo) {
              // Look up primary contact name
              let primaryContactName = "primary contact";
              if (payload.primaryContactId) {
                const contactResult = await handoffPool.query(
                  `SELECT first_name, last_name FROM ${handoffSchema}.contacts WHERE id = $1`,
                  [payload.primaryContactId]
                );
                if (contactResult.rows.length > 0) {
                  const c = contactResult.rows[0];
                  primaryContactName = `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim() || "primary contact";
                }
              }

              const today = new Date();
              const handoffTasks = [
                {
                  title: `Schedule kickoff meeting for ${dealName}`,
                  priority: "urgent",
                  dueDate: today.toISOString().split("T")[0],
                },
                {
                  title: `Send welcome packet to ${primaryContactName}`,
                  priority: "high",
                  dueDate: new Date(today.getTime() + 1 * 86400000).toISOString().split("T")[0],
                },
                {
                  title: `Introduce project team for ${dealName}`,
                  priority: "normal",
                  dueDate: new Date(today.getTime() + 2 * 86400000).toISOString().split("T")[0],
                },
                {
                  title: `Verify Procore project created for ${dealName}`,
                  priority: "normal",
                  dueDate: new Date(today.getTime() + 3 * 86400000).toISOString().split("T")[0],
                },
              ];

              for (const task of handoffTasks) {
                await handoffPool.query(
                  `INSERT INTO ${handoffSchema}.tasks
                   (title, type, priority, status, assigned_to, deal_id, due_date, created_by)
                   VALUES ($1, 'system', $2, 'pending', $3, $4, $5, $3)`,
                  [task.title, task.priority, assignedTo, payload.dealId, task.dueDate]
                );
              }

              console.log(`[Worker] deal.won: created 4 handoff tasks for ${dealName}`);
            }
          }
        }
      }
    } catch (err) {
      console.error("[Worker:handoff] Error:", err);
      // Non-blocking
    }

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

    // --- Large-loss alert: notify directors/admins when deal value >= $100,000 ---
    try {
      const { pool: lossPool } = await import("../db.js");

      // Resolve office
      let lossOfficeId = officeId;
      if (!lossOfficeId && payload.assignedRepId) {
        const userRes = await lossPool.query(
          "SELECT office_id FROM public.users WHERE id = $1",
          [payload.assignedRepId]
        );
        lossOfficeId = userRes.rows[0]?.office_id ?? null;
      }

      if (lossOfficeId) {
        const officeRes = await lossPool.query(
          "SELECT slug, settings FROM public.offices WHERE id = $1 AND is_active = true",
          [lossOfficeId]
        );

        if (officeRes.rows.length > 0) {
          const slug = officeRes.rows[0].slug;
          const officeSettings = officeRes.rows[0].settings ?? {};
          const largeLossThreshold: number = officeSettings.largeLossThreshold ?? 100000;
          const slugRegex = /^[a-z][a-z0-9_]*$/;

          if (slugRegex.test(slug)) {
            const schemaName = `office_${slug}`;

            // Look up deal value (awarded_amount or bid_estimate)
            const dealRes = await lossPool.query(
              `SELECT COALESCE(awarded_amount, bid_estimate, 0)::numeric AS deal_value,
                      lost_notes
               FROM ${schemaName}.deals WHERE id = $1`,
              [payload.dealId]
            );

            const dealValue = Number(dealRes.rows[0]?.deal_value ?? 0);
            const lostNotes = dealRes.rows[0]?.lost_notes ?? payload.lostNotes ?? null;

            if (dealValue >= largeLossThreshold) {
              const formattedValue = dealValue.toLocaleString("en-US", {
                style: "currency",
                currency: "USD",
                maximumFractionDigits: 0,
              });

              const title = `Large deal lost: ${payload.dealName} (${formattedValue})`;
              const body = lostNotes
                ? `Lost reason: ${lostNotes}`
                : undefined;
              const link = `/deals/${payload.dealId}`;

              // Notify all directors and admins in the office
              const directorsRes = await lossPool.query(
                `SELECT id FROM public.users
                 WHERE office_id = $1 AND role IN ('director', 'admin') AND is_active = true`,
                [lossOfficeId]
              );

              for (const director of directorsRes.rows) {
                const notifRes = await lossPool.query(
                  `INSERT INTO ${schemaName}.notifications (user_id, type, title, body, link)
                   VALUES ($1, 'deal_lost', $2, $3, $4)
                   RETURNING id`,
                  [director.id, title, body ?? null, link]
                );
                await lossPool.query(
                  `SELECT pg_notify('crm_events', $1)`,
                  [JSON.stringify({
                    eventName: "notification.created",
                    userId: director.id,
                    notificationId: notifRes.rows[0]?.id,
                  })]
                );
              }

              console.log(`[Worker:large-loss] Notified ${directorsRes.rows.length} director(s)/admin(s) — deal value ${formattedValue}`);
            }
          }
        }
      }
    } catch (err) {
      console.error("[Worker:large-loss] Error:", err);
      // Non-blocking
    }

    // --- Task 18: Competitor intelligence tasks ---
    if (!payload.lostCompetitor) return; // Only fire when competitor is known

    try {
      const { pool: workerPool } = await import("../db.js");

      // Resolve office
      let resolvedOfficeId = officeId;
      if (!resolvedOfficeId && payload.assignedRepId) {
        const userRes = await workerPool.query(
          "SELECT office_id FROM public.users WHERE id = $1",
          [payload.assignedRepId]
        );
        resolvedOfficeId = userRes.rows[0]?.office_id ?? null;
      }
      if (!resolvedOfficeId) return;

      const officeResult = await workerPool.query(
        "SELECT slug FROM public.offices WHERE id = $1 AND is_active = true",
        [resolvedOfficeId]
      );
      if (officeResult.rows.length === 0) return;

      const slug = officeResult.rows[0].slug;
      const slugRegex = /^[a-z][a-z0-9_]*$/;
      if (!slugRegex.test(slug)) return;
      const schemaName = `office_${slug}`;

      const competitor = payload.lostCompetitor;
      const lostDealName = payload.dealName ?? "a deal";

      // Find the lost deal's contacts via contact_deal_associations
      const lostDealContacts = await workerPool.query(
        `SELECT cda.contact_id, c.company_name, c.first_name, c.last_name
         FROM ${schemaName}.contact_deal_associations cda
         JOIN ${schemaName}.contacts c ON c.id = cda.contact_id
         WHERE cda.deal_id = $1`,
        [payload.dealId]
      );

      if (lostDealContacts.rows.length === 0) return;

      const contactIds = lostDealContacts.rows.map((r: any) => r.contact_id);
      const companyNames = lostDealContacts.rows
        .map((r: any) => r.company_name)
        .filter((n: string | null) => n != null);

      // Find other active deals that share contacts with the lost deal
      // via contact_deal_associations JOIN
      const placeholders = contactIds.map((_: any, i: number) => `$${i + 2}`).join(", ");
      const activeDeals = await workerPool.query(
        `SELECT DISTINCT ON (d.id)
           d.id, d.name, d.assigned_rep_id,
           c.first_name, c.last_name
         FROM ${schemaName}.contact_deal_associations cda
         JOIN ${schemaName}.deals d ON d.id = cda.deal_id
         JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
         LEFT JOIN ${schemaName}.contacts c ON c.id = d.primary_contact_id
         WHERE cda.contact_id IN (${placeholders})
           AND d.id != $1
           AND d.is_active = true
           AND psc.is_terminal = false
           AND d.assigned_rep_id IS NOT NULL
         ORDER BY d.id`,
        [payload.dealId, ...contactIds]
      );

      let tasksCreated = 0;
      for (const deal of activeDeals.rows) {
        const contactName = `${deal.first_name ?? ""} ${deal.last_name ?? ""}`.trim() || "contact";
        const title = `Heads up: ${contactName} chose ${competitor} on ${lostDealName}. Review strategy for ${deal.name}`;

        // Dedup: check if this exact task already exists
        const existingTask = await workerPool.query(
          `SELECT id FROM ${schemaName}.tasks
           WHERE deal_id = $1
             AND type = 'system'
             AND title = $2
             AND status IN ('pending', 'in_progress')
           LIMIT 1`,
          [deal.id, title]
        );

        if (existingTask.rows.length > 0) continue;

        await workerPool.query(
          `INSERT INTO ${schemaName}.tasks
           (title, type, priority, status, assigned_to, deal_id, due_date, created_by)
           VALUES ($1, 'system', 'high', 'pending', $2, $3, CURRENT_DATE, $2)`,
          [title, deal.assigned_rep_id, deal.id]
        );
        tasksCreated++;
      }

      if (tasksCreated > 0) {
        console.log(`[Worker] deal.lost: created ${tasksCreated} competitor intelligence tasks for ${competitor}`);
      }
    } catch (err) {
      console.error("[Worker:competitor-intel] Error:", err);
      // Non-blocking
    }
  });

  domainEventHandlers.set("deal.stage.changed", async (payload, officeId) => {
    console.log(`[Worker] Stage changed: ${payload.dealNumber} from ${payload.fromStageName} to ${payload.toStageName}`);

    // Procore stage sync: queue a job to update the Procore project status
    // Skip if the change originated from Procore itself (prevents infinite sync loop)
    if (payload.changedBy === "procore_sync" || payload.changedBy === "synchub_integration") {
      console.log(`[Worker] deal.stage.changed: skipping Procore sync — change originated from ${payload.changedBy}`);
    } else if (payload.dealId && officeId && payload.toStageId) {
      try {
        const { pool: workerPool } = await import("../db.js");
        await workerPool.query(
          `INSERT INTO public.job_queue (job_type, payload, office_id, status, run_after)
           VALUES ('procore_sync', $1::jsonb, $2, 'pending', NOW())`,
          [
            JSON.stringify({
              action: "sync_stage",
              dealId: payload.dealId,
              crmStageId: payload.toStageId,
              officeId,
            }),
            officeId,
          ]
        );
        console.log(`[Worker] deal.stage.changed: queued procore_sync for deal ${payload.dealId}`);
      } catch (err) {
        console.error("[Worker:procore-stage-sync] Error queuing job:", err);
      }
    }
  });

  domainEventHandlers.set("contact.created", async (payload, officeId) => {
    console.log(`[Worker] contact.created: ${payload.contactId}`);

    // --- Task 16: Create onboarding task sequence ---
    try {
      const { pool: workerPool } = await import("../db.js");

      // Resolve officeId from the creating user if not provided
      let resolvedOfficeId = officeId;
      if (!resolvedOfficeId && payload.createdBy) {
        const userRes = await workerPool.query(
          "SELECT office_id FROM public.users WHERE id = $1",
          [payload.createdBy]
        );
        resolvedOfficeId = userRes.rows[0]?.office_id ?? null;
      }
      if (!resolvedOfficeId) return;

      const officeResult = await workerPool.query(
        "SELECT slug FROM public.offices WHERE id = $1 AND is_active = true",
        [resolvedOfficeId]
      );
      if (officeResult.rows.length === 0) return;

      const slug = officeResult.rows[0].slug;
      const slugRegex = /^[a-z][a-z0-9_]*$/;
      if (!slugRegex.test(slug)) return;
      const schemaName = `office_${slug}`;

      const contactName = `${payload.firstName ?? ""} ${payload.lastName ?? ""}`.trim() || "new contact";
      const createdBy = payload.createdBy;

      if (!createdBy) return;

      const today = new Date();
      const day3 = new Date(today);
      day3.setDate(day3.getDate() + 3);
      const day7 = new Date(today);
      day7.setDate(day7.getDate() + 7);

      const onboardingTasks = [
        {
          title: `Send intro email to ${contactName}`,
          type: "touchpoint",
          priority: "high",
          dueDate: today.toISOString().split("T")[0],
        },
        {
          title: `Follow-up call with ${contactName}`,
          type: "follow_up",
          priority: "normal",
          dueDate: day3.toISOString().split("T")[0],
        },
        {
          title: `Check response from ${contactName}`,
          type: "follow_up",
          priority: "normal",
          dueDate: day7.toISOString().split("T")[0],
        },
      ];

      for (const task of onboardingTasks) {
        await workerPool.query(
          `INSERT INTO ${schemaName}.tasks
           (title, type, priority, status, assigned_to, contact_id, due_date, created_by)
           VALUES ($1, $2, $3, 'pending', $4, $5, $6, $4)`,
          [task.title, task.type, task.priority, createdBy, payload.contactId, task.dueDate]
        );
      }

      console.log(`[Worker] contact.created: created 3 onboarding tasks for ${contactName}`);
    } catch (err) {
      console.error("[Worker:contact-onboarding] Error:", err);
      // Non-blocking
    }
  });

  // Domain event: activity.created -> post-meeting follow-up task (Task 14)
  domainEventHandlers.set("activity.created", async (payload, officeId) => {
    console.log(`[Worker] activity.created: type=${payload.type}`);

    // Only create follow-up for meeting activities
    if (payload.type !== "meeting") return;

    try {
      const { pool: workerPool } = await import("../db.js");

      // Resolve office from userId
      let resolvedOfficeId = officeId;
      if (!resolvedOfficeId && payload.userId) {
        const userRes = await workerPool.query(
          "SELECT office_id FROM public.users WHERE id = $1",
          [payload.userId]
        );
        resolvedOfficeId = userRes.rows[0]?.office_id ?? null;
      }
      if (!resolvedOfficeId) return;

      const officeResult = await workerPool.query(
        "SELECT slug FROM public.offices WHERE id = $1 AND is_active = true",
        [resolvedOfficeId]
      );
      if (officeResult.rows.length === 0) return;

      const slug = officeResult.rows[0].slug;
      const slugRegex = /^[a-z][a-z0-9_]*$/;
      if (!slugRegex.test(slug)) return;
      const schemaName = `office_${slug}`;

      // Look up contact name if contactId is provided
      let contactName = "contact";
      if (payload.contactId) {
        const contactResult = await workerPool.query(
          `SELECT first_name, last_name FROM ${schemaName}.contacts WHERE id = $1`,
          [payload.contactId]
        );
        if (contactResult.rows.length > 0) {
          const c = contactResult.rows[0];
          contactName = `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim() || "contact";
        }
      }

      const dueDate = addBusinessDays(new Date(), 2);
      const title = `Send follow-up from meeting with ${contactName}`;

      // Dedup: check if a follow-up task already exists for this contact+deal combo
      const existingTask = await workerPool.query(
        `SELECT id FROM ${schemaName}.tasks
         WHERE assigned_to = $1
           AND type = 'follow_up'
           AND title = $2
           AND status IN ('pending', 'in_progress')
         LIMIT 1`,
        [payload.userId, title]
      );

      if (existingTask.rows.length > 0) return;

      await workerPool.query(
        `INSERT INTO ${schemaName}.tasks
         (title, type, priority, status, assigned_to, deal_id, contact_id, due_date, created_by)
         VALUES ($1, 'follow_up', 'high', 'pending', $2, $3, $4, $5, $2)`,
        [
          title,
          payload.userId,
          payload.dealId ?? null,
          payload.contactId ?? null,
          dueDate.toISOString().split("T")[0],
        ]
      );

      console.log(`[Worker] activity.created: created follow-up task for meeting with ${contactName}`);
    } catch (err) {
      console.error("[Worker:post-meeting-followup] Error:", err);
      // Non-blocking
    }
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
    const emailNotifResult = await workerPool.query(
      `INSERT INTO ${schemaName}.notifications (user_id, type, title, body, link)
       VALUES ($1, 'inbound_email', $2, $3, $4)
       RETURNING id`,
      [
        payload.userId,
        `New email from ${payload.contactName || payload.fromAddress}`,
        payload.subject?.substring(0, 200) ?? "New email",
        "/email", // Link to inbox page — no per-email route exists yet
      ]
    );
    // PG NOTIFY so the server SSE manager can push to connected clients
    await workerPool.query(
      `SELECT pg_notify('crm_events', $1)`,
      [JSON.stringify({
        eventName: "notification.created",
        userId: payload.userId,
        notificationId: emailNotifResult.rows[0]?.id,
      })]
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

    const taskNotifResult = await workerPool.query(
      `INSERT INTO ${schemaName}.notifications (user_id, type, title, body, link)
       VALUES ($1, 'task_assigned', $2, $3, $4)
       RETURNING id`,
      [
        payload.assignedTo,
        `New task assigned: ${payload.title}`,
        payload.title,
        "/tasks",
      ]
    );
    // PG NOTIFY so the server SSE manager can push to connected clients
    await workerPool.query(
      `SELECT pg_notify('crm_events', $1)`,
      [JSON.stringify({
        eventName: "notification.created",
        userId: payload.assignedTo,
        notificationId: taskNotifResult.rows[0]?.id,
      })]
    );
  });

  // Domain event: task.completed -> create activity record
  domainEventHandlers.set("task.completed", async (payload, officeId) => {
    console.log(`[Worker] task.completed: ${payload.taskId} — ${payload.title}`);

    // Create a task_completed activity
    if (!payload.completedBy) return;
    if (!officeId) return;

    const { pool: workerPool } = await import("../db.js");
    const officeResult = await workerPool.query(
      "SELECT slug FROM public.offices WHERE id = $1 AND is_active = true",
      [officeId]
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

    if (payload.dealId) {
      await workerPool.query(
        `UPDATE ${schemaName}.deals
         SET last_activity_at = NOW(),
             updated_at = NOW()
         WHERE id = $1`,
        [payload.dealId]
      );
    }

    // If the completed task is a touchpoint and has a contact, update outreach tracking.
    // The PostgreSQL trigger only fires for call/email/meeting activity types,
    // so touchpoint task completions need explicit contact updates.
    if (payload.type === "touchpoint" && payload.contactId) {
      await workerPool.query(
        `UPDATE ${schemaName}.contacts
         SET first_outreach_completed = true,
             last_contacted_at = NOW(),
             touchpoint_count = touchpoint_count + 1
         WHERE id = $1 AND first_outreach_completed = false`,
        [payload.contactId]
      );
    }

    const suppressionWindowDays =
      typeof payload.suppressionWindowDays === "number" && Number.isFinite(payload.suppressionWindowDays)
        ? Math.max(0, payload.suppressionWindowDays)
        : null;

    if (payload.originRule && payload.dedupeKey && suppressionWindowDays != null) {
      const resolvedAt = new Date();
      const suppressedUntil = new Date(
        resolvedAt.getTime() + suppressionWindowDays * 24 * 60 * 60 * 1000
      );

      await workerPool.query(
        `INSERT INTO ${schemaName}.task_resolution_state
         (office_id, task_id, origin_rule, dedupe_key, resolution_status, resolution_reason, resolved_at, suppressed_until, entity_snapshot)
         VALUES ($1, $2, $3, $4, 'completed', $5, $6, $7, $8)
         ON CONFLICT (origin_rule, dedupe_key) DO UPDATE
         SET office_id = EXCLUDED.office_id,
             task_id = EXCLUDED.task_id,
             resolution_status = EXCLUDED.resolution_status,
             resolution_reason = EXCLUDED.resolution_reason,
             resolved_at = EXCLUDED.resolved_at,
             suppressed_until = EXCLUDED.suppressed_until,
             entity_snapshot = EXCLUDED.entity_snapshot,
             updated_at = NOW()`,
        [
          officeId,
          payload.taskId,
          payload.originRule,
          payload.dedupeKey,
          payload.reasonCode ?? payload.type ?? "task_completed",
          resolvedAt,
          suppressedUntil,
          payload.entitySnapshot ?? null,
        ]
      );
    }
  });

  // Domain event: approval.requested -> notify directors/admins
  domainEventHandlers.set("approval.requested", async (payload, officeId) => {
    console.log(`[Worker] approval.requested: deal ${payload.dealId}, approval ${payload.approvalId}`);

    if (!payload.requestedBy) return;

    const { pool: workerPool } = await import("../db.js");

    // Resolve office from the requesting user
    let resolvedOfficeId = officeId;
    if (!resolvedOfficeId) {
      const userRes = await workerPool.query(
        "SELECT office_id FROM public.users WHERE id = $1",
        [payload.requestedBy]
      );
      resolvedOfficeId = userRes.rows[0]?.office_id ?? null;
    }
    if (!resolvedOfficeId) return;

    const officeResult = await workerPool.query(
      "SELECT slug FROM public.offices WHERE id = $1 AND is_active = true",
      [resolvedOfficeId]
    );
    if (officeResult.rows.length === 0) return;

    const slug = officeResult.rows[0].slug;
    const slugRegex = /^[a-z][a-z0-9_]*$/;
    if (!slugRegex.test(slug)) return;
    const schemaName = `office_${slug}`;

    // Get requester name for the notification
    const requesterRes = await workerPool.query(
      "SELECT display_name FROM public.users WHERE id = $1",
      [payload.requestedBy]
    );
    const requesterName = requesterRes.rows[0]?.display_name ?? "A rep";

    // Notify all directors/admins in this office
    const directors = await workerPool.query(
      `SELECT id FROM public.users
       WHERE office_id = $1 AND role IN ('director', 'admin') AND is_active = true`,
      [resolvedOfficeId]
    );

    for (const director of directors.rows) {
      const approvalNotifResult = await workerPool.query(
        `INSERT INTO ${schemaName}.notifications (user_id, type, title, body, link)
         VALUES ($1, 'approval_requested', $2, $3, $4)
         RETURNING id`,
        [
          director.id,
          `Approval requested by ${requesterName}`,
          `Stage change approval needed for deal. Required role: ${payload.requiredRole}`,
          `/deals/${payload.dealId}`,
        ]
      );
      await workerPool.query(
        `SELECT pg_notify('crm_events', $1)`,
        [JSON.stringify({
          eventName: "notification.created",
          userId: director.id,
          notificationId: approvalNotifResult.rows[0]?.id,
        })]
      );
    }

    console.log(`[Worker] approval.requested: notified ${directors.rows.length} directors/admins`);
  });

  // Domain event: approval.resolved -> notify the requesting rep
  domainEventHandlers.set("approval.resolved", async (payload, officeId) => {
    console.log(`[Worker] approval.resolved: deal ${payload.dealId}, status ${payload.status}`);

    if (!payload.requestedBy) return;

    const { pool: workerPool } = await import("../db.js");

    // Resolve office
    let resolvedOfficeId = officeId;
    if (!resolvedOfficeId) {
      const userRes = await workerPool.query(
        "SELECT office_id FROM public.users WHERE id = $1",
        [payload.requestedBy]
      );
      resolvedOfficeId = userRes.rows[0]?.office_id ?? null;
    }
    if (!resolvedOfficeId) return;

    const officeResult = await workerPool.query(
      "SELECT slug FROM public.offices WHERE id = $1 AND is_active = true",
      [resolvedOfficeId]
    );
    if (officeResult.rows.length === 0) return;

    const slug = officeResult.rows[0].slug;
    const slugRegex = /^[a-z][a-z0-9_]*$/;
    if (!slugRegex.test(slug)) return;
    const schemaName = `office_${slug}`;

    // Get resolver name
    const resolverRes = await workerPool.query(
      "SELECT display_name FROM public.users WHERE id = $1",
      [payload.resolvedBy]
    );
    const resolverName = resolverRes.rows[0]?.display_name ?? "A director";

    const statusLabel = payload.status === "approved" ? "approved" : "rejected";

    // Notify the rep who requested the approval
    const resolveNotifResult = await workerPool.query(
      `INSERT INTO ${schemaName}.notifications (user_id, type, title, body, link)
       VALUES ($1, 'approval_resolved', $2, $3, $4)
       RETURNING id`,
      [
        payload.requestedBy,
        `Approval ${statusLabel} by ${resolverName}`,
        `Your stage change request was ${statusLabel}.`,
        `/deals/${payload.dealId}`,
      ]
    );
    await workerPool.query(
      `SELECT pg_notify('crm_events', $1)`,
      [JSON.stringify({
        eventName: "notification.created",
        userId: payload.requestedBy,
        notificationId: resolveNotifResult.rows[0]?.id,
      })]
    );

    console.log(`[Worker] approval.resolved: notified requester ${payload.requestedBy}`);
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

  console.log("[Worker] Job handlers registered:", ["test_echo", "domain_event", "stale_deal_scan", "dedup_scan", "email_sync", "daily_task_generation", "activity_drop_detection", "weekly_digest", "cold_lead_warming", "bid_deadline_countdown", "procore_sync", "procore_webhook", "procore_poll"].join(", "));
}

export { domainEventHandlers };
