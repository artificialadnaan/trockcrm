# Admin User Provisioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In-app admin user provisioning from the Users tab — add a CRM user (create + invite), deactivate/reactivate with immediate session invalidation, and change roles — with safety guards, extending the already-built user system.

**Architecture:** Security decisions are pure predicates (`shared/src/types/enums.ts` role set + `shared/src/lib/userProvisioningGuards.ts`) proven by a gate-executed server runtime test. A `users.tokens_valid_after` epoch column (one migration) + per-request `is_active` re-check is the authoritative session gate; an effectful `session-invalidation.ts` (epoch bump + `user_local_auth.revoked_at` + best-effort SSE teardown) is wired into `updateUser`. A new `createCrmUser` service + `POST /admin/users` reuses the existing invite. UI gets an Add-User dialog + a deactivate confirm.

**Tech Stack:** TypeScript, Express, Drizzle, Postgres (raw `.sql` migrations auto-run on deploy), Vitest 3 (server `tests/**/*.runtime.test.ts` AND client `src/**/*.runtime.test.tsx` both execute in `check:premerge`), React + Base UI, scrypt local auth, stateless JWT. Spec: `docs/superpowers/specs/2026-06-16-admin-user-provisioning-design.md`.

---

## File Structure

- Modify `shared/src/types/enums.ts` — add `CRM_ASSIGNABLE_ROLES`, `CrmAssignableRole`, `isAssignableCrmRole` (resolved everywhere via `@trock-crm/shared/types`).
- Create `shared/src/lib/userProvisioningGuards.ts` — pure behavioral predicates. Wire into `shared/package.json` exports, `server/tsconfig.json`, `server/tsconfig.typecheck.json`, `server/vitest.config.ts`.
- Create `server/tests/admin/user-provisioning-guards.runtime.test.ts` — gate-executed proof of every security predicate.
- Create `migrations/0161_user_tokens_valid_after.sql`; modify `shared/src/schema/public/users.ts`.
- Create `server/src/modules/auth/session-invalidation.ts`; modify `server/src/modules/notifications/sse-manager.ts`.
- Modify `server/src/modules/auth/service.ts` (`verifyJwt` iat), `server/src/middleware/auth.ts`, `server/src/middleware/field-auth.ts` (epoch check).
- Modify `server/src/modules/admin/users-service.ts` (`createCrmUser`, `updateUser` guards + session-kill), `server/src/modules/admin/routes.ts` (`POST /admin/users`, pass `actorUserId`).
- Create `server/tests/admin/create-crm-user.runtime.test.ts`, `server/tests/admin/sse-teardown.runtime.test.ts`.
- Modify `client/src/hooks/use-admin-users.ts` (`createUser`); create `client/src/pages/admin/add-user-dialog.tsx` + `client/src/pages/admin/add-user-dialog.runtime.test.tsx`; modify `client/src/pages/admin/users-page.tsx` (Add button, role select `construction`, deactivate confirm).

**Branch:** `feat/admin-user-provisioning` (created; spec committed). Standard gate `npm run check:premerge`. Adnaan merges — no self-merge.

---

## Task 1: CRM-assignable role set (shared types)

**Files:**
- Modify: `shared/src/types/enums.ts`
- Test: covered by Task 2's gate test (imports from `@trock-crm/shared/types`).

- [ ] **Step 1: Add the role set + guard** after the `USER_ROLES`/`UserRole` lines at the top of `shared/src/types/enums.ts`:

```ts
// Roles an admin may assign to a CRM user from the Users tab. Excludes field_contractor,
// which has its own create+invite lifecycle (server/src/modules/field-users).
export const CRM_ASSIGNABLE_ROLES = ["admin", "director", "rep", "construction"] as const;
export type CrmAssignableRole = (typeof CRM_ASSIGNABLE_ROLES)[number];
export function isAssignableCrmRole(role: string): role is CrmAssignableRole {
  return (CRM_ASSIGNABLE_ROLES as readonly string[]).includes(role);
}
```

- [ ] **Step 2: Typecheck shared**

Run: `cd shared && npx tsc -p tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add shared/src/types/enums.ts
git commit -m "feat(shared): CRM_ASSIGNABLE_ROLES + isAssignableCrmRole"
```

---

## Task 2: Pure guard predicates + gate-executed proof

**Files:**
- Create: `shared/src/lib/userProvisioningGuards.ts`
- Modify: `shared/package.json`, `server/tsconfig.json`, `server/tsconfig.typecheck.json`, `server/vitest.config.ts`
- Test: `server/tests/admin/user-provisioning-guards.runtime.test.ts`

- [ ] **Step 1: Write the failing gate test** (imports the real types; this file name ends in `runtime.test.ts` so it runs in the gate):

