# Invite Hardening And Volume Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the temporary local-auth invite flow with preview, revocation, expiry, lockout, and audit history, then add repeatable volume-validation coverage that can be run without sending emails.

**Architecture:** Extend the public local-auth schema with expiry and lockout state, add an append-only auth event table, implement preview/revoke/event endpoints in the admin/auth modules, expand the Admin > Users screen with richer state and actions, and add a Playwright-based volume-validation script that exercises the high-volume admin flow without sending invite emails.

**Tech Stack:** Express, Drizzle ORM, PostgreSQL, React, Base UI dialog/sheet components, Vitest, Playwright CLI/script automation

---

### Task 1: Extend Public Local-Auth Schema

**Files:**
- Modify: `shared/src/schema/public/user-local-auth.ts`
- Create: `shared/src/schema/public/user-local-auth-events.ts`
- Modify: `shared/src/schema/public/index.ts`
- Modify: `shared/src/schema/index.ts`
- Create: `migrations/0040_local_auth_hardening.sql`
- Test: `server/tests/modules/auth/local-auth-service.test.ts`

- [ ] **Step 1: Write the failing schema contract test**

```ts
import { describe, expect, it } from "vitest";
import { userLocalAuth, userLocalAuthEvents } from "@trock-crm/shared/schema";

describe("local auth hardening schema", () => {
  it("exposes expiry and lockout columns", () => {
    expect(userLocalAuth.inviteExpiresAt.name).toBe("invite_expires_at");
    expect(userLocalAuth.failedLoginAttempts.name).toBe("failed_login_attempts");
    expect(userLocalAuth.lockedUntil.name).toBe("locked_until");
    expect(userLocalAuth.revokedAt.name).toBe("revoked_at");
  });

  it("exports the local auth events table", () => {
    expect(userLocalAuthEvents.userId.name).toBe("user_id");
    expect(userLocalAuthEvents.eventType.name).toBe("event_type");
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run server/tests/modules/auth/local-auth-service.test.ts`
Expected: FAIL because the new columns/table are not exported yet.

- [ ] **Step 3: Add schema fields and the events table**

```ts
// shared/src/schema/public/user-local-auth.ts
inviteExpiresAt: timestamp("invite_expires_at", { withTimezone: true }),
failedLoginAttempts: integer("failed_login_attempts").default(0).notNull(),
lastFailedLoginAt: timestamp("last_failed_login_at", { withTimezone: true }),
lockedUntil: timestamp("locked_until", { withTimezone: true }),
revokedAt: timestamp("revoked_at", { withTimezone: true }),
revokedByUserId: uuid("revoked_by_user_id"),
```

```ts
// shared/src/schema/public/user-local-auth-events.ts
export const localAuthEventTypeEnum = pgEnum("local_auth_event_type", [
  "invite_previewed",
  "invite_sent",
  "invite_resent",
  "invite_revoked",
  "login_succeeded",
  "login_failed",
  "login_locked",
  "password_changed",
]);
```

- [ ] **Step 4: Add migration SQL**

```sql
ALTER TABLE user_local_auth
  ADD COLUMN invite_expires_at timestamptz,
  ADD COLUMN failed_login_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN last_failed_login_at timestamptz,
  ADD COLUMN locked_until timestamptz,
  ADD COLUMN revoked_at timestamptz,
  ADD COLUMN revoked_by_user_id uuid;

CREATE TYPE local_auth_event_type AS ENUM (
  'invite_previewed',
  'invite_sent',
  'invite_resent',
  'invite_revoked',
  'login_succeeded',
  'login_failed',
  'login_locked',
  'password_changed'
);

CREATE TABLE user_local_auth_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  event_type local_auth_event_type NOT NULL,
  actor_user_id uuid,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

- [ ] **Step 5: Run typecheck/test and commit**

Run: `npm run typecheck && npx vitest run server/tests/modules/auth/local-auth-service.test.ts`
Expected: schema compiles; remaining failures move to service logic.

```bash
git add shared/src/schema/public/user-local-auth.ts shared/src/schema/public/user-local-auth-events.ts shared/src/schema/public/index.ts shared/src/schema/index.ts migrations/0040_local_auth_hardening.sql
git commit -m "feat: extend local auth schema for hardening"
```

### Task 2: Harden Local-Auth Service Logic

**Files:**
- Modify: `server/src/modules/auth/local-auth-service.ts`
- Modify: `server/src/modules/auth/service.ts`
- Modify: `shared/src/types/auth.ts`
- Test: `server/tests/modules/auth/local-auth-service.test.ts`
- Test: `server/tests/modules/auth/local-auth-routes.test.ts`

- [ ] **Step 1: Write the failing service tests**

```ts
it("builds an invite preview without provisioning credentials", async () => {
  const preview = await previewUserInvite({ userId: user.id, actorUserId: admin.id });
  expect(preview.subject).toContain("T Rock CRM");
  expect(preview.html).toContain(user.email);
  expect(preview.html).toContain("generated when the invite is sent");
});

