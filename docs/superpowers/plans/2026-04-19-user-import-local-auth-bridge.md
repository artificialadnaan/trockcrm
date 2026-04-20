# User Import And Local Auth Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import the union of Procore users and HubSpot owners into CRM conservatively, surface them in Admin > Users, and add a temporary invite-based local login flow with forced password change.

**Architecture:** Add a public-schema external identity mapping table plus a separate local-auth credential table, implement a server-side import service and invite/login endpoints, then extend the admin users UI and auth shell to support invite sending and forced password change without disturbing the existing JWT cookie model.

**Tech Stack:** Express, Drizzle ORM, PostgreSQL, React, Vitest, Resend, existing Procore and HubSpot integration clients

---

### Task 1: Add Public Schema Support For External Identity And Local Auth

**Files:**
- Create: `shared/src/schema/public/user-external-identities.ts`
- Create: `shared/src/schema/public/user-local-auth.ts`
- Modify: `shared/src/schema/public/index.ts`
- Modify: `shared/src/schema/index.ts`
- Create: `migrations/0038_user_import_local_auth.sql`
- Test: `server/tests/modules/admin/user-import-service.test.ts`
- Test: `server/tests/modules/auth/local-auth-routes.test.ts`

- [ ] **Step 1: Write the failing schema contract tests**

```ts
import { describe, expect, it } from "vitest";
import { userExternalIdentities, userLocalAuth } from "@trock-crm/shared/schema";

describe("user import auth schema", () => {
  it("exports external identity columns", () => {
    expect(userExternalIdentities.userId.name).toBe("user_id");
    expect(userExternalIdentities.sourceSystem.name).toBe("source_system");
    expect(userExternalIdentities.externalUserId.name).toBe("external_user_id");
  });

  it("exports local auth columns", () => {
    expect(userLocalAuth.userId.name).toBe("user_id");
    expect(userLocalAuth.passwordHash.name).toBe("password_hash");
    expect(userLocalAuth.mustChangePassword.name).toBe("must_change_password");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/modules/admin/user-import-service.test.ts`
Expected: FAIL with missing schema exports or import errors for `userExternalIdentities` and `userLocalAuth`.

- [ ] **Step 3: Add shared schema files and exports**

```ts
// shared/src/schema/public/user-external-identities.ts
import { pgTable, uuid, varchar, timestamp, uniqueIndex, pgEnum } from "drizzle-orm/pg-core";
import { users } from "./users.js";

export const externalUserSourceEnum = pgEnum("external_user_source", ["hubspot", "procore"]);

export const userExternalIdentities = pgTable("user_external_identities", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id).notNull(),
  sourceSystem: externalUserSourceEnum("source_system").notNull(),
  externalUserId: varchar("external_user_id", { length: 255 }).notNull(),
  externalEmail: varchar("external_email", { length: 255 }),
  externalDisplayName: varchar("external_display_name", { length: 255 }),
  lastImportedAt: timestamp("last_imported_at", { withTimezone: true }).defaultNow().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("user_external_identities_source_uidx").on(table.sourceSystem, table.externalUserId),
]);
```

```ts
// shared/src/schema/public/user-local-auth.ts
import { pgTable, uuid, text, boolean, timestamp } from "drizzle-orm/pg-core";
import { users } from "./users.js";

export const userLocalAuth = pgTable("user_local_auth", {
  userId: uuid("user_id").primaryKey().references(() => users.id),
  passwordHash: text("password_hash").notNull(),
  mustChangePassword: boolean("must_change_password").default(true).notNull(),
  isEnabled: boolean("is_enabled").default(true).notNull(),
  inviteSentAt: timestamp("invite_sent_at", { withTimezone: true }),
  inviteSentByUserId: uuid("invite_sent_by_user_id"),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  passwordChangedAt: timestamp("password_changed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
```

```ts
// shared/src/schema/public/index.ts
export { userExternalIdentities, externalUserSourceEnum } from "./user-external-identities.js";
export { userLocalAuth } from "./user-local-auth.js";
```

- [ ] **Step 4: Add SQL migration**

