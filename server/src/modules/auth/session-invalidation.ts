import { eq, sql } from "drizzle-orm";
import { users, userLocalAuth } from "@trock-crm/shared/schema";
import { closeUserSseConnections } from "../notifications/sse-manager.js";

// A Drizzle transaction or the base db — both expose .update.
type Db = { update: (t: typeof users | typeof userLocalAuth) => any };

// Monotonically bump the user's token version — every JWT minted before this point is now stale (its
// version is behind). The durable "invalidate all sessions" primitive, read per-request in middleware.
export async function incrementTokenVersion(db: Db, userId: string): Promise<void> {
  await db.update(users).set({ tokenVersion: sql`${users.tokenVersion} + 1` }).where(eq(users.id, userId));
}

// Block re-login after deactivate (middleware already rejects revokedAt). The revoked_at /
// revoked_by_user_id columns ARE the deactivation record; no separate event row is written here
// (the user_local_auth_events event_type may be an enum — out of scope for this one-column change).
export async function revokeLocalAuthOnDeactivate(db: Db, userId: string, actorUserId: string, at: Date): Promise<void> {
  await db
    .update(userLocalAuth)
    .set({ revokedAt: at, revokedByUserId: actorUserId, updatedAt: at })
    .where(eq(userLocalAuth.userId, userId));
}

// Reactivate: let the user log in again. Their old tokens stay dead (the version was bumped on
// reactivation); a fresh login mints a token carrying the new version.
export async function clearLocalAuthRevocation(db: Db, userId: string, at: Date): Promise<void> {
  await db
    .update(userLocalAuth)
    .set({ revokedAt: null, revokedByUserId: null, updatedAt: at })
    .where(eq(userLocalAuth.userId, userId));
}

// Best-effort in-memory stream teardown (post-commit). Re-exported for the caller's convenience.
export { closeUserSseConnections };
