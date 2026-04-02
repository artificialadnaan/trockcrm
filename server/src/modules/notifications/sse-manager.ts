import type { Response } from "express";
import { eventBus } from "../../events/bus.js";

/**
 * Manages active SSE connections per user.
 * When a notification.created event fires on the eventBus,
 * pushes it to all connected SSE streams for that user.
 */

interface SseConnection {
  res: Response;
  userId: string;
  officeId: string;
}

const connections = new Map<string, Set<SseConnection>>();

/**
 * Register an SSE connection for a user.
 * Returns a cleanup function to call on disconnect.
 */
export function registerSseConnection(userId: string, officeId: string, res: Response): () => void {
  if (!connections.has(userId)) {
    connections.set(userId, new Set());
  }

  const conn: SseConnection = { res, userId, officeId };
  connections.get(userId)!.add(conn);

  return () => {
    const userConns = connections.get(userId);
    if (userConns) {
      userConns.delete(conn);
      if (userConns.size === 0) {
        connections.delete(userId);
      }
    }
  };
}

/**
 * Push a notification to all SSE connections for a specific user.
 */
export function pushToUser(userId: string, event: string, data: unknown): void {
  const userConns = connections.get(userId);
  if (!userConns || userConns.size === 0) return;

  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

  for (const conn of userConns) {
    try {
      conn.res.write(payload);
    } catch (err) {
      // Connection is dead -- cleanup will happen via req.on("close")
      console.error(`[SSE] Failed to push to user ${userId}:`, err);
    }
  }
}

/**
 * Get the number of active SSE connections (for diagnostics).
 */
export function getConnectionCount(): number {
  let total = 0;
  for (const conns of connections.values()) {
    total += conns.size;
  }
  return total;
}

/**
 * Initialize SSE push by subscribing to relevant eventBus events.
 * Call this once at server startup.
 */
export function initSsePush(): void {
  // Listen for notification.created events (emitted by services after DB insert)
  eventBus.on("notification.created", (event: any) => {
    const { userId, notification } = event.payload ?? event;
    if (userId && notification) {
      pushToUser(userId, "notification", notification);
    }
  });

  // Listen for task.assigned events to push real-time assignment notifications
  eventBus.on("task.assigned", (event: any) => {
    const payload = event.payload ?? event;
    if (payload.assignedTo) {
      pushToUser(payload.assignedTo, "task_update", {
        type: "assigned",
        taskId: payload.taskId,
        title: payload.title,
      });
    }
  });

  // Listen for task.completed events to push real-time completion updates
  eventBus.on("task.completed", (event: any) => {
    const payload = event.payload ?? event;
    if (payload.completedBy) {
      pushToUser(payload.completedBy, "task_update", {
        type: "completed",
        taskId: payload.taskId,
      });
    }
  });

  console.log("[SSE] Push listeners initialized");
}