```sql
CREATE TYPE external_user_source AS ENUM ('hubspot', 'procore');

CREATE TABLE user_external_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  source_system external_user_source NOT NULL,
  external_user_id varchar(255) NOT NULL,
  external_email varchar(255),
  external_display_name varchar(255),
  last_imported_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX user_external_identities_source_uidx
  ON user_external_identities(source_system, external_user_id);

CREATE TABLE user_local_auth (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  password_hash text NOT NULL,
  must_change_password boolean NOT NULL DEFAULT true,
  is_enabled boolean NOT NULL DEFAULT true,
  invite_sent_at timestamptz,
  invite_sent_by_user_id uuid,
  last_login_at timestamptz,
  password_changed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

- [ ] **Step 5: Run tests to verify schema changes pass**

Run: `npm run typecheck && npx vitest run server/tests/modules/admin/user-import-service.test.ts`
Expected: schema exports compile; remaining failures now move to missing services/routes instead of missing tables.

- [ ] **Step 6: Commit**

```bash
git add shared/src/schema/public/user-external-identities.ts shared/src/schema/public/user-local-auth.ts shared/src/schema/public/index.ts shared/src/schema/index.ts migrations/0038_user_import_local_auth.sql
git commit -m "feat: add user import and local auth schema"
```

### Task 2: Implement Conservative Union Import Service

**Files:**
- Create: `server/src/modules/admin/user-import-service.ts`
- Modify: `server/src/modules/migration/hubspot-client.ts`
- Modify: `server/src/lib/procore-client.ts`
- Modify: `server/src/modules/admin/users-service.ts`
- Test: `server/tests/modules/admin/user-import-service.test.ts`

- [ ] **Step 1: Write the failing import service tests**

```ts
it("creates new Dallas rep users from the union of hubspot and procore", async () => {
  const result = await importExternalUsers({
    dallasOfficeSlug: "dallas",
    fetchHubspotOwners: async () => [{ id: "hs-1", email: "rep1@example.com", firstName: "Rep", lastName: "One" }],
    fetchProcoreUsers: async () => [{ id: 44, email_address: "rep2@example.com", name: "Rep Two" }],
  });

  expect(result.createdCount).toBe(2);
  expect(result.matchedExistingCount).toBe(0);
});