```ts
// server/tests/admin/user-provisioning-guards.runtime.test.ts
import { describe, expect, it } from "vitest";
import { isAssignableCrmRole } from "@trock-crm/shared/types";
import {
  isTokenStaleByEpoch,
  isProhibitedSelfChange,
  isFieldContractorTransition,
  wouldRemoveLastActiveAdmin,
} from "@trock-crm/shared/lib/userProvisioningGuards";

describe("isTokenStaleByEpoch", () => {
  it("null epoch is never stale", () => {
    expect(isTokenStaleByEpoch(1000, null)).toBe(false);
  });
  it("token issued strictly before the epoch is stale", () => {
    expect(isTokenStaleByEpoch(1000, 1000 * 1000 + 1)).toBe(true); // iat seconds * 1000 < epoch ms
  });
  it("token issued at/after the epoch is valid", () => {
    expect(isTokenStaleByEpoch(1000, 1000 * 1000)).toBe(false); // equal -> not stale (strict <)
    expect(isTokenStaleByEpoch(2000, 1000 * 1000)).toBe(false);
  });
  it("undefined iat is not stale (cannot prove staleness)", () => {
    expect(isTokenStaleByEpoch(undefined, 1000 * 1000)).toBe(false);
  });
});

describe("isAssignableCrmRole", () => {
  it("accepts the four CRM roles", () => {
    for (const r of ["admin", "director", "rep", "construction"]) expect(isAssignableCrmRole(r)).toBe(true);
  });
  it("rejects field_contractor and junk", () => {
    expect(isAssignableCrmRole("field_contractor")).toBe(false);
    expect(isAssignableCrmRole("wizard")).toBe(false);
  });
});

describe("isProhibitedSelfChange", () => {
  const base = { actorId: "u1", targetId: "u1", currentRole: "admin" as const };
  it("self + deactivate is prohibited", () => {
    expect(isProhibitedSelfChange({ ...base, nextIsActive: false })).toBe(true);
  });
  it("self + role change is prohibited", () => {
    expect(isProhibitedSelfChange({ ...base, nextRole: "rep" })).toBe(true);
  });
  it("self + no-op (same role, no active change) is allowed", () => {
    expect(isProhibitedSelfChange({ ...base, nextRole: "admin" })).toBe(false);
    expect(isProhibitedSelfChange({ ...base })).toBe(false);
  });
  it("a different user is never a self-change", () => {
    expect(isProhibitedSelfChange({ actorId: "u1", targetId: "u2", currentRole: "admin", nextIsActive: false })).toBe(false);
  });
});

describe("isFieldContractorTransition", () => {
  it("into field_contractor is blocked", () => {
    expect(isFieldContractorTransition("rep", "field_contractor")).toBe(true);
  });
  it("out of field_contractor to a CRM role is blocked", () => {
    expect(isFieldContractorTransition("field_contractor", "rep")).toBe(true);
  });
  it("CRM-to-CRM is fine", () => {
    expect(isFieldContractorTransition("rep", "director")).toBe(false);
  });
  it("undefined nextRole (no role change) is fine", () => {
    expect(isFieldContractorTransition("rep", undefined)).toBe(false);
  });
});

describe("wouldRemoveLastActiveAdmin", () => {
  it("deactivating the only admin is blocked", () => {
    expect(wouldRemoveLastActiveAdmin({ currentRole: "admin", nextIsActive: false, otherActiveAdminCount: 0 })).toBe(true);
  });
  it("demoting the only admin is blocked", () => {
    expect(wouldRemoveLastActiveAdmin({ currentRole: "admin", nextRole: "rep", otherActiveAdminCount: 0 })).toBe(true);
  });
  it("allowed when another active admin exists", () => {
    expect(wouldRemoveLastActiveAdmin({ currentRole: "admin", nextIsActive: false, otherActiveAdminCount: 1 })).toBe(false);
  });
  it("non-admin target is never the last admin", () => {
    expect(wouldRemoveLastActiveAdmin({ currentRole: "rep", nextIsActive: false, otherActiveAdminCount: 0 })).toBe(false);
  });
  it("editing an admin without dropping admin-ness is fine", () => {
    expect(wouldRemoveLastActiveAdmin({ currentRole: "admin", nextRole: "admin", otherActiveAdminCount: 0 })).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server && npx vitest run tests/admin/user-provisioning-guards.runtime.test.ts`
Expected: FAIL — cannot resolve `@trock-crm/shared/lib/userProvisioningGuards`.

- [ ] **Step 3: Create the predicates**

