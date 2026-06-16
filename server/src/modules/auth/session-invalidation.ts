import { eq } from "drizzle-orm";
import { users, userLocalAuth } from "@trock-crm/shared/schema";
import { closeUserSseConnections } from "../notifications/sse-manager.js";

// A Drizzle transaction or the base db — both expose .update.
type Db = { update: (t: typeof users | typeof userLocalAuth) => any };

// Durable "invalidate every session issued before `at`". Read per-request in middleware.
export async function bumpTokensValidAfter(db: Db, userId: string, at: Date): Promise<void> {
  await db.update(users).set({ tokensValidAfter: at }).where(eq(users.id, userId));
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

// Reactivate: let the user log in again. Their old tokens stay dead (tokens_valid_after unchanged);
// a fresh login mints a token with iat > the epoch.
export async function clearLocalAuthRevocation(db: Db, userId: string, at: Date): Promise<void> {
  await db
    .update(userLocalAuth)
    .set({ revokedAt: null, revokedByUserId: null, updatedAt: at })
    .where(eq(userLocalAuth.userId, userId));
}

// Best-effort in-memory stream teardown (post-commit). Re-exported for the caller's convenience.
export { closeUserSseConnections };