it("preserves role and office for existing CRM users matched by email", async () => {
  const existing = await seedUser({ email: "director@example.com", role: "director", officeSlug: "houston" });

  const result = await importExternalUsers({
    dallasOfficeSlug: "dallas",
    fetchHubspotOwners: async () => [{ id: "hs-2", email: existing.email, firstName: "Updated", lastName: "Name" }],
    fetchProcoreUsers: async () => [],
  });

  const refreshed = await getUserByEmail(existing.email);
  expect(result.matchedExistingCount).toBe(1);
  expect(refreshed?.role).toBe("director");
  expect(refreshed?.officeId).toBe(existing.officeId);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/modules/admin/user-import-service.test.ts`
Expected: FAIL with `importExternalUsers` missing and no Procore user fetcher for people records.

- [ ] **Step 3: Add source fetch helpers**

```ts
// server/src/modules/migration/hubspot-client.ts
export async function fetchAllOwners(): Promise<HubSpotOwner[]> {
  return fetchAllPages<HubSpotOwner>(
    (after) => {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (after) params.set("after", after);
      return `/crm/v3/owners?${params}`;
    },
    (body) => body.results ?? [],
    (body) => body.paging?.next?.after
  );
}
```

```ts
// server/src/lib/procore-client.ts
export interface ProcoreUser {
  id: number;
  name?: string;
  first_name?: string;
  last_name?: string;
  email_address?: string;
}

export function listProcoreUsers(companyId?: string) {
  const targetCompanyId = companyId ?? process.env.PROCORE_COMPANY_ID ?? "";
  if (!targetCompanyId) throw new Error("PROCORE_COMPANY_ID is required to list Procore users");
  return procoreFetch<ProcoreUser[]>("GET", `/rest/v1.0/companies/${targetCompanyId}/users`);
}
```

- [ ] **Step 4: Implement union import service**

```ts
// server/src/modules/admin/user-import-service.ts
export async function importExternalUsers(options?: {
  dallasOfficeSlug?: string;
  fetchHubspotOwners?: typeof fetchAllOwners;
  fetchProcoreUsers?: typeof listProcoreUsers;
}) {
  const office = await getOfficeBySlug(options?.dallasOfficeSlug ?? "dallas");
  if (!office || !office.isActive) throw new AppError(400, "Dallas office is missing or inactive");

  const [hubspotOwners, procoreUsers] = await Promise.all([
    (options?.fetchHubspotOwners ?? fetchAllOwners)(),
    (options?.fetchProcoreUsers ?? listProcoreUsers)(),
  ]);

  const candidates = normalizeExternalUsers(hubspotOwners, procoreUsers);
  const summary = { scannedCount: candidates.length, createdCount: 0, matchedExistingCount: 0, skippedCount: 0, warnings: [] as string[] };

  for (const candidate of candidates) {
    const existing = await getUserByEmail(candidate.email);
    const user = existing ?? await createImportedUser({
      email: candidate.email,
      displayName: candidate.displayName,
      role: "rep",
      officeId: office.id,
    });

    if (existing) {
      summary.matchedExistingCount += 1;
    } else {
      summary.createdCount += 1;
    }

    await upsertExternalIdentities(user.id, candidate.identities);
  }

  return summary;
}
```

- [ ] **Step 5: Run tests to verify import behavior passes**

Run: `npx vitest run server/tests/modules/admin/user-import-service.test.ts`
Expected: PASS for union import, conservative matching, invalid-email skipping, and external identity linking.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/admin/user-import-service.ts server/src/modules/migration/hubspot-client.ts server/src/lib/procore-client.ts server/src/modules/admin/users-service.ts server/tests/modules/admin/user-import-service.test.ts
git commit -m "feat: import users from hubspot and procore"
```

### Task 3: Add Admin Import And Invite Endpoints Plus Invite Email Delivery

**Files:**
- Modify: `server/src/modules/admin/routes.ts`
- Modify: `server/src/modules/admin/users-service.ts`
- Modify: `server/src/api-spec.ts`
- Create: `server/src/modules/auth/local-auth-service.ts`
- Create: `server/src/modules/admin/user-invite-email.ts`
- Test: `server/tests/modules/admin/user-invite-routes.test.ts`
- Test: `server/tests/modules/auth/local-auth-service.test.ts`

- [ ] **Step 1: Write the failing route and invite tests**

```ts
it("allows admins to trigger a one-shot external user import", async () => {
  const res = await request(app).post("/api/admin/users/import-external").set("Cookie", adminCookie);
  expect(res.status).toBe(200);
  expect(res.body.summary.createdCount).toBeGreaterThanOrEqual(0);
});

it("sends an invite and provisions local auth", async () => {
  const res = await request(app).post(`/api/admin/users/${user.id}/send-invite`).set("Cookie", adminCookie);
  expect(res.status).toBe(200);
  expect(res.body.success).toBe(true);
  expect(sendSystemEmail).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/modules/admin/user-invite-routes.test.ts`
Expected: FAIL with missing admin routes and missing local auth service.

- [ ] **Step 3: Add local auth provisioning and password rotation service**

```ts
// server/src/modules/auth/local-auth-service.ts
import crypto from "crypto";
import bcrypt from "bcryptjs";

export async function provisionTemporaryLocalAuth(input: { userId: string; invitedByUserId: string }) {
  const temporaryPassword = crypto.randomBytes(12).toString("base64url");
  const passwordHash = await bcrypt.hash(temporaryPassword, 12);

  await db.insert(userLocalAuth).values({
    userId: input.userId,
    passwordHash,
    mustChangePassword: true,
    isEnabled: true,
    inviteSentAt: new Date(),
    inviteSentByUserId: input.invitedByUserId,
    updatedAt: new Date(),
  }).onConflictDoUpdate({
    target: userLocalAuth.userId,
    set: {
      passwordHash,
      mustChangePassword: true,
      isEnabled: true,
      inviteSentAt: new Date(),
      inviteSentByUserId: input.invitedByUserId,
      updatedAt: new Date(),
    },
  });

  return { temporaryPassword };
}
```

- [ ] **Step 4: Add invite email builder and admin routes**

```ts
// server/src/modules/admin/users-service.ts
export async function getUsersWithStats() {
  const result = await db.execute(sql`
    SELECT
      u.id,
      u.email,
      u.display_name,
      u.role,
      u.office_id,
      u.is_active,
      o.name AS office_name,
      COUNT(DISTINCT uoa.office_id)::int AS extra_office_count,
      COALESCE(array_remove(array_agg(DISTINCT uei.source_system), NULL), '{}') AS source_systems,
      CASE
        WHEN ula.user_id IS NULL THEN 'not_invited'
        WHEN ula.must_change_password = true THEN 'must_change_password'
        WHEN ula.invite_sent_at IS NOT NULL AND ula.password_changed_at IS NULL THEN 'invite_sent'
        ELSE 'active'
      END AS local_auth_status
    FROM users u
    LEFT JOIN offices o ON o.id = u.office_id
    LEFT JOIN user_office_access uoa ON uoa.user_id = u.id
    LEFT JOIN user_external_identities uei ON uei.user_id = u.id
    LEFT JOIN user_local_auth ula ON ula.user_id = u.id
    GROUP BY u.id, o.name, ula.user_id, ula.must_change_password, ula.invite_sent_at, ula.password_changed_at
    ORDER BY u.display_name ASC
  `);

  return rows.map((r: any) => ({
    id: r.id,
    email: r.email,
    displayName: r.display_name,
    role: r.role,
    officeId: r.office_id,
    officeName: r.office_name,
    isActive: r.is_active,
    extraOfficeCount: Number(r.extra_office_count ?? 0),
    sourceSystems: r.source_systems ?? [],
    localAuthStatus: r.local_auth_status,
  }));
}
```

```ts
// server/src/modules/admin/user-invite-email.ts
export function buildUserInviteEmail(input: {
  displayName: string;
  email: string;
  temporaryPassword: string;
  loginUrl: string;
}) {
  return {
    subject: "Your T Rock CRM login",
    html: `
      <p>Hi ${input.displayName},</p>
      <p>Your T Rock CRM account is ready.</p>
      <p>Email: ${input.email}<br />Temporary password: ${input.temporaryPassword}</p>
      <p>Log in here: <a href="${input.loginUrl}">${input.loginUrl}</a></p>
      <p>You will be required to change your password immediately after logging in.</p>
    `,
  };
}
```

```ts
// server/src/modules/admin/routes.ts
router.post("/admin/users/import-external", requireAdmin, async (req, res, next) => {
  try {
    const summary = await importExternalUsers();
    return res.json({ summary });
  } catch (err) {
    return next(err);
  }
});

router.post("/admin/users/:id/send-invite", requireAdmin, async (req, res, next) => {
  try {
    const user = await getUserById(req.params.id as string);
    if (!user) return res.status(404).json({ error: "User not found" });

    const { temporaryPassword } = await provisionTemporaryLocalAuth({
      userId: user.id,
      invitedByUserId: req.user!.id,
    });

    const email = buildUserInviteEmail({
      displayName: user.displayName,
      email: user.email,
      temporaryPassword,
      loginUrl: `${process.env.FRONTEND_URL || "http://localhost:5173"}/login`,
    });

    await sendSystemEmail(user.email, email.subject, email.html);
    return res.json({ success: true });
  } catch (err) {
    return next(err);
  }
});
```

```ts
// server/src/api-spec.ts
"/api/admin/users/import-external": {
  post: {
    summary: "Import union of Procore users and HubSpot owners",
  },
},
"/api/admin/users/{id}/send-invite": {
  post: {
    summary: "Send or resend a temporary local-auth invite",
  },
},
```

- [ ] **Step 5: Run tests to verify import and invite endpoints pass**

Run: `npx vitest run server/tests/modules/admin/user-invite-routes.test.ts server/tests/modules/auth/local-auth-service.test.ts`
Expected: PASS for import summary responses, invite send behavior, and rotated temporary password provisioning.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/admin/routes.ts server/src/modules/admin/users-service.ts server/src/api-spec.ts server/src/modules/auth/local-auth-service.ts server/src/modules/admin/user-invite-email.ts server/tests/modules/admin/user-invite-routes.test.ts server/tests/modules/auth/local-auth-service.test.ts
git commit -m "feat: add admin import and invite actions"
```

### Task 4: Add Temporary Local Login And Forced Password Change

**Files:**
- Modify: `server/src/modules/auth/routes.ts`
- Modify: `server/src/modules/auth/service.ts`
- Modify: `server/src/middleware/auth.ts`
- Create: `server/tests/modules/auth/local-auth-routes.test.ts`
- Modify: `client/src/lib/auth.tsx`
- Create: `client/src/pages/login-page.tsx`
- Create: `client/src/pages/change-password-page.tsx`
- Modify: `client/src/App.tsx`
- Test: `client/src/lib/auth.test.tsx`

- [ ] **Step 1: Write the failing auth flow tests**

```ts
it("logs in with local email and password and flags mustChangePassword", async () => {
  const res = await request(app).post("/api/auth/local/login").send({
    email: "rep1@example.com",
    password: "TempPassword123!",
  });

  expect(res.status).toBe(200);
  expect(res.body.user.mustChangePassword).toBe(true);
});

it("changes password and clears the must-change flag", async () => {
  const res = await request(app).post("/api/auth/local/change-password").set("Cookie", loginCookie).send({
    currentPassword: "TempPassword123!",
    newPassword: "BetterPassword123!",
  });

  expect(res.status).toBe(200);
  expect(res.body.success).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/tests/modules/auth/local-auth-routes.test.ts client/src/lib/auth.test.tsx`
Expected: FAIL with missing routes, missing auth context methods, and missing change-password page.

- [ ] **Step 3: Add server-side local login and change-password handlers**

```ts
// server/src/modules/auth/routes.ts
router.post("/local/login", authLimiter, async (req, res, next) => {
  try {
    const { email, password } = req.body as { email: string; password: string };
    const result = await loginWithLocalPassword({ email, password });
    res.cookie("token", signJwt(result.claims), tokenCookieOptions);
    res.json({ user: result.user });
  } catch (err) {
    next(err);
  }
});

router.post("/local/change-password", authMiddleware, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body as { currentPassword: string; newPassword: string };
    await changeLocalPassword({
      userId: req.user!.id,
      currentPassword,
      newPassword,
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});
```

```ts
// server/src/modules/auth/service.ts
export interface AuthenticatedUserResponse {
  id: string;
  email: string;
  displayName: string;
  role: "admin" | "director" | "rep";
  officeId: string;
  mustChangePassword?: boolean;
}
```

```ts
// server/src/middleware/auth.ts
req.user = {
  userId: claims.userId,
  email: claims.email,
  officeId: claims.officeId,
  role: claims.role,
  mustChangePassword: claims.mustChangePassword ?? false,
};
```

```ts
// server/src/modules/auth/routes.ts
router.get("/me", authMiddleware, (req, res) => {
  res.json({ user: req.user });
});
```

- [ ] **Step 4: Extend frontend auth provider and routing**

```tsx
// client/src/lib/auth.tsx
interface AuthContextValue {
  user: User | null;
  loading: boolean;
  login: (email: string) => Promise<void>;
  loginWithPassword: (email: string, password: string) => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  logout: () => Promise<void>;
}
```

```tsx
// client/src/pages/login-page.tsx
export function LoginPage() {
  const { loginWithPassword } = useAuth();
  // render email/password form and submit to local login
}
```

```tsx
// client/src/pages/change-password-page.tsx
export function ChangePasswordPage() {
  const { changePassword } = useAuth();
  // render current/new/confirm password form and keep user on this route until success
}
```

```tsx
// client/src/App.tsx
if (user?.mustChangePassword) {
  return <Navigate to="/change-password" replace />;
}
```

- [ ] **Step 5: Run tests to verify login bridge passes**

Run: `npm run typecheck && npx vitest run server/tests/modules/auth/local-auth-routes.test.ts client/src/lib/auth.test.tsx`
Expected: PASS for local login, forced password change gating, and successful password update.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/auth/routes.ts server/src/modules/auth/service.ts server/src/middleware/auth.ts server/tests/modules/auth/local-auth-routes.test.ts client/src/lib/auth.tsx client/src/pages/login-page.tsx client/src/pages/change-password-page.tsx client/src/App.tsx client/src/lib/auth.test.tsx
git commit -m "feat: add temporary local login flow"
```

### Task 5: Extend Admin Users UI For Import And Invite Operations

**Files:**
- Modify: `client/src/hooks/use-admin-users.ts`
- Modify: `client/src/pages/admin/users-page.tsx`
- Create: `client/src/hooks/use-admin-users.test.tsx`

- [ ] **Step 1: Write the failing admin users UI tests**

```tsx
it("shows import and send-invite actions", async () => {
  render(<UsersPage />);
  expect(await screen.findByText("Import External Users")).toBeInTheDocument();
  expect(await screen.findByText("Send invite")).toBeInTheDocument();
});

it("refreshes after sending an invite", async () => {
  render(<UsersPage />);
  await user.click(await screen.findByRole("button", { name: /send invite/i }));
  expect(api).toHaveBeenCalledWith(expect.stringMatching(/send-invite/), expect.anything());
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run client/src/hooks/use-admin-users.test.tsx`
Expected: FAIL because the hook lacks import/invite actions and the users page lacks the controls.

- [ ] **Step 3: Add hook actions and user status fields**

```ts
// client/src/hooks/use-admin-users.ts
export interface AdminUser {
  id: string;
  email: string;
  displayName: string;
  role: "admin" | "director" | "rep";
  officeId: string;
  officeName: string | null;
  isActive: boolean;
  extraOfficeCount: number;
  sourceSystems?: string[];
  localAuthStatus?: "not_invited" | "invite_sent" | "must_change_password" | "active";
}

const importExternalUsers = async () => {
  await api("/admin/users/import-external", { method: "POST" });
  await load();
};

const sendInvite = async (id: string) => {
  await api(`/admin/users/${id}/send-invite`, { method: "POST" });
  await load();
};
```

- [ ] **Step 4: Add admin page actions**

```tsx
// client/src/pages/admin/users-page.tsx
<Button variant="default" size="sm" onClick={importExternalUsers} disabled={loading}>
  Import External Users
</Button>
```

```tsx
<Button
  variant="outline"
  size="sm"
  className="text-xs h-7"
  onClick={() => sendInvite(user.id)}
  disabled={updatingId === user.id}
>
  {user.localAuthStatus === "not_invited" ? "Send invite" : "Resend invite"}
</Button>
```

- [ ] **Step 5: Run tests to verify the admin UX passes**

Run: `npx vitest run client/src/hooks/use-admin-users.test.tsx`
Expected: PASS for import button, invite action, refresh behavior, and new source/auth status rendering.

- [ ] **Step 6: Commit**

```bash
git add client/src/hooks/use-admin-users.ts client/src/pages/admin/users-page.tsx client/src/hooks/use-admin-users.test.tsx
git commit -m "feat: add admin user import and invite controls"
```

### Task 6: Final Verification And Documentation Cleanup

**Files:**
- Modify: `client/src/pages/admin/help/admin-guide-page.tsx`
- Modify: `client/src/pages/admin/users-page.tsx`
- Test: `server/tests/modules/admin/user-import-service.test.ts`
- Test: `server/tests/modules/admin/user-invite-routes.test.ts`
- Test: `server/tests/modules/auth/local-auth-routes.test.ts`
- Test: `client/src/hooks/use-admin-users.test.tsx`

- [ ] **Step 1: Update admin help copy**

```tsx
// client/src/pages/admin/help/admin-guide-page.tsx
"Admins can import the union of Procore users and HubSpot owners into Dallas for testing, then send invites from Admin > Users. Invited users must change their password on first login."
```

- [ ] **Step 2: Run focused verification**

Run: `npx vitest run server/tests/modules/admin/user-import-service.test.ts server/tests/modules/admin/user-invite-routes.test.ts server/tests/modules/auth/local-auth-routes.test.ts client/src/hooks/use-admin-users.test.tsx`
Expected: PASS

- [ ] **Step 3: Run full typecheck**

Run: `npm run typecheck`
Expected: exit code `0`

- [ ] **Step 4: Run migration-aware sanity check**

Run: `npm run test -- --runInBand`
Expected: no regressions in auth/admin test areas; if the full suite is too broad, document the exact skipped suites and why.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/admin/help/admin-guide-page.tsx
git commit -m "docs: update admin guide for imported users and invites"
```

## Self-Review

- Spec coverage:
  - union import from Procore + HubSpot: Tasks 2, 3, 5
  - conservative existing-user behavior: Task 2
  - Dallas office + default rep role for new users: Task 2
  - admin population and invite action: Tasks 3 and 5
  - temporary local auth bridge: Tasks 1, 3, 4
  - forced password change on first login: Task 4
- Placeholder scan:
  - remaining ambiguity is the exact Procore users endpoint path; confirm against live Procore docs before implementation if the existing token mode requires a different company/user endpoint.
- Type consistency:
  - `mustChangePassword` is treated as a user/session property in both server and client tasks
  - `userLocalAuth` is the only password store
  - import and invite actions are admin-only in both route and UI tasks
  - `GET /api/admin/users` explicitly carries `sourceSystems` and `localAuthStatus`

Plan complete and saved to `docs/superpowers/plans/2026-04-19-user-import-local-auth-bridge.md`. Two execution options:

1. Subagent-Driven (recommended) - I dispatch a fresh subagent per task, review between tasks, fast iteration

2. Inline Execution - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