```ts
// shared/src/lib/userProvisioningGuards.ts
import type { UserRole } from "../types/enums.js";

// True when a JWT (issued-at, seconds) predates the user's session epoch (ms). Strict <, so a token
// minted at the same second as the epoch survives. null epoch or unknown iat => not stale.
export function isTokenStaleByEpoch(iatSeconds: number | undefined, tokensValidAfterMs: number | null): boolean {
  if (tokensValidAfterMs == null || iatSeconds == null) return false;
  return iatSeconds * 1000 < tokensValidAfterMs;
}

// An admin may not deactivate themselves or change their own role (anti-lockout / anti-footgun).
export function isProhibitedSelfChange(args: {
  actorId: string;
  targetId: string;
  nextIsActive?: boolean;
  currentRole: UserRole;
  nextRole?: UserRole;
}): boolean {
  if (args.actorId !== args.targetId) return false;
  const deactivatingSelf = args.nextIsActive === false;
  const changingOwnRole = args.nextRole !== undefined && args.nextRole !== args.currentRole;
  return deactivatingSelf || changingOwnRole;
}

// field_contractor has its own lifecycle; block CRM-admin role edits that cross that boundary either way.
export function isFieldContractorTransition(currentRole: UserRole, nextRole: UserRole | undefined): boolean {
  if (nextRole === undefined) return false;
  if (nextRole === "field_contractor") return true;
  if (currentRole === "field_contractor" && nextRole !== "field_contractor") return true;
  return false;
}

// True when the change strips admin-ness from an admin and no other active admin remains.
export function wouldRemoveLastActiveAdmin(args: {
  currentRole: UserRole;
  nextRole?: UserRole;
  nextIsActive?: boolean;
  otherActiveAdminCount: number;
}): boolean {
  if (args.currentRole !== "admin") return false;
  const beingDeactivated = args.nextIsActive === false;
  const beingDemoted = args.nextRole !== undefined && args.nextRole !== "admin";
  if (!beingDeactivated && !beingDemoted) return false;
  return args.otherActiveAdminCount === 0;
}
```

- [ ] **Step 4: Wire the new lib for build + typecheck + server vitest** (mirror `rfpReviewerEmails`):

In `shared/package.json` `exports`, add after the `./lib/rfpReviewerEmails` block:
```json
    "./lib/userProvisioningGuards": {
      "types": "./dist/lib/userProvisioningGuards.d.ts",
      "default": "./dist/lib/userProvisioningGuards.js"
    },
```
In `server/tsconfig.json` `paths`, add:
```json
      "@trock-crm/shared/lib/userProvisioningGuards": ["../shared/dist/lib/userProvisioningGuards.d.ts"],
```
In `server/tsconfig.typecheck.json` `paths`, add:
```json
      "@trock-crm/shared/lib/userProvisioningGuards": ["../shared/src/lib/userProvisioningGuards.ts"],
```
In `server/vitest.config.ts` `resolve.alias`, add after the `rfpReviewerEmails` alias:
```ts
      "@trock-crm/shared/lib/userProvisioningGuards": path.resolve(__dirname, "../shared/src/lib/userProvisioningGuards.ts"),
```

- [ ] **Step 5: Build shared so the dist + .d.ts exist for the server build path**

Run: `cd shared && npm run build`
Expected: `dist/lib/userProvisioningGuards.js` + `.d.ts` produced.

- [ ] **Step 6: Run the gate test to verify it passes**

Run: `cd server && npx vitest run tests/admin/user-provisioning-guards.runtime.test.ts`
Expected: PASS (all predicate cases).

- [ ] **Step 7: Commit**

```bash
git add shared/src/lib/userProvisioningGuards.ts shared/package.json server/tsconfig.json server/tsconfig.typecheck.json server/vitest.config.ts server/tests/admin/user-provisioning-guards.runtime.test.ts
git commit -m "feat(shared): pure user-provisioning guard predicates + gate-executed tests"
```

---

## Task 3: Migration + schema for the session epoch

**Files:**
- Create: `migrations/0161_user_tokens_valid_after.sql`
- Modify: `shared/src/schema/public/users.ts`

- [ ] **Step 1: Create the migration**

```sql
-- migrations/0161_user_tokens_valid_after.sql
-- Session-invalidation epoch: any JWT issued before this instant is rejected in middleware.
-- NULL => no epoch (all existing tokens remain valid). Set on deactivate and on role change.
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS tokens_valid_after timestamptz;
```

- [ ] **Step 2: Add the column to the Drizzle schema** in `shared/src/schema/public/users.ts`, after the `updatedAt` column (keep it nullable, no default):

```ts
  tokensValidAfter: timestamp("tokens_valid_after", { withTimezone: true }),
```

- [ ] **Step 3: Build shared + typecheck**

Run: `cd shared && npm run build && npx tsc -p tsconfig.json --noEmit`
Expected: no errors; `tokensValidAfter` present on the `users` type.

- [ ] **Step 4: Commit**

```bash
git add migrations/0161_user_tokens_valid_after.sql shared/src/schema/public/users.ts
git commit -m "feat(db): users.tokens_valid_after session-invalidation epoch (migration 0161)"
```

---

## Task 4: Session-kill effects + SSE teardown

**Files:**
- Create: `server/src/modules/auth/session-invalidation.ts`
- Modify: `server/src/modules/notifications/sse-manager.ts`
- Test: `server/tests/admin/sse-teardown.runtime.test.ts`

- [ ] **Step 1: Write the failing SSE-teardown test** (the registry is module state; register fakes then close):

