# Procore OAuth Read-Only Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Procore `client_credentials` reads with a user-authorized OAuth flow so the admin Procore validation page can read the same live project data that already works in Sync Hub.

**Architecture:** Add a shared Procore OAuth token store, auth/status routes, and token-refresh helpers on the API. Update the Procore client to prefer OAuth-backed reads with `Procore-Company-Id`, then extend the admin Procore page to show connection state and only run validation against an authenticated Procore session.

**Tech Stack:** Express, Drizzle, PostgreSQL, React, TypeScript, Vitest

---

## File Structure

- Create: `migrations/0016_procore_oauth_tokens.sql`
  Responsibility: persistent storage for the shared Procore OAuth token set.
- Create: `shared/src/schema/public/procore-oauth-tokens.ts`
  Responsibility: Drizzle schema for the new shared Procore OAuth token table.
- Modify: `shared/src/schema/index.ts`
  Responsibility: export the new Procore OAuth schema.
- Create: `server/src/modules/procore/oauth-token-service.ts`
  Responsibility: encrypt, store, load, refresh, and clear Procore OAuth tokens.
- Modify: `server/src/lib/procore-client.ts`
  Responsibility: prefer OAuth-backed Procore reads, send `Procore-Company-Id`, refresh expired tokens, and expose explicit auth-mode / auth-failure behavior.
- Modify: `server/src/modules/auth/routes.ts`
  Responsibility: add Procore authorize/callback/status/disconnect routes.
- Modify: `server/src/modules/procore/routes.ts`
  Responsibility: return explicit Procore auth errors for validation instead of silently treating them as an empty project list.
- Modify: `client/src/pages/admin/procore-sync-page.tsx`
  Responsibility: show Procore OAuth connection state and gate validation UI accordingly.
- Create: `server/tests/modules/procore/oauth-token-service.test.ts`
  Responsibility: TDD coverage for token storage, refresh, and auth status behavior.
- Create: `server/tests/modules/auth/procore-oauth-routes.test.ts`
  Responsibility: route-level coverage for Procore authorize, callback, status, and disconnect behavior.
- Modify: `server/tests/modules/procore/project-validation-service.test.ts`
  Responsibility: add route/client preference tests for OAuth over `client_credentials` and explicit auth failure behavior.
- Create or modify: `client/src/lib/procore-validation-view-model.test.ts`
  Responsibility: cover disconnected / connected / auth-error display shaping if page-level tests remain out of scope.

## Task 1: Add the Shared Procore OAuth Storage Layer

**Files:**
- Create: `migrations/0016_procore_oauth_tokens.sql`
- Create: `shared/src/schema/public/procore-oauth-tokens.ts`
- Modify: `shared/src/schema/index.ts`
- Test: `server/tests/modules/procore/oauth-token-service.test.ts`

- [ ] **Step 1: Write the failing schema-adjacent service tests first**

```ts
import { describe, expect, it, vi } from "vitest";
import {
  upsertProcoreOauthTokens,
  getStoredProcoreOauthTokens,
  clearStoredProcoreOauthTokens,
} from "../../../src/modules/procore/oauth-token-service.js";

describe("procore oauth token service", () => {
  it("stores encrypted access and refresh tokens", async () => {
    const db = {
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
        }),
      }),
    } as any;

    await upsertProcoreOauthTokens(db, {
      accessToken: "access-123",
      refreshToken: "refresh-456",
      expiresAt: new Date("2026-04-13T12:00:00.000Z"),
      scopes: ["read"],
      accountEmail: "admin@trock.dev",
      accountName: "Admin User",
    });

    expect(db.insert).toHaveBeenCalledOnce();
  });

  it("returns null when no procore oauth tokens exist", async () => {
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    } as any;

    await expect(getStoredProcoreOauthTokens(db)).resolves.toBeNull();
  });
});
```

- [ ] **Step 2: Run the new test file to verify it fails for missing implementation**

Run: `npx vitest run server/tests/modules/procore/oauth-token-service.test.ts`

Expected: FAIL because the new token service does not exist yet.

- [ ] **Step 3: Add the migration**

