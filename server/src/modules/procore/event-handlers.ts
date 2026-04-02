// server/src/modules/procore/event-handlers.ts
// Registers listeners on the event bus for deal.won and deal.stage.changed.
// Both write a procore_sync job to job_queue for async processing.

import { eventBus } from "../../events/bus.js";
import { db } from "../../db.js";
import { sql } from "drizzle-orm";
import type { DomainEvent } from "../../events/types.js";

/**
 * Register Procore event handlers on the in-process event bus.
 * Call once during server startup (in createApp).
 */
export function registerProcoreEventHandlers(): void {
  // deal.won → create Procore project
  eventBus.onEvent("deal.won", async (event: DomainEvent) => {
    const { dealId, officeId } = event.payload as { dealId: string; officeId: string };
    if (!dealId || !officeId) return;

    try {
      await db.execute(
        sql`INSERT INTO public.job_queue (job_type, payload, office_id, status, run_after)
            VALUES ('procore_sync', ${JSON.stringify({
              action: "create_project",
              dealId,
              officeId,
            })}::jsonb, ${officeId}, 'pending', NOW())`
      );
      console.log(`[Procore:events] Queued create_project job for deal ${dealId}`);
    } catch (err) {
      console.error("[Procore:events] Failed to enqueue create_project job:", err);
    }
  });

  // deal.stage.changed → update Procore project status
  eventBus.onEvent("deal.stage.changed", async (event: DomainEvent) => {
    const { dealId, newStageId, officeId } = event.payload as {
      dealId: string;
      newStageId: string;
      officeId: string;
    };
    if (!dealId || !newStageId || !officeId) return;

    try {
      await db.execute(
        sql`INSERT INTO public.job_queue (job_type, payload, office_id, status, run_after)
            VALUES ('procore_sync', ${JSON.stringify({
              action: "sync_stage",
              dealId,
              crmStageId: newStageId,
              officeId,
            })}::jsonb, ${officeId}, 'pending', NOW())`
      );
      console.log(
        `[Procore:events] Queued sync_stage job for deal ${dealId} → stage ${newStageId}`
      );
    } catch (err) {
      console.error("[Procore:events] Failed to enqueue sync_stage job:", err);
    }
  });
}