```ts
// server/tests/admin/sse-teardown.runtime.test.ts
import { describe, expect, it } from "vitest";
import type { Response } from "express";
import { registerSseConnection, closeUserSseConnections, getConnectionCount } from "../../src/modules/notifications/sse-manager.js";

function fakeRes() {
  const calls: string[] = [];
  let ended = false;
  const res = {
    write: (s: string) => { calls.push(s); return true; },
    end: () => { ended = true; },
    flush: () => {},
  } as unknown as Response;
  return { res, calls, get ended() { return ended; } };
}

describe("closeUserSseConnections", () => {
  it("ends every registered stream for the user, empties the registry, returns the count", () => {
    const a = fakeRes();
    const b = fakeRes();
    registerSseConnection("user-1", "office-1", a.res);
    registerSseConnection("user-1", "office-1", b.res);
    const before = getConnectionCount();
    const closed = closeUserSseConnections("user-1");
    expect(closed).toBe(2);
    expect(a.ended).toBe(true);
    expect(b.ended).toBe(true);
    expect(getConnectionCount()).toBe(before - 2);
  });

  it("is a no-op (0) for a user with no streams", () => {
    expect(closeUserSseConnections("nobody")).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server && npx vitest run tests/admin/sse-teardown.runtime.test.ts`
Expected: FAIL — `closeUserSseConnections` is not exported.

- [ ] **Step 3: Add `closeUserSseConnections` to `sse-manager.ts`** (after the `pushToUser` function):

```ts
/**
 * Force-close every SSE stream for a user (best-effort fast-path cleanup on deactivate). NOT the
 * security boundary — the per-request is_active + tokens_valid_after re-check is. Returns the count
 * closed. In-memory + per-instance by design (matches the in-process eventBus).
 */
export function closeUserSseConnections(userId: string): number {
  const userConns = connections.get(userId);
  if (!userConns || userConns.size === 0) return 0;
  let closed = 0;
  for (const conn of userConns) {
    try {
      writeSse(conn.res, `event: session_invalidated\ndata: {}\n\n`);
      conn.res.end();
    } catch {
      // already dead; counting it as closed is fine
    }
    closed++;
  }
  connections.delete(userId);
  return closed;
}
```

- [ ] **Step 4: Run the SSE test to verify it passes**

Run: `cd server && npx vitest run tests/admin/sse-teardown.runtime.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Create the effectful session-invalidation module**

```ts
// server/src/modules/auth/session-invalidation.ts
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
```

- [ ] **Step 6: Typecheck server**

Run: `cd server && npx tsc -p tsconfig.typecheck.json --noEmit 2>&1 | grep -E "session-invalidation|sse-manager" || echo "clean"`
Expected: `clean`.

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/auth/session-invalidation.ts server/src/modules/notifications/sse-manager.ts server/tests/admin/sse-teardown.runtime.test.ts
git commit -m "feat(auth): session-invalidation effects + SSE teardown"
```

---

## Task 5: Middleware epoch enforcement

**Files:**
- Modify: `server/src/modules/auth/service.ts` (`verifyJwt` surfaces `iat`)
- Modify: `server/src/middleware/auth.ts`, `server/src/middleware/field-auth.ts`

- [ ] **Step 1: Surface `iat` from `verifyJwt`** — in `server/src/modules/auth/service.ts`, change `verifyJwt` (lines 28-30) to:

```ts
export function verifyJwt(token: string): JwtClaims & { iat?: number; exp?: number } {
  return jwt.verify(token, getJwtSecret()) as JwtClaims & { iat?: number; exp?: number };
}
```

- [ ] **Step 2: Enforce the epoch in CRM `authMiddleware`** — in `server/src/middleware/auth.ts`, add the import at the top:

```ts
import { isTokenStaleByEpoch } from "@trock-crm/shared/lib/userProvisioningGuards";
```
and insert immediately after the existing `if (!user || !user.isActive) { ... }` block (after line 46):

```ts
    if (isTokenStaleByEpoch(claims.iat, user.tokensValidAfter?.getTime() ?? null)) {
      throw new AppError(401, "Session expired, please sign in again");
    }
```

- [ ] **Step 3: Enforce the epoch in `requireFieldContractor`** — in `server/src/middleware/field-auth.ts`, add the same import, and insert immediately after the existing `if (!user.isActive) { throw new AppError(401, "Field user is inactive"); }` block (after line 65):

```ts
    if (isTokenStaleByEpoch(claims.iat, user.tokensValidAfter?.getTime() ?? null)) {
      throw new AppError(401, "Session expired, please sign in again");
    }
```

- [ ] **Step 4: Typecheck server**

Run: `cd server && npx tsc -p tsconfig.typecheck.json --noEmit 2>&1 | grep -E "auth.ts|field-auth.ts|service.ts" || echo "clean"`
Expected: `clean`.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/auth/service.ts server/src/middleware/auth.ts server/src/middleware/field-auth.ts
git commit -m "feat(auth): reject tokens issued before the user session epoch (CRM + field)"
```

---

## Task 6: createCrmUser service + POST /admin/users

**Files:**
- Modify: `server/src/modules/admin/users-service.ts`, `server/src/modules/admin/routes.ts`
- Test: `server/tests/admin/create-crm-user.runtime.test.ts`

- [ ] **Step 1: Write the failing service test** (validation paths are pure-enough to assert without a live DB — they throw before any insert; the duplicate/insert path is asserted via the thrown `AppError` codes using a captured db):

```ts
// server/tests/admin/create-crm-user.runtime.test.ts
import { describe, expect, it } from "vitest";
import { assertCreatableCrmUser } from "../../src/modules/admin/users-service.js";

