import { eq } from "drizzle-orm";
import { db } from "../../db.js";
import { users, userOfficeAccess } from "@trock-crm/shared/schema";

/**
 * Can this user act in this office?
 *
 * Its OWN module, deliberately. The rule is needed by background work as well as by request middleware —
 * a queued job has to re-apply the authorization its enqueue performed — and reaching for it inside
 * auth/service.js dragged that whole graph (jsonwebtoken, the local-auth gate, the session helpers) into
 * the worker's dynamic import of the AI-report job, to answer one question about two rows. Same reasoning
 * as field-app-roles.ts.
 *
 * Behaviour is unchanged from the original: the user's PRIMARY office always passes with no override, any
 * other office requires a user_office_access grant, and that grant may carry a role override. The user row
 * is read directly here rather than through getUserById for the same dependency reason — only office_id is
 * needed.
 */
export async function getOfficeAccess(
  userId: string,
  officeId: string,
): Promise<{ hasAccess: boolean; roleOverride?: string }> {
  const [user] = await db
    .select({ officeId: users.officeId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) return { hasAccess: false };
  if (user.officeId === officeId) return { hasAccess: true }; // Primary office, no override

  const rows = await db
    .select()
    .from(userOfficeAccess)
    .where(eq(userOfficeAccess.userId, userId))
    .limit(100);

  const access = rows.find((row) => row.officeId === officeId);
  if (!access) return { hasAccess: false };
  return { hasAccess: true, roleOverride: access.roleOverride || undefined };
}