it("locks the user after five failed login attempts", async () => {
  for (let index = 0; index < 5; index += 1) {
    await expect(loginWithLocalPassword({ email: user.email, password: "wrong-pass" })).rejects.toThrow();
  }
  const gate = await getUserLocalAuthGate(user.id);
  expect(gate.lockedUntil).not.toBeNull();
});

it("rejects expired invite credentials", async () => {
  await expect(loginWithLocalPassword({ email: user.email, password: tempPassword })).rejects.toThrow(/expired/i);
});

it("revokes local auth access", async () => {
  await revokeUserInvite({ userId: user.id, actorUserId: admin.id });
  expect(getLocalAuthStatus(await loadLocalAuth(user.id))).toBe("disabled");
});
```

- [ ] **Step 2: Run the service tests and confirm failure**

Run: `npx vitest run server/tests/modules/auth/local-auth-service.test.ts`
Expected: FAIL because preview/revoke/lockout/expiry behavior does not exist yet.

- [ ] **Step 3: Add shared constants and event logging helpers**

```ts
const INVITE_TTL_HOURS = 72;
const MAX_FAILED_LOGIN_ATTEMPTS = 5;
const LOCKOUT_WINDOW_MINUTES = 15;
```

```ts
function buildInviteEmailContent(...) { ... }
async function recordLocalAuthEvent(...) { ... }
function computeInviteExpiry(now: Date) { ... }
function computeLockoutUntil(now: Date) { ... }
```

- [ ] **Step 4: Implement preview, send, revoke, expiry, and lockout**

Code requirements:
- `buildInviteEmailContent` is the single renderer used by both preview and send
- `previewUserInvite` returns subject/html/text with a redacted password placeholder and writes `invite_previewed`
- `sendUserInvite` provisions/rotates password, sets `inviteExpiresAt`, clears failure state, and writes `invite_sent` or `invite_resent`
- `revokeUserInvite` disables local auth, stamps revocation fields, and writes `invite_revoked`
- `loginWithLocalPassword` rejects lockouts before password verification, increments failures on bad passwords, locks at threshold, rejects expired invites, clears counters on success, and writes success/failure/lock events
- `changeLocalPassword` clears expiry/failure/lock fields and writes `password_changed`
- extend `JwtClaims` with `authMethod: "local" | "dev"`
- local-session JWT signing writes `authMethod: "local"`
- dev-session JWT signing writes `authMethod: "dev"`
- auth middleware treats missing `authMethod` as a legacy pre-deploy session and rejects it so every surviving session after rollout has an explicit auth source

- [ ] **Step 5: Run tests and commit**

Run: `npx vitest run server/tests/modules/auth/local-auth-service.test.ts server/tests/modules/auth/local-auth-routes.test.ts`
Expected: PASS for preview/revoke/lockout/expiry coverage.

```bash
git add server/src/modules/auth/local-auth-service.ts server/src/modules/auth/service.ts shared/src/types/auth.ts server/tests/modules/auth/local-auth-service.test.ts server/tests/modules/auth/local-auth-routes.test.ts
git commit -m "feat: harden local auth service flow"
```

### Task 3: Add Admin/Auth Routes For Hardening

**Files:**
- Modify: `server/src/modules/admin/routes.ts`
- Modify: `server/src/modules/admin/users-service.ts`
- Modify: `server/src/modules/auth/routes.ts`
- Test: `server/tests/modules/admin/user-invite-routes.test.ts`
- Test: `server/tests/modules/auth/local-auth-routes.test.ts`

- [ ] **Step 1: Write the failing route tests**

```ts
it("returns invite preview content without sending email", async () => {
  const res = await request(app)
    .post(`/api/admin/users/${user.id}/preview-invite`)
    .set("Cookie", adminCookie);

  expect(res.status).toBe(200);
  expect(res.body.preview.subject).toContain("T Rock CRM");
});

