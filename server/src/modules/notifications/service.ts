import { eq, and, desc, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { notifications } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { eventBus } from "../../events/bus.js";

type TenantDb = NodePgDatabase<typeof schema>;

export interface NotificationFilters {
  userId: string;
  isRead?: boolean;
  page?: number;
  limit?: number;
}

/**
 * Get notifications for a user.
 */
export async function getNotifications(tenantDb: TenantDb, filters: NotificationFilters) {
  const page = filters.page ?? 1;
  const limit = filters.limit ?? 30;
  const offset = (page - 1) * limit;

  const conditions: any[] = [eq(notifications.userId, filters.userId)];
  if (filters.isRead !== undefined) {
    conditions.push(eq(notifications.isRead, filters.isRead));
  }

  const where = and(...conditions);

  const [countResult, rows] = await Promise.all([
    tenantDb.select({ count: sql<number>`count(*)` }).from(notifications).where(where),
    tenantDb
      .select()
      .from(notifications)
      .where(where)
      .orderBy(desc(notifications.createdAt))
      .limit(limit)
      .offset(offset),
  ]);

  const total = Number(countResult[0]?.count ?? 0);

  return {
    notifications: rows,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

/**
 * Get unread notification count for a user.
 */
export async function getUnreadCount(tenantDb: TenantDb, userId: string): Promise<number> {
  const result = await tenantDb
    .select({ count: sql<number>`count(*)` })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.isRead, false)));

  return Number(result[0]?.count ?? 0);
}

/**
 * Mark a single notification as read.
 */
export async function markAsRead(tenantDb: TenantDb, notificationId: string, userId: string) {
  const result = await tenantDb
    .update(notifications)
    .set({ isRead: true, readAt: new Date() })
    .where(and(eq(notifications.id, notificationId), eq(notifications.userId, userId)))
    .returning();

  return result[0] ?? null;
}

/**
 * Mark all notifications as read for a user.
 */
export async function markAllAsRead(tenantDb: TenantDb, userId: string): Promise<number> {
  const result = await tenantDb
    .update(notifications)
    .set({ isRead: true, readAt: new Date() })
    .where(and(eq(notifications.userId, userId), eq(notifications.isRead, false)));

  // Drizzle update doesn't return rowCount directly -- use returning or raw count
  return (result as any).rowCount ?? 0;
}

/**
 * Create a notification and push it via SSE.
 * This is the central function all notification-creating code should use
 * in the API server context (not worker -- worker uses raw SQL).
 */
export async function createNotification(
  tenantDb: TenantDb,
  input: {
    userId: string;
    type: string;
    title: string;
    body?: string;
    link?: string;
  }
) {
  const result = await tenantDb
    .insert(notifications)
    .values({
      userId: input.userId,
      type: input.type as any,
      title: input.title,
      body: input.body ?? null,
      link: input.link ?? null,
    })
    .returning();

  const notification = result[0];

  // Emit local event for SSE push
  try {
    eventBus.emitLocal({
      name: "notification.created" as any,
      payload: { userId: input.userId, notification },
      officeId: "",
      userId: input.userId,
      timestamp: new Date(),
    });
  } catch (err) {
    // Best-effort -- SSE push failure should not break the request
    console.error("[Notifications] SSE push failed:", err);
  }

  return notification;
}