```sql
CREATE TABLE IF NOT EXISTS public.procore_oauth_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  access_token text NOT NULL,
  refresh_token text NOT NULL,
  token_expires_at timestamptz NOT NULL,
  scopes text[] NOT NULL DEFAULT '{}',
  connected_account_email text,
  connected_account_name text,
  status text NOT NULL DEFAULT 'active',
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

- [ ] **Step 4: Add the Drizzle schema**

```ts
import { pgTable, uuid, text, timestamp } from "drizzle-orm/pg-core";

export const procoreOauthTokens = pgTable("procore_oauth_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  accessToken: text("access_token").notNull(),
  refreshToken: text("refresh_token").notNull(),
  tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }).notNull(),
  scopes: text("scopes").array().notNull(),
  connectedAccountEmail: text("connected_account_email"),
  connectedAccountName: text("connected_account_name"),
  status: text("status").notNull().default("active"),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
```

- [ ] **Step 5: Implement the token storage helpers**

```ts
export async function getStoredProcoreOauthTokens(db = poolDb) {
  const rows = await db.select().from(procoreOauthTokens).limit(1);
  const row = rows[0];
  if (!row) return null;

  return {
    id: row.id,
    accessToken: decrypt(row.accessToken),
    refreshToken: decrypt(row.refreshToken),
    expiresAt: row.tokenExpiresAt,
    scopes: row.scopes,
    accountEmail: row.connectedAccountEmail,
    accountName: row.connectedAccountName,
    status: row.status,
    lastError: row.lastError,
  };
}
```

- [ ] **Step 6: Re-run the focused token service tests**

Run: `npx vitest run server/tests/modules/procore/oauth-token-service.test.ts`

Expected: PASS

- [ ] **Step 7: Commit the storage layer**

```bash
git add migrations/0016_procore_oauth_tokens.sql shared/src/schema/public/procore-oauth-tokens.ts shared/src/schema/index.ts server/src/modules/procore/oauth-token-service.ts server/tests/modules/procore/oauth-token-service.test.ts
git commit -m "feat: add procore oauth token storage"
```

## Task 2: Add Procore OAuth Routes

**Files:**
- Modify: `server/src/modules/auth/routes.ts`
- Modify: `server/src/api-spec.ts` if route docs are kept current here
- Test: `server/tests/modules/auth/procore-oauth-routes.test.ts`

- [ ] **Step 1: Add failing route tests for authorize/callback/status/disconnect**

```ts
it("returns a Procore authorize URL for admin users", async () => {
  const res = await request(app)
    .get("/api/auth/procore/url")
    .set("Cookie", adminCookie);

  expect(res.status).toBe(200);
  expect(res.body.url).toContain("login.procore.com/oauth/authorize");
});

it("returns disconnected when no stored Procore OAuth token exists", async () => {
  const res = await request(app)
    .get("/api/auth/procore/status")
    .set("Cookie", adminCookie);

  expect(res.status).toBe(200);
  expect(res.body.connected).toBe(false);
});

it("exchanges the callback code and stores tokens before redirecting to /admin/procore", async () => {
  exchangeProcoreCodeForTokensMock.mockResolvedValue({
    access_token: "oauth-access",
    refresh_token: "oauth-refresh",
    expires_in: 3600,
  });

  const res = await request(app)
    .get("/api/auth/procore/callback")
    .query({ code: "abc123", state: signedState });

  expect(res.status).toBe(302);
  expect(res.headers.location).toContain("/admin/procore");
  expect(upsertProcoreOauthTokensMock).toHaveBeenCalledOnce();
});