it("revokes local auth from the admin route", async () => {
  const res = await request(app)
    .post(`/api/admin/users/${user.id}/revoke-invite`)
    .set("Cookie", adminCookie);

  expect(res.status).toBe(200);
  expect(res.body.success).toBe(true);
});

it("returns a lockout error once the threshold is exceeded", async () => {
  const res = await request(app)
    .post("/api/auth/local/login")
    .send({ email: user.email, password: "wrong-pass" });

  expect([401, 423]).toContain(res.status);
});
```

- [ ] **Step 2: Run the route tests and confirm failure**

Run: `npx vitest run server/tests/modules/admin/user-invite-routes.test.ts server/tests/modules/auth/local-auth-routes.test.ts`
Expected: FAIL because the new routes and expanded payloads do not exist yet.

- [ ] **Step 3: Add admin endpoints and richer users payloads**

Code requirements:
- `POST /api/admin/users/:id/preview-invite`
- `POST /api/admin/users/:id/revoke-invite`
- `GET /api/admin/users/:id/local-auth-events`
- extend `getUsersWithStats()` to include invite expiry, last login, password-changed timestamp, lockout, revocation, and last auth event summary

- [ ] **Step 4: Update auth routes to surface deterministic errors**

Code requirements:
- map expired invites to `403`
- map active lockouts to `423`
- update the auth middleware so revoked/disabled local-auth rows reject requests for `authMethod: "local"` sessions
- return preview/send/revoke payloads that the UI can render directly

- [ ] **Step 5: Run tests and commit**

Run: `npx vitest run server/tests/modules/admin/user-invite-routes.test.ts server/tests/modules/auth/local-auth-routes.test.ts`
Expected: PASS for preview/revoke/login hardening routes.

```bash
git add server/src/modules/admin/routes.ts server/src/modules/admin/users-service.ts server/src/modules/auth/routes.ts server/tests/modules/admin/user-invite-routes.test.ts server/tests/modules/auth/local-auth-routes.test.ts
git commit -m "feat: expose invite hardening routes"
```

### Task 4: Expand Admin > Users UI For Hardening

**Files:**
- Modify: `client/src/hooks/use-admin-users.ts`
- Modify: `client/src/pages/admin/users-page.tsx`
- Create: `client/src/pages/admin/user-invite-preview-dialog.tsx`
- Create: `client/src/pages/admin/user-local-auth-events-dialog.tsx`
- Test: `client/src/pages/admin/users-page.helpers.test.ts`
- Test: `client/src/components/layout/app-shell-layout.test.tsx`
- Test: `client/src/pages/admin/users-page.test.tsx`

- [ ] **Step 1: Write the failing UI tests**

```tsx
it("opens the invite preview dialog without sending email", async () => {
  render(<UsersPage />);
  await user.click(screen.getByRole("button", { name: /preview invite/i }));
  expect(await screen.findByText(/generated when the invite is sent/i)).toBeInTheDocument();
});