describe("assertCreatableCrmUser (create-flow validation)", () => {
  const ok = { email: "new@trock.dev", displayName: "New User", role: "rep", officeId: "00000000-0000-0000-0000-000000000001" };
  it("accepts a valid CRM user", () => {
    expect(() => assertCreatableCrmUser(ok)).not.toThrow();
  });
  it("rejects field_contractor with 400", () => {
    expect(() => assertCreatableCrmUser({ ...ok, role: "field_contractor" })).toThrowError(/field-user flow/i);
  });
  it("rejects an unknown role with 400", () => {
    expect(() => assertCreatableCrmUser({ ...ok, role: "wizard" })).toThrow();
  });
  it("rejects a blank email", () => {
    expect(() => assertCreatableCrmUser({ ...ok, email: "  " })).toThrow();
  });
  it("rejects a blank display name", () => {
    expect(() => assertCreatableCrmUser({ ...ok, displayName: "" })).toThrow();
  });
  it("rejects a missing office", () => {
    expect(() => assertCreatableCrmUser({ ...ok, officeId: "" })).toThrow();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server && npx vitest run tests/admin/create-crm-user.runtime.test.ts`
Expected: FAIL — `assertCreatableCrmUser` not exported.

- [ ] **Step 3: Add `assertCreatableCrmUser` + `createCrmUser`** to `server/src/modules/admin/users-service.ts`. Add imports at the top (extend existing import lines):

```ts
import { isAssignableCrmRole, type CrmAssignableRole } from "@trock-crm/shared/types";
```
Then add, before `updateUser`:

```ts
export interface CreateCrmUserInput {
  email: string;
  displayName: string;
  firstName?: string | null;
  lastName?: string | null;
  role: string;
  officeId: string;
  reportsTo?: string | null;
}

// Pure, throwing validation — the create-flow's gate of record. Decision logic for the role is the
// gate-proven isAssignableCrmRole; the rest are simple presence checks.
export function assertCreatableCrmUser(input: CreateCrmUserInput): asserts input is CreateCrmUserInput & { role: CrmAssignableRole } {
  if (!input.email?.trim()) throw new AppError(400, "Email is required");
  if (!input.displayName?.trim()) throw new AppError(400, "Display name is required");
  if (!input.officeId?.trim()) throw new AppError(400, "Office is required");
  if (input.role === "field_contractor") throw new AppError(400, "Field contractors are created in the field-user flow");
  if (!isAssignableCrmRole(input.role)) throw new AppError(400, `Invalid role: ${input.role}`);
}

export async function createCrmUser(input: CreateCrmUserInput, actorUserId: string) {
  assertCreatableCrmUser(input);
  const email = input.email.trim().toLowerCase();

  const office = await db.select({ id: offices.id, isActive: offices.isActive }).from(offices).where(eq(offices.id, input.officeId)).limit(1);
  if (!office[0]) throw new AppError(400, "Office not found");
  if (!office[0].isActive) throw new AppError(400, "Office is not active");

  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (existing[0]) throw new AppError(409, "A user with this email already exists");

  const [created] = await db
    .insert(users)
    .values({
      email,
      displayName: input.displayName.trim(),
      firstName: input.firstName?.trim() || null,
      lastName: input.lastName?.trim() || null,
      role: input.role as CrmAssignableRole,
      officeId: input.officeId,
      reportsTo: input.reportsTo ?? null,
      isActive: true,
      createdByUserId: actorUserId,
    })
    .returning();
  return created;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && npx vitest run tests/admin/create-crm-user.runtime.test.ts`
Expected: PASS (6 cases).

- [ ] **Step 5: Add the `POST /admin/users` route** in `server/src/modules/admin/routes.ts`. Extend the users-service import (line 16) to include `createCrmUser`, and add the route immediately before `router.get("/admin/users/:id", ...)`:

```ts
router.post("/admin/users", requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await createCrmUser(req.body, req.user!.id);
    let invite: { sent: boolean; error?: string } = { sent: false };
    if (req.body?.sendInvite !== false) {
      try {
        await sendUserInvite({ userId: user.id, sentByUserId: req.user!.id });
        invite = { sent: true };
      } catch (e: any) {
        // The user is created regardless; surface the invite failure so the UI offers "resend".
        invite = { sent: false, error: e?.message ?? "Invite failed" };
      }
    }
    return res.status(201).json({ user, invite });
  } catch (err) {
    return next(err);
  }
});
```

- [ ] **Step 6: Typecheck server**

Run: `cd server && npx tsc -p tsconfig.typecheck.json --noEmit 2>&1 | grep -E "users-service|admin/routes" || echo "clean"`
Expected: `clean`.

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/admin/users-service.ts server/src/modules/admin/routes.ts server/tests/admin/create-crm-user.runtime.test.ts
git commit -m "feat(admin): createCrmUser + POST /admin/users (create + reuse invite)"
```

---

## Task 7: updateUser guards + session-kill wiring

**Files:**
- Modify: `server/src/modules/admin/users-service.ts` (`updateUser` signature + guards + session-kill), `server/src/modules/admin/routes.ts` (pass `actorUserId`)

- [ ] **Step 1: Widen the role type + add `actorUserId` + guards + session-kill** in `updateUser`. Add imports at the top of `users-service.ts`:

```ts
import { closeUserSseConnections, bumpTokensValidAfter, revokeLocalAuthOnDeactivate, clearLocalAuthRevocation } from "../auth/session-invalidation.js";
import { isProhibitedSelfChange, isFieldContractorTransition, wouldRemoveLastActiveAdmin } from "@trock-crm/shared/lib/userProvisioningGuards";
import type { UserRole } from "@trock-crm/shared/types";
```
Change the signature to `updateUser(id, input, actorUserId: string)` and widen `role` in the input type to `"admin" | "director" | "rep" | "construction"`. Inside the transaction, after `if (!existingUser) throw new AppError(404, "User not found");`, add the guards + session-kill. Replace the body from the `existing`/`existingUser` block through the `updated` assignment with:

```ts
    const existingUser = existing[0];
    if (!existingUser) throw new AppError(404, "User not found");

    const nextRole = input.role as UserRole | undefined;

    // --- Guards (decisions are gate-proven pure predicates) ---
    if (isProhibitedSelfChange({ actorId: actorUserId, targetId: id, nextIsActive: input.isActive, currentRole: existingUser.role, nextRole })) {
      throw new AppError(403, "You can't deactivate or change your own role");
    }
    if (isFieldContractorTransition(existingUser.role, nextRole)) {
      throw new AppError(403, "Field contractors are managed in the field-user flow");
    }
    const strippingAdmin =
      existingUser.role === "admin" && (input.isActive === false || (nextRole !== undefined && nextRole !== "admin"));
    if (strippingAdmin) {
      const [{ count }] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(users)
        .where(and(eq(users.role, "admin"), eq(users.isActive, true), sql`${users.id} <> ${id}`));
      if (wouldRemoveLastActiveAdmin({ currentRole: existingUser.role, nextRole, nextIsActive: input.isActive, otherActiveAdminCount: count })) {
        throw new AppError(409, "Cannot remove the last active admin");
      }
    }

    const updates: Record<string, unknown> = {};
    if (input.displayName !== undefined) updates.displayName = input.displayName;
    if (input.role !== undefined) updates.role = input.role;
    if (input.officeId !== undefined) updates.officeId = input.officeId;
    if (input.reportsTo !== undefined) updates.reportsTo = input.reportsTo;
    if (input.isActive !== undefined) updates.isActive = input.isActive;
    if (input.notificationPrefs !== undefined) updates.notificationPrefs = input.notificationPrefs;

    const hasBaseUserPatch = Object.keys(updates).length > 0;
    if (hasBaseUserPatch) updates.updatedAt = new Date();

    const updated = hasBaseUserPatch
      ? (await tx.update(users).set(updates).where(eq(users.id, id)).returning())[0]
      : existingUser;

    // --- Session-kill wiring ---
    const now = new Date();
    const deactivating = input.isActive === false && existingUser.isActive === true;
    const reactivating = input.isActive === true && existingUser.isActive === false;
    const roleChanged = nextRole !== undefined && nextRole !== existingUser.role;
    if (deactivating) {
      await bumpTokensValidAfter(tx as any, id, now);
      await revokeLocalAuthOnDeactivate(tx as any, id, actorUserId, now);
    } else if (reactivating) {
      await clearLocalAuthRevocation(tx as any, id, now);
    }
    if (roleChanged) {
      await bumpTokensValidAfter(tx as any, id, now);
    }
```

Then, at the very end of `updateUser` (after the transaction returns), tear down SSE outside the tx. Change `return updated;` inside the tx to keep returning `updated`, and wrap the whole `db.transaction(...)` result:

```ts
  const result = await db.transaction(async (tx) => {
    // ... everything above, ending with `return { updated, deactivated: deactivating };`
  });
  if (result.deactivated) closeUserSseConnections(id);
  return result.updated;
```

(Adjust the inner `return updated;` to `return { updated, deactivated: deactivating };` and capture `deactivating` in the tx scope.)

- [ ] **Step 2: Pass `actorUserId` from the route** — in `server/src/modules/admin/routes.ts`, change the PATCH handler (line 179) to `const user = await updateUser(req.params.id as string, req.body, req.user!.id);`.

- [ ] **Step 3: Typecheck server**

Run: `cd server && npx tsc -p tsconfig.typecheck.json --noEmit 2>&1 | grep -E "users-service|admin/routes" || echo "clean"`
Expected: `clean`.

- [ ] **Step 4: Run the guard + sse suites (regression)**

Run: `cd server && npx vitest run tests/admin/`
Expected: PASS (guards, create, sse-teardown).

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/admin/users-service.ts server/src/modules/admin/routes.ts
git commit -m "feat(admin): updateUser guards + session-kill on deactivate/role-change"
```

---

## Task 8: Client — createUser hook + Add-User dialog

**Files:**
- Modify: `client/src/hooks/use-admin-users.ts`
- Create: `client/src/pages/admin/add-user-dialog.tsx`, `client/src/pages/admin/add-user-dialog.runtime.test.tsx`

- [ ] **Step 1: Add `createUser` to the hook** — in `client/src/hooks/use-admin-users.ts`, after `updateUser` (near line 86), add:

```ts
  const createUser = async (input: {
    email: string;
    displayName: string;
    firstName?: string;
    lastName?: string;
    role: "admin" | "director" | "rep" | "construction";
    officeId: string;
    sendInvite?: boolean;
  }) => {
    return api<{ user: AdminUser; invite: { sent: boolean; error?: string } }>("/admin/users", {
      method: "POST",
      body: JSON.stringify(input),
    });
  };
```
and add `createUser` to the object the hook returns.

- [ ] **Step 2: Write the failing dialog test** (static render; asserts the role options + invite checkbox + that field_contractor is absent):

```tsx
// @vitest-environment jsdom
// client/src/pages/admin/add-user-dialog.runtime.test.tsx
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CRM_ASSIGNABLE_ROLES } from "@trock-crm/shared/types";
import { AddUserDialogBody } from "./add-user-dialog";

describe("AddUserDialogBody", () => {
  const offices = [{ id: "o1", name: "Dallas" }];
  it("offers exactly the CRM-assignable roles and never field_contractor", () => {
    const html = renderToStaticMarkup(<AddUserDialogBody offices={offices} />);
    for (const r of CRM_ASSIGNABLE_ROLES) expect(html.toLowerCase()).toContain(r);
    expect(html).not.toContain("field_contractor");
  });
  it("renders the send-invite control", () => {
    const html = renderToStaticMarkup(<AddUserDialogBody offices={offices} />);
    expect(html.toLowerCase()).toContain("invite");
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run client/src/pages/admin/add-user-dialog.runtime.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 4: Create the dialog** — `client/src/pages/admin/add-user-dialog.tsx`. Export a presentational `AddUserDialogBody` (the static-renderable fields, for the test) and a `AddUserDialog` wrapper that owns state + submit. Use the role list from shared so it can never drift:

```tsx
import { useState } from "react";
import { CRM_ASSIGNABLE_ROLES, type CrmAssignableRole } from "@trock-crm/shared/types";

export interface AddUserOffice { id: string; name: string }

// Presentational, statically renderable (no hooks needed for the field markup the test checks).
export function AddUserDialogBody({
  offices,
  value,
  onChange,
}: {
  offices: AddUserOffice[];
  value?: { email: string; displayName: string; role: CrmAssignableRole; officeId: string; sendInvite: boolean };
  onChange?: (patch: Partial<NonNullable<typeof value>>) => void;
}) {
  const v = value ?? { email: "", displayName: "", role: "rep" as CrmAssignableRole, officeId: offices[0]?.id ?? "", sendInvite: true };
  return (
    <div className="space-y-3">
      <label className="block text-sm">Email
        <input type="email" value={v.email} onChange={(e) => onChange?.({ email: e.target.value })} className="mt-1 w-full rounded border px-2 py-1" />
      </label>
      <label className="block text-sm">Name
        <input value={v.displayName} onChange={(e) => onChange?.({ displayName: e.target.value })} className="mt-1 w-full rounded border px-2 py-1" />
      </label>
      <label className="block text-sm">Role
        <select value={v.role} onChange={(e) => onChange?.({ role: e.target.value as CrmAssignableRole })} className="mt-1 w-full rounded border px-2 py-1">
          {CRM_ASSIGNABLE_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
      </label>
      <label className="block text-sm">Office
        <select value={v.officeId} onChange={(e) => onChange?.({ officeId: e.target.value })} className="mt-1 w-full rounded border px-2 py-1">
          {offices.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={v.sendInvite} onChange={(e) => onChange?.({ sendInvite: e.target.checked })} />
        Send invite email now
      </label>
    </div>
  );
}

export function AddUserDialog({
  offices,
  onCreate,
  onClose,
}: {
  offices: AddUserOffice[];
  onCreate: (input: { email: string; displayName: string; role: CrmAssignableRole; officeId: string; sendInvite: boolean }) => Promise<void>;
  onClose: () => void;
}) {
  const [value, setValue] = useState({ email: "", displayName: "", role: "rep" as CrmAssignableRole, officeId: offices[0]?.id ?? "", sendInvite: true });
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-4">
      <AddUserDialogBody offices={offices} value={value} onChange={(p) => setValue((cur) => ({ ...cur, ...p }))} />
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className="rounded px-3 py-1.5 text-sm">Cancel</button>
        <button
          type="button"
          disabled={busy || !value.email.trim() || !value.displayName.trim() || !value.officeId}
          onClick={async () => { setBusy(true); try { await onCreate(value); onClose(); } finally { setBusy(false); } }}
          className="rounded bg-slate-900 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
        >
          Create user
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Run the dialog test to verify it passes**

Run: `npx vitest run client/src/pages/admin/add-user-dialog.runtime.test.tsx`
Expected: PASS (2 cases).

- [ ] **Step 6: Commit**

```bash
git add client/src/hooks/use-admin-users.ts client/src/pages/admin/add-user-dialog.tsx client/src/pages/admin/add-user-dialog.runtime.test.tsx
git commit -m "feat(admin-ui): createUser hook + Add-User dialog"
```

---

## Task 9: Wire the dialog + construction role + deactivate confirm into users-page

**Files:**
- Modify: `client/src/pages/admin/users-page.tsx`

- [ ] **Step 1: Add the role to the edit select + the Add-User button + deactivate confirm.** In `users-page.tsx`:
  - Import: `import { AddUserDialog } from "./add-user-dialog";` and pull `createUser` from `useAdminUsers()` (alongside the existing `updateUser`, `sendInvite`, etc.).
  - Widen the local role union used by the role `<select>` and `handleBulkUpdate` from `"admin" | "director" | "rep"` to `"admin" | "director" | "rep" | "construction"`, and add `<SelectItem value="construction">Construction</SelectItem>` (or `<option>`, matching the existing select) wherever roles are listed.
  - Add an "Add User" button near the page header that opens the `AddUserDialog` (in the existing dialog/modal pattern on the page), wiring `onCreate={async (input) => { const r = await createUser(input); toast.success(r.invite.sent ? "User created and invited" : "User created — invite failed, resend from the row"); await refetch(); }}`.
  - Replace `handleToggleActive(userId, true)` (the deactivate direction, where `isActive` is currently `true`) with a confirm: only when deactivating, `if (!window.confirm("Deactivate this user? This signs them out of all sessions immediately.")) return;` before calling `updateUser(userId, { isActive: false })`. Reactivation stays a direct toggle.

  (Use the page's existing toast + dialog primitives; do not introduce a new modal library. Base UI `<Select>` needs an `items` prop — see `[[base-ui-select-items-label]]`.)

- [ ] **Step 2: Typecheck client**

Run: `cd client && npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E "users-page|add-user-dialog" || echo "clean"`
Expected: `clean`.

- [ ] **Step 3: Commit**

```bash
git add client/src/pages/admin/users-page.tsx
git commit -m "feat(admin-ui): Add-User button, construction role, deactivate confirm"
```

---

## Task 10: Full gate + manual smoke

- [ ] **Step 1: Run the full premerge gate**

Run: `npm run check:premerge`
Expected: build OK; `typecheck:tests:all` clean; `test:runtime` PASSES — including the new server runtime tests (`user-provisioning-guards`, `create-crm-user`, `sse-teardown`) and the client `add-user-dialog.runtime.test.tsx`.

- [ ] **Step 2: Manual smoke (recommended).** Run the app; as an admin on the Users tab: Add a user (verify created + invite email / temp-password flow), deactivate a user (verify they're signed out — next request 401, re-login blocked), reactivate (verify login works again), change a role (verify forced re-auth), and confirm the guards fire (self-deactivate blocked, last-admin blocked, field_contractor transition blocked). Use the `verify`/`run` skill.

- [ ] **Step 3: Push + open PR for review** (Adnaan merges — no self-merge):

```bash
git push -u origin feat/admin-user-provisioning
```
PR body: note the session-kill bundle (epoch + revoked_at + SSE), the gate-proven security predicates, global-admin scope, and that field_contractor stays in its own flow.

---

## Self-Review Notes

- **Spec coverage:** Add (Task 6, 8, 9) · deactivate + session-kill (Tasks 3-5, 7) · reactivate (Task 7) · role change + epoch (Task 7) · guards all four (Task 7 + 9 confirm dialog) · gate-proven predicates (Task 2 + the gate list) · UI (Tasks 8-9) · global admin (no office-scoping task, by decision). The four guard predicates, `isTokenStaleByEpoch`, and `isAssignableCrmRole` are each gate-executed (Task 2 / Task 6 Step 1).
- **Type consistency:** `CrmAssignableRole`/`CRM_ASSIGNABLE_ROLES`/`isAssignableCrmRole` (Task 1) reused in Tasks 2, 6, 8. `tokensValidAfter` (Task 3) read in Task 5, written in Tasks 4/7. Predicate signatures in Task 2 match every call site in Tasks 5, 7. `createCrmUser`/`assertCreatableCrmUser` (Task 6) match the route + test.
- **Placeholder scan:** the only non-literal is the migration number, resolved to `0161` (verified: highest is `0160`). No TBD/TODO; all code steps show full code.
- **Risk note:** Task 7 restructures `updateUser`'s transaction return shape (`{ updated, deactivated }`) to allow post-commit SSE teardown — the diff is shown; keep the commission-patch block below it unchanged.
