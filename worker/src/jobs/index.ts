import { registerJobHandler } from "../queue.js";

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

  // Future domain event handlers added here as features are built:
  // domainEventHandlers.set("deal.won", handleDealWon);
  // domainEventHandlers.set("deal.stage.changed", handleDealStageChanged);

  console.log("[Worker] Job handlers registered:", ["test_echo", "domain_event"].join(", "));
}

export { domainEventHandlers };