it("deletes the stored Procore OAuth token on disconnect", async () => {
  const res = await request(app)
    .post("/api/auth/procore/disconnect")
    .set("Cookie", adminCookie);

  expect(res.status).toBe(200);
  expect(clearStoredProcoreOauthTokensMock).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: Run those tests to verify they fail**

Run: `npx vitest run server/tests/modules/auth/procore-oauth-routes.test.ts`

Expected: FAIL because the auth routes do not exist yet.

- [ ] **Step 3: Add the authorize route**

```ts
router.get("/procore/url", requireRole("admin"), async (req, res, next) => {
  try {
    const baseUrl = "https://login.procore.com";
    const apiBaseUrl = process.env.API_BASE_URL || "http://localhost:3001";
    const redirectUri = `${apiBaseUrl}/api/auth/procore/callback`;
    const state = jwt.sign({
      sub: req.user!.id,
      role: req.user!.role,
      officeId: req.user!.activeOfficeId ?? req.user!.officeId,
      purpose: "procore_oauth",
    }, process.env.JWT_SECRET!, { expiresIn: "10m" });

    const params = new URLSearchParams({
      response_type: "code",
      client_id: process.env.PROCORE_CLIENT_ID!,
      redirect_uri: redirectUri,
      state,
    });

    res.json({ url: `${baseUrl}/oauth/authorize?${params.toString()}` });
  } catch (err) {
    next(err);
  }
});
```

- [ ] **Step 4: Add callback, status, and disconnect routes**

```ts
router.get("/procore/callback", async (req, res, next) => {
  try {
    const code = req.query.code as string;
    const state = req.query.state as string;
    const apiBaseUrl = process.env.API_BASE_URL || "http://localhost:3001";
    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";

    const payload = jwt.verify(state, process.env.JWT_SECRET!) as {
      sub: string;
      role: string;
      purpose: string;
    };
    if (payload.purpose !== "procore_oauth" || payload.role !== "admin") {
      throw new AppError(403, "Invalid Procore OAuth state");
    }

    const tokenResponse = await exchangeProcoreCodeForTokens(code, `${apiBaseUrl}/api/auth/procore/callback`);
    await upsertProcoreOauthTokens({
      accessToken: tokenResponse.access_token,
      refreshToken: tokenResponse.refresh_token,
      expiresAt: new Date(Date.now() + tokenResponse.expires_in * 1000),
      scopes: tokenResponse.scope?.split(" ") ?? [],
      accountEmail: null,
      accountName: null,
    });

    res.redirect(`${frontendUrl}/admin/procore?procore=connected`);
  } catch (err) {
    next(err);
  }
});

router.get("/procore/status", requireRole("admin"), async (req, res, next) => {
  try {
    const tokens = await getStoredProcoreOauthTokens();
    res.json({
      connected: Boolean(tokens),
      expiresAt: tokens?.expiresAt?.toISOString() ?? null,
      accountEmail: tokens?.accountEmail ?? null,
      accountName: tokens?.accountName ?? null,
      authMode: tokens ? "oauth" : "client_credentials",
    });
  } catch (err) {
    next(err);
  }
});

router.post("/procore/disconnect", requireRole("admin"), async (_req, res, next) => {
  try {
    await clearStoredProcoreOauthTokens();
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});
```

- [ ] **Step 5: Re-run the auth route tests**

Run: `npx vitest run server/tests/modules/auth/procore-oauth-routes.test.ts`

Expected: PASS

- [ ] **Step 6: Commit the auth routes**

```bash
git add server/src/modules/auth/routes.ts server/src/api-spec.ts server/tests/modules/auth/procore-oauth-routes.test.ts
git commit -m "feat: add procore oauth auth routes"
```

## Task 3: Switch the Procore Client to OAuth-Backed Reads

**Files:**
- Modify: `server/src/lib/procore-client.ts`
- Modify: `server/src/modules/procore/oauth-token-service.ts`
- Test: `server/tests/modules/procore/oauth-token-service.test.ts`

- [ ] **Step 1: Add failing tests for auth preference and refresh**

```ts
it("prefers stored oauth tokens over client credentials for read requests", async () => {
  const getStoredTokens = vi.fn().mockResolvedValue({
    accessToken: "oauth-token",
    refreshToken: "refresh-token",
    expiresAt: new Date(Date.now() + 60_000),
    scopes: ["read"],
    accountEmail: "admin@trock.dev",
    accountName: "Admin User",
    status: "active",
    lastError: null,
  });

  const fetchMock = vi.fn().mockResolvedValue(new Response("[]", { status: 200 }));

  await listCompanyProjectsPage("598134325683880", 1, 5, {
    fetchImpl: fetchMock,
    getStoredTokens,
  });

  expect(fetchMock.mock.calls[0]?.[1]?.headers?.["Procore-Company-Id"]).toBe("598134325683880");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run server/tests/modules/procore/oauth-token-service.test.ts server/tests/modules/procore/project-validation-service.test.ts`

Expected: FAIL because the client does not yet support stored OAuth tokens.

- [ ] **Step 3: Refactor `procore-client.ts` to resolve auth mode explicitly**

```ts
async function resolveProcoreAuth() {
  const stored = await getStoredProcoreOauthTokens();
  if (stored) {
    const accessToken =
      stored.expiresAt.getTime() - Date.now() <= 60_000
        ? await refreshStoredProcoreOauthTokens()
        : stored.accessToken;

    return {
      mode: "oauth" as const,
      accessToken,
      companyHeader: process.env.PROCORE_COMPANY_ID ?? "",
    };
  }

  if (!process.env.PROCORE_CLIENT_ID || !process.env.PROCORE_CLIENT_SECRET) {
    return { mode: "dev" as const, accessToken: "dev-mock-token", companyHeader: null };
  }

  return {
    mode: "client_credentials" as const,
    accessToken: await getClientCredentialsToken(),
    companyHeader: process.env.PROCORE_COMPANY_ID ?? "",
  };
}
```

- [ ] **Step 4: Send `Procore-Company-Id` for OAuth-backed GETs**

```ts
const auth = await resolveProcoreAuth();
const res = await fetch(url, {
  method,
  headers: {
    Authorization: `Bearer ${auth.accessToken}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    ...(auth.companyHeader ? { "Procore-Company-Id": auth.companyHeader } : {}),
  },
  body: body != null ? JSON.stringify(body) : undefined,
});
```

- [ ] **Step 5: Re-run focused server tests**

Run: `npx vitest run server/tests/modules/procore/oauth-token-service.test.ts server/tests/modules/procore/project-validation-service.test.ts`

Expected: PASS

- [ ] **Step 6: Commit the Procore client auth switch**

```bash
git add server/src/lib/procore-client.ts server/src/modules/procore/oauth-token-service.ts server/tests/modules/procore/oauth-token-service.test.ts server/tests/modules/procore/project-validation-service.test.ts
git commit -m "feat: prefer procore oauth for read access"
```

## Task 4: Make the Validation Route Fail Explicitly on Procore Auth Errors

**Files:**
- Modify: `server/src/modules/procore/routes.ts`
- Modify: `server/src/lib/procore-client.ts`
- Test: `server/tests/modules/procore/project-validation-service.test.ts`

- [ ] **Step 1: Add a failing route test for auth-failure behavior**

```ts
it("returns an explicit auth error instead of an empty validation result", async () => {
  projectValidationServiceMocks.listProjectValidationForOffice.mockRejectedValueOnce(
    new Error("PROCORE_OAUTH_REQUIRED")
  );

  const request = invokeRoute({
    method: "get",
    routePath: "/project-validation",
    url: "/project-validation",
    user: makeUser("admin"),
  });

  await expect(request).rejects.toMatchObject({ statusCode: 503 });
});
```

- [ ] **Step 2: Run the route test and verify it fails**

Run: `npx vitest run server/tests/modules/procore/project-validation-service.test.ts`

Expected: FAIL because the route does not normalize auth failures yet.

- [ ] **Step 3: Normalize known Procore auth errors to explicit app errors**

```ts
try {
  const result = await listProjectValidationForOffice(req.tenantDb!, { ... });
  await req.commitTransaction!();
  res.json(result);
} catch (err) {
  if (isProcoreOauthRequiredError(err) || isProcoreOauthRefreshError(err)) {
    return next(new AppError(503, "Procore authentication required"));
  }
  next(err);
}
```

- [ ] **Step 4: Re-run the route test**

Run: `npx vitest run server/tests/modules/procore/project-validation-service.test.ts`

Expected: PASS

- [ ] **Step 5: Commit the validation error handling**

```bash
git add server/src/modules/procore/routes.ts server/src/lib/procore-client.ts server/tests/modules/procore/project-validation-service.test.ts
git commit -m "fix: surface procore auth failures in validation"
```

## Task 5: Add Admin Procore OAuth Connection State to the UI

**Files:**
- Modify: `client/src/pages/admin/procore-sync-page.tsx`
- Modify: `client/src/lib/procore-validation-view-model.ts`
- Modify: `client/src/lib/procore-validation-view-model.test.ts`

- [ ] **Step 1: Add failing helper tests for connection-state messaging**

```ts
import { describe, expect, it } from "vitest";
import { getProcoreConnectionBanner } from "./procore-validation-view-model";

