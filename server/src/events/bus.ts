import { EventEmitter } from "events";
import { pool } from "../db.js";
import { PG_NOTIFY_CHANNEL, type DomainEvent, type DomainEventName } from "./types.js";

class EventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(50);
  }

  /**
   * Emit an in-process event (handled within the API server).
   * Use for: SSE notifications, activity logging, in-request side effects.
   */
  emitLocal(event: DomainEvent) {
    this.emit(event.name, event);
  }

  /**
   * Emit a cross-process event via PG NOTIFY + job_queue outbox.
   * Use for: Worker-bound jobs (Procore sync, email tasks, alert emails).
   * Writes to job_queue as outbox pattern fallback for durability.
   */
  async emitRemote(event: DomainEvent) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Write to job_queue as durable outbox
      // Uses generic 'domain_event' job_type — worker dispatches by event name in payload
      // Build job payload — cast to Record to allow spread of generic T
      const eventPayload = (event.payload != null && typeof event.payload === "object")
        ? event.payload as Record<string, unknown>
        : { data: event.payload };
      await client.query(
        `INSERT INTO public.job_queue (job_type, payload, office_id, status, run_after)
         VALUES ($1, $2, $3, 'pending', NOW())`,
        ["domain_event", JSON.stringify({ eventName: event.name, ...eventPayload, userId: event.userId }), event.officeId]
      );

      // Notify worker for real-time pickup — parameterized to prevent injection
      const payload = JSON.stringify({
        name: event.name,
        payload: event.payload,
        officeId: event.officeId,
        userId: event.userId,
        timestamp: event.timestamp.toISOString(),
      });
      await client.query("SELECT pg_notify($1, $2)", [PG_NOTIFY_CHANNEL, payload]);

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("[EventBus] emitRemote failed:", err);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Emit both local and remote.
   * Use for events that need both in-process and worker handling.
   */
  async emitAll(event: DomainEvent) {
    this.emitLocal(event);
    await this.emitRemote(event);
  }

  /**
   * Subscribe to a specific event type.
   */
  onEvent(eventName: DomainEventName, handler: (event: DomainEvent) => void) {
    this.on(eventName, handler);
    return this;
  }
}

export const eventBus = new EventBus();