it("shows lockout and expiry metadata in the login column", () => {
  render(<UsersPage />);
  expect(screen.getByText(/locked until/i)).toBeInTheDocument();
  expect(screen.getByText(/invite expires/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the UI tests and confirm failure**

Run: `npx vitest run client/src/pages/admin/users-page.test.tsx client/src/components/layout/app-shell-layout.test.tsx`
Expected: FAIL because preview/revoke/event UI does not exist.

- [ ] **Step 3: Extend the admin-users hook**

Code requirements:
- add `previewInvite(userId)`
- add `revokeInvite(userId)`
- add `getLocalAuthEvents(userId)`
- expand `AdminUser` type with expiry/lockout/login/revocation fields

- [ ] **Step 4: Add dialogs and richer table states**

Code requirements:
- add `Preview invite` action
- add `Revoke access` action when local auth is present
- render login-state metadata beneath the status badge
- add event-history affordance for each user
- keep `Send invite` intact but do not auto-open it during validation

- [ ] **Step 5: Run tests and commit**

Run: `npx vitest run client/src/pages/admin/users-page.test.tsx client/src/pages/admin/users-page.helpers.test.ts client/src/components/layout/app-shell-layout.test.tsx`
Expected: PASS for preview/revoke/history/login metadata UI.

```bash
git add client/src/hooks/use-admin-users.ts client/src/pages/admin/users-page.tsx client/src/pages/admin/user-invite-preview-dialog.tsx client/src/pages/admin/user-local-auth-events-dialog.tsx client/src/pages/admin/users-page.test.tsx client/src/components/layout/app-shell-layout.test.tsx
git commit -m "feat: harden admin users invite workflow"
```

### Task 5: Add Repeatable Volume-Validation Automation

**Files:**
- Create: `scripts/playwright-admin-users-volume-validation.mjs`
- Create: `docs/superpowers/reports/2026-04-20-admin-users-volume-validation.md`
- Test: execution against local/prod target

- [ ] **Step 1: Write the automation outline script**

```js
// scripts/playwright-admin-users-volume-validation.mjs
// 1. open target URL
// 2. sign in using either dev-picker mode or local-credentials mode
// 3. open /admin/users
// 4. assert summary cards + search/filter controls
// 5. search for rep@trock.dev
// 6. open preview dialog
// 7. optionally revoke and restore on explicit flag
// 8. print PASS/FAIL summary
```

- [ ] **Step 2: Run the script locally and confirm the first failure**

Run: `node scripts/playwright-admin-users-volume-validation.mjs`
Expected: FAIL until selectors and flows are wired up against the new UI.

- [ ] **Step 3: Finish the script and add a short run report template**

Code requirements:
- accept `TARGET_URL`
- accept `AUTH_MODE=dev-picker|local-credentials`
- accept `AUTH_EMAIL` and `AUTH_PASSWORD` for production/staging test-admin runs
- accept `TARGET_TEST_USER_EMAIL` and require it in credential mode
- use only maintained internal test accounts such as `admin@trock.dev` and `rep@trock.dev`
- default to no-email path
- never click `Send invite`
- emit non-zero exit code on validation failures

- [ ] **Step 4: Run validation and commit**

Run: `node scripts/playwright-admin-users-volume-validation.mjs`
Expected: PASS summary printed to stdout and written to the report file.

```bash
git add scripts/playwright-admin-users-volume-validation.mjs docs/superpowers/reports/2026-04-20-admin-users-volume-validation.md
git commit -m "test: add admin users volume validation script"
```

### Task 6: Final Verification, Review, Merge, And Deploy

**Files:**
- Verify all files touched above

- [ ] **Step 1: Run full targeted verification**

Run:

```bash
npx vitest run server/tests/modules/auth/local-auth-service.test.ts server/tests/modules/admin/user-invite-routes.test.ts server/tests/modules/auth/local-auth-routes.test.ts client/src/pages/admin/users-page.test.tsx client/src/pages/admin/users-page.helpers.test.ts client/src/components/layout/app-shell-layout.test.tsx
npm run typecheck
npm run build --workspace=client
```

Expected: PASS with no new test failures.

- [ ] **Step 2: Request code review and fix all important findings**

Review scope:
- invite preview/send/revoke semantics
- expiry/lockout behavior
- UI state correctness
- automation script safety

- [ ] **Step 3: Merge and push**

```bash
git push origin HEAD:main
```

- [ ] **Step 4: Wait for Railway to deploy the pushed commit**

Run:

```bash
railway status --json
curl -sS https://api-production-ad218.up.railway.app/api/health
curl -sS https://frontend-production-bcab.up.railway.app
```

Expected: production Frontend/API/Worker show the pushed commit and `/api/health` returns `200`.

- [ ] **Step 5: Run the production validation loop**

Run:

```bash
node scripts/playwright-admin-users-volume-validation.mjs
```

Expected: PASS against the live high-volume Users page without sending any emails.

- [ ] **Step 6: If any issue appears, fix, redeploy, and rerun Step 5 before closing**

Close only after:
- Railway is green on the final commit
- production browser validation passes
- no invite email was sent during testing