describe("procore validation view model", () => {
  it("returns a connect banner when procore oauth is disconnected", () => {
    expect(
      getProcoreConnectionBanner({ connected: false, authMode: "client_credentials" })
    ).toMatchObject({ tone: "warning" });
  });
});
```

- [ ] **Step 2: Run the helper tests to verify they fail**

Run: `npx vitest run client/src/lib/procore-validation-view-model.test.ts`

Expected: FAIL because the helper does not exist yet.

- [ ] **Step 3: Add status fetch and connect/disconnect controls to the page**

```tsx
const [procoreStatus, setProcoreStatus] = useState<ProcoreAuthStatus | null>(null);

const loadProcoreStatus = useCallback(async () => {
  const result = await api<ProcoreAuthStatus>("/auth/procore/status");
  setProcoreStatus(result);
}, []);

const connectProcore = async () => {
  const result = await api<{ url: string }>("/auth/procore/url");
  window.location.href = result.url;
};
```

- [ ] **Step 4: Gate validation loading on connection state**

```tsx
useEffect(() => {
  loadSyncStatus();
  loadProcoreStatus();
}, [loadSyncStatus, loadProcoreStatus]);

useEffect(() => {
  if (procoreStatus?.connected) {
    loadValidation();
  } else {
    setValidationData(null);
    setValidationLoading(false);
  }
}, [procoreStatus, loadValidation]);
```

- [ ] **Step 5: Re-run the helper tests and client build**

Run:
- `npx vitest run client/src/lib/procore-validation-view-model.test.ts`
- `npm run build --workspace=client`

Expected: PASS

- [ ] **Step 6: Commit the admin UI auth state**

```bash
git add client/src/pages/admin/procore-sync-page.tsx client/src/lib/procore-validation-view-model.ts client/src/lib/procore-validation-view-model.test.ts
git commit -m "feat: add procore oauth connection state to admin ui"
```

## Task 6: Final Verification and Live Auth Handoff

**Files:**
- Modify if needed: `server/src/lib/procore-client.ts`
- Modify if needed: `server/src/modules/auth/routes.ts`
- Modify if needed: `client/src/pages/admin/procore-sync-page.tsx`

- [ ] **Step 1: Run the focused server verification set**

Run:
- `npx vitest run tests/modules/procore/oauth-token-service.test.ts tests/modules/auth/procore-oauth-routes.test.ts tests/modules/procore/project-validation-service.test.ts`
- `npx vitest run tests/modules/procore/reconciliation-service.test.ts tests/modules/procore/service.test.ts`

Expected: PASS

- [ ] **Step 2: Run the client verification set**

Run:
- `npx vitest run client/src/lib/procore-validation-view-model.test.ts`
- `npm run build --workspace=client`
- `npm run typecheck`

Expected: PASS

- [ ] **Step 3: Commit any final verification fixes**

```bash
git add server/src/lib/procore-client.ts server/src/modules/auth/routes.ts client/src/pages/admin/procore-sync-page.tsx server/tests/modules/procore/oauth-token-service.test.ts server/tests/modules/auth/procore-oauth-routes.test.ts server/tests/modules/procore/project-validation-service.test.ts client/src/lib/procore-validation-view-model.test.ts
git commit -m "fix: finalize procore oauth validation flow"
```

- [ ] **Step 4: Push the branch**

```bash
git push
```

- [ ] **Step 5: After deploy, complete the live OAuth handoff**

1. Open `/admin/procore`
2. Click the Procore connect button
3. Complete the Procore OAuth flow with the T Rock Procore account
4. Confirm validation now shows live projects instead of `0`
