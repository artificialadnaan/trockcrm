import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import { usageSession, usageHeartbeat, usageViewEvent } from "@trock-crm/shared/schema";
import { and, eq } from "drizzle-orm";

type TenantDb = NodePgDatabase<typeof schema>;

export interface StartSessionInput {
  userId: string;
  userAgent: string | null;
  impersonatorId: string | null;
}

export async function startSession(
  tenantDb: Pick<TenantDb, "insert">,
  input: StartSessionInput,
): Promise<{ sessionId: string }> {
  const [row] = await tenantDb
    .insert(usageSession)
    .values({
      userId: input.userId,
      userAgent: input.userAgent ?? null,
      impersonatorId: input.impersonatorId,
    })
    .returning({ id: usageSession.id });
  return { sessionId: row.id };
}

export interface HeartbeatInput {
  userId: string;
  sessionId: string;
}

/** Server-stamped: `at` uses the DB default (now()); `last_heartbeat_at` set to now(). Client time ignored. */
export async function recordHeartbeat(
  tenantDb: Pick<TenantDb, "insert" | "update">,
  input: HeartbeatInput,
): Promise<void> {
  await tenantDb.insert(usageHeartbeat).values({ userId: input.userId, sessionId: input.sessionId });
  await tenantDb
    .update(usageSession)
    .set({ lastHeartbeatAt: new Date() })
    .where(and(eq(usageSession.id, input.sessionId), eq(usageSession.userId, input.userId)));
}

export interface ViewEventInput {
  entityType: string;
  entityId: string | null;
  route: string;
  labelSnapshot: string | null;
}

export async function recordViewEvents(
  tenantDb: Pick<TenantDb, "insert">,
  userId: string,
  sessionId: string,
  events: ViewEventInput[],
): Promise<void> {
  if (events.length === 0) return;
  await tenantDb.insert(usageViewEvent).values(
    events.map((e) => ({
      userId,
      sessionId,
      entityType: e.entityType,
      entityId: e.entityId,
      route: e.route,
      labelSnapshot: e.labelSnapshot,
    })),
  );
}
