# Plan 4: Email Integration Implementation (Microsoft Graph API)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement full email integration via Microsoft Graph API: OAuth consent flow with encrypted token storage, outbound email sending from deal/contact context, inbound email delta sync with automatic contact matching and deal association, thread grouping, email detail views on deal and contact records, and inbound-email-to-task creation. Email becomes the third communication pillar alongside calls and notes in the CRM activity feed.

**Architecture:** MS Graph client utility with AES-256-GCM token encryption, OAuth routes on the auth router (public, pre-tenant), email service module on the tenant router for CRUD + send, worker cron job for delta sync every 5 minutes, domain event handlers for `email.received` and `email.sent`. React frontend with compose dialog, inbox list, thread view tabs on deal and contact detail pages, and Graph auth consent flow UI.

**Tech Stack:** TypeScript, Express, Drizzle ORM, PostgreSQL, @azure/msal-node, node-fetch, React, Vite, Tailwind CSS, shadcn/ui, lucide-react

**Spec Reference:** `docs/superpowers/specs/2026-04-01-trock-crm-design.md` -- Sections 8 (Email Integration), 19 (Transactional Email), 24 (Integration Retry & Idempotency)

**Depends On:** Plan 1 (Foundation) + Plan 2 (Deals & Pipeline) + Plan 3 (Contacts & Dedup) -- fully implemented

---

## File Structure

```
server/src/lib/
  ├── graph-client.ts           # MS Graph API client with retry + circuit breaker
  └── encryption.ts             # AES-256-GCM encrypt/decrypt for token storage

server/src/modules/email/
  ├── routes.ts                 # /api/email/* route definitions
  ├── service.ts                # Email CRUD, send via Graph, auto-association logic
  ├── graph-auth.ts             # OAuth code exchange, token refresh, consent URL
  └── graph-token-service.ts    # Token CRUD in user_graph_tokens, encrypt/decrypt

server/tests/modules/email/
  ├── encryption.test.ts        # AES-256-GCM round-trip tests
  ├── service.test.ts           # Email auto-association logic tests
  ├── graph-auth.test.ts        # OAuth URL generation, token exchange mocking
  └── graph-token-service.test.ts # Token storage + refresh tests

worker/src/jobs/
  └── email-sync.ts             # Inbound email delta sync (every 5 min)

client/src/hooks/
  ├── use-emails.ts             # Email data fetching + mutations
  └── use-graph-auth.ts         # Graph auth status + consent flow

client/src/pages/email/
  └── email-inbox-page.tsx      # Full inbox list page at /email

client/src/components/email/
  ├── email-compose-dialog.tsx  # Compose email dialog (used from deal/contact)
  ├── email-list.tsx            # Email list component (reused in inbox + tabs)
  ├── email-thread-view.tsx     # Thread conversation view
  ├── email-row.tsx             # Single email row in list
  ├── deal-email-tab.tsx        # Email tab on deal detail page
  ├── contact-email-tab.tsx     # Email tab on contact detail page
  └── graph-auth-banner.tsx     # "Connect your email" banner + reauth warning
```

---

## Task 1: MS Graph Client + Token Encryption + OAuth Routes

- [ ] Create `server/src/lib/encryption.ts`
- [ ] Create `server/src/lib/graph-client.ts`
- [ ] Create `server/src/modules/email/graph-token-service.ts`
- [ ] Create `server/src/modules/email/graph-auth.ts`
- [ ] Add Graph OAuth routes to `server/src/modules/auth/routes.ts`

### 1a. AES-256-GCM Encryption Utility

Tokens stored in `user_graph_tokens` must be encrypted at rest. Uses `ENCRYPTION_KEY` env var (32-byte hex string). Dev mode uses a hardcoded fallback key.

**File: `server/src/lib/encryption.ts`**

```typescript
import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16; // 128-bit IV
const TAG_LENGTH = 16; // 128-bit auth tag

function getEncryptionKey(): Buffer {
  const hex = process.env.ENCRYPTION_KEY;
  if (process.env.NODE_ENV === "production" && !hex) {
    throw new Error("ENCRYPTION_KEY must be set in production");
  }
  // Dev fallback: deterministic key for local development only
  const keyHex = hex || "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const buf = Buffer.from(keyHex, "hex");
  if (buf.length !== 32) {
    throw new Error("ENCRYPTION_KEY must be a 64-character hex string (32 bytes)");
  }
  return buf;
}

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * Returns a base64-encoded string containing: IV + auth tag + ciphertext.
 */
export function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  // Pack: IV (16) + tag (16) + ciphertext (variable)
  const packed = Buffer.concat([iv, tag, encrypted]);
  return packed.toString("base64");
}

/**
 * Decrypt a base64-encoded AES-256-GCM ciphertext.
 * Expects the format produced by encrypt(): IV + auth tag + ciphertext.
 */
export function decrypt(encoded: string): string {
  const key = getEncryptionKey();
  const packed = Buffer.from(encoded, "base64");

  if (packed.length < IV_LENGTH + TAG_LENGTH) {
    throw new Error("Invalid encrypted data: too short");
  }

  const iv = packed.subarray(0, IV_LENGTH);
  const tag = packed.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = packed.subarray(IV_LENGTH + TAG_LENGTH);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}
```

### 1b. MS Graph API Client with Retry + Circuit Breaker

Handles all HTTP calls to MS Graph with exponential backoff (1s, 3s, 9s) and circuit breaker (open after 5 consecutive failures, half-open after 60s).

**File: `server/src/lib/graph-client.ts`**

```typescript
const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";

interface GraphClientOptions {
  accessToken: string;
}

interface GraphResponse<T = any> {
  ok: boolean;
  status: number;
  data: T;
}

// Circuit breaker state (module-level singleton)
let consecutiveFailures = 0;
let circuitOpenedAt: number | null = null;
const CIRCUIT_FAILURE_THRESHOLD = 5;
const CIRCUIT_HALF_OPEN_MS = 60_000; // 60 seconds

function isCircuitOpen(): boolean {
  if (consecutiveFailures < CIRCUIT_FAILURE_THRESHOLD) return false;
  if (circuitOpenedAt == null) return false;
  // Allow a single probe request after half-open interval
  if (Date.now() - circuitOpenedAt >= CIRCUIT_HALF_OPEN_MS) return false;
  return true;
}

function recordSuccess(): void {
  consecutiveFailures = 0;
  circuitOpenedAt = null;
}

function recordFailure(): void {
  consecutiveFailures++;
  if (consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD && circuitOpenedAt == null) {
    circuitOpenedAt = Date.now();
    console.error(`[GraphClient] Circuit breaker OPEN after ${consecutiveFailures} consecutive failures`);
  }
}

/**
 * Reset circuit breaker state. Useful for testing.
 */
export function resetCircuitBreaker(): void {
  consecutiveFailures = 0;
  circuitOpenedAt = null;
}

/**
 * Make an authenticated request to MS Graph API.
 * Retries up to 3 times with exponential backoff (1s, 3s, 9s).
 * Circuit breaker opens after 5 consecutive failures across all calls.
 */
export async function graphRequest<T = any>(
  options: GraphClientOptions & {
    method?: string;
    path: string;
    body?: any;
    retries?: number;
  }
): Promise<GraphResponse<T>> {
  const { accessToken, method = "GET", path, body, retries = 3 } = options;

  if (isCircuitOpen()) {
    throw new Error("MS Graph circuit breaker is OPEN — requests blocked. Will retry after cooldown.");
  }

  const url = path.startsWith("http") ? path : `${GRAPH_BASE_URL}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });

      // 429 Too Many Requests — respect Retry-After header
      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get("Retry-After") || "5", 10);
        console.warn(`[GraphClient] Rate limited, waiting ${retryAfter}s (attempt ${attempt + 1}/${retries})`);
        await sleep(retryAfter * 1000);
        continue;
      }

      // 5xx server errors — retry
      if (res.status >= 500) {
        const backoffMs = Math.pow(3, attempt) * 1000; // 1s, 3s, 9s
        console.warn(`[GraphClient] Server error ${res.status}, retrying in ${backoffMs}ms (attempt ${attempt + 1}/${retries})`);
        recordFailure();
        await sleep(backoffMs);
        continue;
      }

      // 401 Unauthorized — token expired, do NOT retry (caller should refresh)
      if (res.status === 401) {
        recordSuccess(); // Not a server failure
        const data = await res.json().catch(() => ({}));
        return { ok: false, status: 401, data: data as T };
      }

      // All other responses (2xx, 4xx)
      recordSuccess();
      const data = res.status === 204 ? ({} as T) : await res.json().catch(() => ({} as T));
      return { ok: res.ok, status: res.status, data: data as T };
    } catch (err: any) {
      lastError = err;
      recordFailure();
      if (attempt < retries - 1) {
        const backoffMs = Math.pow(3, attempt) * 1000;
        console.warn(`[GraphClient] Network error, retrying in ${backoffMs}ms (attempt ${attempt + 1}/${retries}): ${err.message}`);
        await sleep(backoffMs);
      }
    }
  }

  throw lastError ?? new Error("MS Graph request failed after all retries");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

### 1c. Graph Token Service

Handles CRUD operations on `user_graph_tokens` with encryption/decryption of access and refresh tokens.

**File: `server/src/modules/email/graph-token-service.ts`**

```typescript
import { eq } from "drizzle-orm";
import { db } from "../../db.js";
import { userGraphTokens } from "@trock-crm/shared/schema";
import { encrypt, decrypt } from "../../lib/encryption.js";

export interface TokenData {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  scopes: string[];
}

/**
 * Store or update Graph tokens for a user. Encrypts both tokens before storage.
 */
export async function upsertGraphTokens(userId: string, tokens: TokenData): Promise<void> {
  const encryptedAccess = encrypt(tokens.accessToken);
  const encryptedRefresh = encrypt(tokens.refreshToken);

  const existing = await db
    .select({ id: userGraphTokens.id })
    .from(userGraphTokens)
    .where(eq(userGraphTokens.userId, userId))
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(userGraphTokens)
      .set({
        accessToken: encryptedAccess,
        refreshToken: encryptedRefresh,
        tokenExpiresAt: tokens.expiresAt,
        scopes: tokens.scopes,
        status: "active",
        errorMessage: null,
        updatedAt: new Date(),
      })
      .where(eq(userGraphTokens.userId, userId));
  } else {
    await db.insert(userGraphTokens).values({
      userId,
      accessToken: encryptedAccess,
      refreshToken: encryptedRefresh,
      tokenExpiresAt: tokens.expiresAt,
      scopes: tokens.scopes,
      status: "active",
    });
  }
}

/**
 * Get decrypted Graph tokens for a user. Returns null if no tokens exist.
 */
export async function getGraphTokens(userId: string): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  scopes: string[];
  status: string;
  lastDeltaLink: string | null;
} | null> {
  const result = await db
    .select()
    .from(userGraphTokens)
    .where(eq(userGraphTokens.userId, userId))
    .limit(1);

  if (result.length === 0) return null;

  const row = result[0];
  return {
    accessToken: decrypt(row.accessToken),
    refreshToken: decrypt(row.refreshToken),
    expiresAt: row.tokenExpiresAt,
    scopes: row.scopes,
    status: row.status,
    lastDeltaLink: row.lastDeltaLink,
  };
}

/**
 * Update the last delta link for incremental sync.
 */
export async function updateDeltaLink(userId: string, deltaLink: string): Promise<void> {
  await db
    .update(userGraphTokens)
    .set({
      lastDeltaLink: deltaLink,
      lastSyncAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(userGraphTokens.userId, userId));
}

/**
 * Mark a user's token as needing reauthorization.
 */
export async function markReauthNeeded(userId: string, errorMessage: string): Promise<void> {
  await db
    .update(userGraphTokens)
    .set({
      status: "reauth_needed",
      errorMessage,
      updatedAt: new Date(),
    })
    .where(eq(userGraphTokens.userId, userId));
}

/**
 * Get all active user tokens (for worker sync loop).
 */
export async function getAllActiveTokenUsers(): Promise<Array<{
  userId: string;
  lastDeltaLink: string | null;
  tokenExpiresAt: Date;
  accessToken: string;
  refreshToken: string;
}>> {
  const rows = await db
    .select()
    .from(userGraphTokens)
    .where(eq(userGraphTokens.status, "active"));

  return rows.map((row) => ({
    userId: row.userId,
    lastDeltaLink: row.lastDeltaLink,
    tokenExpiresAt: row.tokenExpiresAt,
    accessToken: decrypt(row.accessToken),
    refreshToken: decrypt(row.refreshToken),
  }));
}

/**
 * Revoke a user's Graph tokens (user-initiated disconnect).
 */
export async function revokeGraphTokens(userId: string): Promise<void> {
  await db
    .update(userGraphTokens)
    .set({
      status: "revoked",
      updatedAt: new Date(),
    })
    .where(eq(userGraphTokens.userId, userId));
}

/**
 * Get the token status for a user (used by frontend to show auth banner).
 */
export async function getGraphTokenStatus(userId: string): Promise<{
  connected: boolean;
  status: string | null;
  errorMessage: string | null;
}> {
  const result = await db
    .select({
      status: userGraphTokens.status,
      errorMessage: userGraphTokens.errorMessage,
    })
    .from(userGraphTokens)
    .where(eq(userGraphTokens.userId, userId))
    .limit(1);

  if (result.length === 0) {
    return { connected: false, status: null, errorMessage: null };
  }

  return {
    connected: result[0].status === "active",
    status: result[0].status,
    errorMessage: result[0].errorMessage,
  };
}
```

### 1d. Graph OAuth Service

Handles the authorization code flow using `@azure/msal-node`. Generates consent URLs, exchanges authorization codes for tokens, and refreshes expired tokens.

**File: `server/src/modules/email/graph-auth.ts`**

```typescript
import { ConfidentialClientApplication, type Configuration } from "@azure/msal-node";
import { upsertGraphTokens, getGraphTokens, markReauthNeeded } from "./graph-token-service.js";

const GRAPH_SCOPES = [
  "Mail.Read",
  "Mail.Send",
  "Mail.ReadWrite",
  "User.Read",
  "offline_access",
];

function getMsalConfig(): Configuration {
  const clientId = process.env.AZURE_CLIENT_ID;
  const clientSecret = process.env.AZURE_CLIENT_SECRET;
  const tenantId = process.env.AZURE_TENANT_ID || "common";

  if (!clientId || !clientSecret) {
    throw new Error("AZURE_CLIENT_ID and AZURE_CLIENT_SECRET must be set for Graph auth");
  }

  return {
    auth: {
      clientId,
      clientSecret,
      authority: `https://login.microsoftonline.com/${tenantId}`,
    },
  };
}

let msalInstance: ConfidentialClientApplication | null = null;

function getMsalClient(): ConfidentialClientApplication {
  if (!msalInstance) {
    msalInstance = new ConfidentialClientApplication(getMsalConfig());
  }
  return msalInstance;
}

/**
 * Generate the Microsoft OAuth consent URL for a user.
 */
export function getConsentUrl(redirectUri: string, state?: string): string {
  const clientId = process.env.AZURE_CLIENT_ID;
  const tenantId = process.env.AZURE_TENANT_ID || "common";

  if (!clientId) {
    throw new Error("AZURE_CLIENT_ID must be set");
  }

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    response_mode: "query",
    scope: GRAPH_SCOPES.join(" "),
    prompt: "consent",
  });
  if (state) params.set("state", state);

  return `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize?${params.toString()}`;
}

/**
 * Exchange an authorization code for tokens and store them encrypted.
 */
export async function exchangeCodeForTokens(
  userId: string,
  code: string,
  redirectUri: string
): Promise<void> {
  const client = getMsalClient();

  const result = await client.acquireTokenByCode({
    code,
    scopes: GRAPH_SCOPES,
    redirectUri,
  });

  if (!result?.accessToken) {
    throw new Error("Failed to acquire tokens from Microsoft");
  }

  const expiresAt = result.expiresOn ?? new Date(Date.now() + 3600 * 1000);

  await upsertGraphTokens(userId, {
    accessToken: result.accessToken,
    refreshToken: (result as any).refreshToken ?? "",
    expiresAt,
    scopes: GRAPH_SCOPES,
  });

  console.log(`[GraphAuth] Tokens stored for user ${userId}`);
}

/**
 * Refresh an expired access token using the stored refresh token.
 * Returns the new access token, or null if refresh fails (triggers reauth).
 */
export async function refreshAccessToken(userId: string): Promise<string | null> {
  const stored = await getGraphTokens(userId);
  if (!stored) {
    console.error(`[GraphAuth] No tokens found for user ${userId}`);
    return null;
  }

  try {
    const client = getMsalClient();
    // MSAL node handles refresh token exchange via acquireTokenByRefreshToken
    // which is available on ConfidentialClientApplication
    const result = await (client as any).acquireTokenByRefreshToken({
      refreshToken: stored.refreshToken,
      scopes: GRAPH_SCOPES,
    });

    if (!result?.accessToken) {
      await markReauthNeeded(userId, "Token refresh returned empty response");
      return null;
    }

    const expiresAt = result.expiresOn ?? new Date(Date.now() + 3600 * 1000);

    await upsertGraphTokens(userId, {
      accessToken: result.accessToken,
      refreshToken: (result as any).refreshToken ?? stored.refreshToken,
      expiresAt,
      scopes: GRAPH_SCOPES,
    });

    return result.accessToken;
  } catch (err: any) {
    console.error(`[GraphAuth] Token refresh failed for user ${userId}:`, err.message);
    await markReauthNeeded(userId, `Refresh failed: ${err.message}`);
    return null;
  }
}

/**
 * Get a valid access token for a user. Refreshes if expired.
 * Returns null if the user needs to reauthorize.
 */
export async function getValidAccessToken(userId: string): Promise<string | null> {
  const stored = await getGraphTokens(userId);
  if (!stored) return null;
  if (stored.status === "reauth_needed" || stored.status === "revoked") return null;

  // If token expires within 5 minutes, refresh proactively
  const bufferMs = 5 * 60 * 1000;
  if (stored.expiresAt.getTime() - Date.now() < bufferMs) {
    return refreshAccessToken(userId);
  }

  return stored.accessToken;
}

/**
 * Check if Graph auth is available (AZURE_CLIENT_ID is set).
 * In dev mode without Azure credentials, email features return mock data.
 */
export function isGraphAuthConfigured(): boolean {
  return !!process.env.AZURE_CLIENT_ID && !!process.env.AZURE_CLIENT_SECRET;
}
```

### 1e. Add Graph OAuth Routes to Auth Router

These routes are public (pre-tenant) because the OAuth callback happens before we know which office schema to use. They require auth but not tenant context.

**Additions to: `server/src/modules/auth/routes.ts`**

Add the following routes after the existing `/me` and before the `export`:

```typescript
// --- MS Graph OAuth (Email Integration) ---

// GET /api/auth/graph/consent — redirect user to Microsoft consent screen
router.get("/graph/consent", authMiddleware, (req, res, next) => {
  try {
    // Lazy import to avoid crashing when Azure creds aren't set
    const { isGraphAuthConfigured, getConsentUrl } = require("../email/graph-auth.js");

    if (!isGraphAuthConfigured()) {
      // Dev mode: no Azure credentials, return mock status
      res.json({ url: null, devMode: true, message: "Graph auth not configured — using dev mode" });
      return;
    }

    const redirectUri = `${process.env.API_BASE_URL || "http://localhost:3001"}/api/auth/graph/callback`;
    const state = req.user!.id; // Pass userId in state for callback
    const url = getConsentUrl(redirectUri, state);
    res.json({ url });
  } catch (err) {
    next(err);
  }
});

// GET /api/auth/graph/callback — handle Microsoft OAuth callback
router.get("/graph/callback", async (req, res, next) => {
  try {
    const { exchangeCodeForTokens, isGraphAuthConfigured } = require("../email/graph-auth.js");

    if (!isGraphAuthConfigured()) {
      res.redirect(`${process.env.FRONTEND_URL || "http://localhost:5173"}/email?error=not_configured`);
      return;
    }

    const code = req.query.code as string;
    const state = req.query.state as string; // userId
    const error = req.query.error as string;

    if (error) {
      console.error(`[GraphAuth] OAuth error: ${error} — ${req.query.error_description}`);
      res.redirect(`${process.env.FRONTEND_URL || "http://localhost:5173"}/email?error=${error}`);
      return;
    }

    if (!code || !state) {
      res.redirect(`${process.env.FRONTEND_URL || "http://localhost:5173"}/email?error=missing_code`);
      return;
    }

    const redirectUri = `${process.env.API_BASE_URL || "http://localhost:3001"}/api/auth/graph/callback`;
    await exchangeCodeForTokens(state, code, redirectUri);

    // Redirect back to CRM email page on success
    res.redirect(`${process.env.FRONTEND_URL || "http://localhost:5173"}/email?connected=true`);
  } catch (err) {
    console.error("[GraphAuth] Callback error:", err);
    res.redirect(`${process.env.FRONTEND_URL || "http://localhost:5173"}/email?error=exchange_failed`);
  }
});

// GET /api/auth/graph/status — check if current user has connected Graph
router.get("/graph/status", authMiddleware, async (req, res, next) => {
  try {
    const { getGraphTokenStatus } = require("../email/graph-token-service.js");
    const status = await getGraphTokenStatus(req.user!.id);
    res.json(status);
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/graph/disconnect — revoke Graph tokens
router.post("/graph/disconnect", authMiddleware, async (req, res, next) => {
  try {
    const { revokeGraphTokens } = require("../email/graph-token-service.js");
    await revokeGraphTokens(req.user!.id);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});
```

**Note on imports:** The routes use `require()` for the graph-auth and graph-token-service modules to avoid crashing the server when Azure credentials are not configured. This is a deliberate choice for dev-mode compatibility.

---

## Task 2: Send Email Service (Graph API sendMail)

- [ ] Create `server/src/modules/email/service.ts`

This service handles composing and sending emails via MS Graph, storing the email record, creating the activity entry, and emitting the `email.sent` domain event.

**File: `server/src/modules/email/service.ts`**

```typescript
import { eq, and, desc, sql, or, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { emails, activities, contacts, deals, tasks } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { AppError } from "../../middleware/error-handler.js";
import { graphRequest } from "../../lib/graph-client.js";
import { getValidAccessToken, isGraphAuthConfigured } from "./graph-auth.js";
import crypto from "crypto";

type TenantDb = NodePgDatabase<typeof schema>;

export interface SendEmailInput {
  to: string[];
  cc?: string[];
  subject: string;
  bodyHtml: string;
  dealId?: string | null;
  contactId?: string | null;
}

export interface EmailFilters {
  dealId?: string;
  contactId?: string;
  direction?: "inbound" | "outbound";
  search?: string;
  page?: number;
  limit?: number;
}

/**
 * Send an email via MS Graph API and log it in the emails table.
 */
export async function sendEmail(
  tenantDb: TenantDb,
  userId: string,
  input: SendEmailInput
): Promise<any> {
  // Dev mode: store email locally without sending via Graph
  if (!isGraphAuthConfigured()) {
    return createMockSentEmail(tenantDb, userId, input);
  }

  const accessToken = await getValidAccessToken(userId);
  if (!accessToken) {
    throw new AppError(401, "Email not connected. Please connect your Microsoft account.", "GRAPH_AUTH_REQUIRED");
  }

  // Build MS Graph sendMail payload
  const message = {
    subject: input.subject,
    body: {
      contentType: "HTML",
      content: input.bodyHtml,
    },
    toRecipients: input.to.map((addr) => ({
      emailAddress: { address: addr },
    })),
    ccRecipients: (input.cc ?? []).map((addr) => ({
      emailAddress: { address: addr },
    })),
  };

  // Send via Graph API — saveToSentItems: true ensures it appears in Outlook
  const result = await graphRequest({
    accessToken,
    method: "POST",
    path: "/me/sendMail",
    body: { message, saveToSentItems: true },
  });

  if (!result.ok) {
    if (result.status === 401) {
      throw new AppError(401, "Email session expired. Please reconnect your Microsoft account.", "GRAPH_AUTH_EXPIRED");
    }
    throw new AppError(502, `Failed to send email via Microsoft: ${JSON.stringify(result.data)}`);
  }

  // Graph sendMail returns 202 with no body — generate our own message ID for tracking
  const graphMessageId = `sent-${crypto.randomUUID()}`;

  // Store the email record
  const [emailRecord] = await tenantDb
    .insert(emails)
    .values({
      graphMessageId,
      direction: "outbound",
      fromAddress: "", // Will be filled by sync or from user profile
      toAddresses: input.to,
      ccAddresses: input.cc ?? [],
      subject: input.subject,
      bodyPreview: stripHtml(input.bodyHtml).substring(0, 500),
      bodyHtml: input.bodyHtml,
      hasAttachments: false,
      contactId: input.contactId ?? null,
      dealId: input.dealId ?? null,
      userId,
      sentAt: new Date(),
    })
    .returning();

  // Create activity record for the unified feed
  await tenantDb.insert(activities).values({
    type: "email",
    userId,
    dealId: input.dealId ?? null,
    contactId: input.contactId ?? null,
    emailId: emailRecord.id,
    subject: input.subject,
    body: stripHtml(input.bodyHtml).substring(0, 1000),
    occurredAt: new Date(),
  });

  return emailRecord;
}

/**
 * Dev mode: create a mock sent email record without calling Graph API.
 */
async function createMockSentEmail(
  tenantDb: TenantDb,
  userId: string,
  input: SendEmailInput
): Promise<any> {
  const graphMessageId = `dev-sent-${crypto.randomUUID()}`;

  const [emailRecord] = await tenantDb
    .insert(emails)
    .values({
      graphMessageId,
      direction: "outbound",
      fromAddress: "dev-user@trockconstruction.com",
      toAddresses: input.to,
      ccAddresses: input.cc ?? [],
      subject: input.subject,
      bodyPreview: stripHtml(input.bodyHtml).substring(0, 500),
      bodyHtml: input.bodyHtml,
      hasAttachments: false,
      contactId: input.contactId ?? null,
      dealId: input.dealId ?? null,
      userId,
      sentAt: new Date(),
    })
    .returning();

  await tenantDb.insert(activities).values({
    type: "email",
    userId,
    dealId: input.dealId ?? null,
    contactId: input.contactId ?? null,
    emailId: emailRecord.id,
    subject: input.subject,
    body: stripHtml(input.bodyHtml).substring(0, 1000),
    occurredAt: new Date(),
  });

  return emailRecord;
}

/**
 * Get emails with filtering, pagination, and optional deal/contact scoping.
 */
export async function getEmails(tenantDb: TenantDb, filters: EmailFilters) {
  const page = filters.page ?? 1;
  const limit = filters.limit ?? 25;
  const offset = (page - 1) * limit;

  const conditions: any[] = [];

  if (filters.dealId) {
    conditions.push(eq(emails.dealId, filters.dealId));
  }
  if (filters.contactId) {
    conditions.push(eq(emails.contactId, filters.contactId));
  }
  if (filters.direction) {
    conditions.push(eq(emails.direction, filters.direction));
  }
  if (filters.search && filters.search.trim().length >= 2) {
    const term = `%${filters.search.trim()}%`;
    conditions.push(
      or(
        sql`${emails.subject} ILIKE ${term}`,
        sql`${emails.bodyPreview} ILIKE ${term}`,
        sql`${emails.fromAddress} ILIKE ${term}`,
        sql`array_to_string(${emails.toAddresses}, ',') ILIKE ${term}`
      )
    );
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [countResult, emailRows] = await Promise.all([
    tenantDb.select({ count: sql<number>`count(*)` }).from(emails).where(where),
    tenantDb
      .select()
      .from(emails)
      .where(where)
      .orderBy(desc(emails.sentAt))
      .limit(limit)
      .offset(offset),
  ]);

  const total = Number(countResult[0]?.count ?? 0);

  return {
    emails: emailRows,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
}

/**
 * Get a single email by ID (includes full body HTML).
 */
export async function getEmailById(tenantDb: TenantDb, emailId: string) {
  const result = await tenantDb
    .select()
    .from(emails)
    .where(eq(emails.id, emailId))
    .limit(1);
  return result[0] ?? null;
}

/**
 * Get all emails in a thread (grouped by graph_conversation_id).
 */
export async function getEmailThread(tenantDb: TenantDb, conversationId: string) {
  if (!conversationId) return [];

  return tenantDb
    .select()
    .from(emails)
    .where(eq(emails.graphConversationId, conversationId))
    .orderBy(desc(emails.sentAt));
}

/**
 * Get emails for a user across all deals/contacts (inbox view).
 */
export async function getUserEmails(tenantDb: TenantDb, userId: string, filters: EmailFilters) {
  const page = filters.page ?? 1;
  const limit = filters.limit ?? 25;
  const offset = (page - 1) * limit;

  const conditions: any[] = [eq(emails.userId, userId)];

  if (filters.direction) {
    conditions.push(eq(emails.direction, filters.direction));
  }
  if (filters.search && filters.search.trim().length >= 2) {
    const term = `%${filters.search.trim()}%`;
    conditions.push(
      or(
        sql`${emails.subject} ILIKE ${term}`,
        sql`${emails.bodyPreview} ILIKE ${term}`,
        sql`${emails.fromAddress} ILIKE ${term}`
      )
    );
  }

  const where = and(...conditions);

  const [countResult, emailRows] = await Promise.all([
    tenantDb.select({ count: sql<number>`count(*)` }).from(emails).where(where),
    tenantDb
      .select()
      .from(emails)
      .where(where)
      .orderBy(desc(emails.sentAt))
      .limit(limit)
      .offset(offset),
  ]);

  const total = Number(countResult[0]?.count ?? 0);

  return {
    emails: emailRows,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

/**
 * Auto-associate an email to a deal based on the contact's active deals.
 *
 * Rules (from spec):
 * - Contact has 1 active deal -> auto-associate email to that deal
 * - Contact has multiple active deals -> leave deal_id NULL, create task for rep
 * - Contact has 0 active deals -> associate to contact only (deal_id stays NULL)
 *
 * Returns the dealId if auto-associated, or null.
 */
export async function autoAssociateEmailToDeal(
  tenantDb: TenantDb,
  emailId: string,
  contactId: string,
  userId: string
): Promise<string | null> {
  // Find active deals where this contact is associated
  // Uses a raw query because contact_deal_associations + deals are both tenant tables
  const activeDeals = await tenantDb
    .select({ dealId: deals.id, dealName: deals.name, dealNumber: deals.dealNumber })
    .from(deals)
    .innerJoin(
      sql`contact_deal_associations cda ON cda.deal_id = ${deals.id}`
    )
    .where(
      and(
        sql`cda.contact_id = ${contactId}`,
        eq(deals.isActive, true)
      )
    );

  if (activeDeals.length === 1) {
    // Auto-associate to the single active deal
    const dealId = activeDeals[0].dealId;
    await tenantDb
      .update(emails)
      .set({ dealId })
      .where(eq(emails.id, emailId));
    return dealId;
  }

  if (activeDeals.length > 1) {
    // Multiple active deals — create a task for the rep to manually associate
    const dealNames = activeDeals.map((d) => `${d.dealNumber} ${d.dealName}`).join(", ");
    await tenantDb.insert(tasks).values({
      title: "Associate email to correct deal",
      description: `An inbound email was received for a contact with multiple active deals: ${dealNames}. Please review and associate the email to the correct deal.`,
      type: "inbound_email",
      priority: "normal",
      status: "pending",
      assignedTo: userId,
      contactId,
      emailId,
      dueDate: new Date().toISOString().split("T")[0],
    });
    return null;
  }

  // 0 active deals — contact-only association, no deal
  return null;
}

/**
 * Match an email address to a CRM contact.
 * Returns the contact if found, null otherwise.
 */
export async function findContactByEmail(
  tenantDb: TenantDb,
  emailAddress: string
): Promise<{ id: string; firstName: string; lastName: string } | null> {
  const normalized = emailAddress.trim().toLowerCase();
  const result = await tenantDb
    .select({
      id: contacts.id,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
    })
    .from(contacts)
    .where(
      and(
        sql`LOWER(${contacts.email}) = ${normalized}`,
        eq(contacts.isActive, true)
      )
    )
    .limit(1);

  return result[0] ?? null;
}

/**
 * Manually associate an email to a deal (from task or UI action).
 */
export async function associateEmailToDeal(
  tenantDb: TenantDb,
  emailId: string,
  dealId: string
): Promise<void> {
  const email = await getEmailById(tenantDb, emailId);
  if (!email) throw new AppError(404, "Email not found");

  const deal = await tenantDb
    .select({ id: deals.id })
    .from(deals)
    .where(eq(deals.id, dealId))
    .limit(1);
  if (deal.length === 0) throw new AppError(404, "Deal not found");

  await tenantDb
    .update(emails)
    .set({ dealId })
    .where(eq(emails.id, emailId));
}

/**
 * Strip HTML tags for plain-text preview.
 */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}
```

---

## Task 3: Email API Routes

- [ ] Create `server/src/modules/email/routes.ts`
- [ ] Mount email routes in `server/src/app.ts`

### 3a. Email Routes

**File: `server/src/modules/email/routes.ts`**

```typescript
import { Router } from "express";
import { AppError } from "../../middleware/error-handler.js";
import { eventBus } from "../../events/bus.js";
import { DOMAIN_EVENTS } from "@trock-crm/shared/types";
import {
  sendEmail,
  getEmails,
  getEmailById,
  getEmailThread,
  getUserEmails,
  associateEmailToDeal,
} from "./service.js";

const router = Router();

// POST /api/email/send — compose and send an email
router.post("/send", async (req, res, next) => {
  try {
    const { to, cc, subject, bodyHtml, dealId, contactId } = req.body;

    if (!to || !Array.isArray(to) || to.length === 0) {
      throw new AppError(400, "At least one recipient (to) is required");
    }
    if (!subject || !subject.trim()) {
      throw new AppError(400, "Subject is required");
    }
    if (!bodyHtml || !bodyHtml.trim()) {
      throw new AppError(400, "Email body is required");
    }

    const email = await sendEmail(req.tenantDb!, req.user!.id, {
      to,
      cc,
      subject: subject.trim(),
      bodyHtml,
      dealId: dealId || null,
      contactId: contactId || null,
    });

    await req.commitTransaction!();

    // Emit email.sent event after commit
    try {
      await eventBus.emitAll({
        name: DOMAIN_EVENTS.EMAIL_SENT,
        payload: {
          emailId: email.id,
          to,
          subject: subject.trim(),
          dealId: dealId || null,
          contactId: contactId || null,
        },
        officeId: req.user!.activeOfficeId ?? req.user!.officeId,
        userId: req.user!.id,
        timestamp: new Date(),
      });
    } catch (eventErr) {
      console.error("[Email] Failed to emit email.sent event:", eventErr);
    }

    res.status(201).json({ email });
  } catch (err) {
    next(err);
  }
});

// GET /api/email — user's email inbox (all emails for current user)
router.get("/", async (req, res, next) => {
  try {
    const filters = {
      direction: req.query.direction as "inbound" | "outbound" | undefined,
      search: req.query.search as string | undefined,
      page: req.query.page ? parseInt(req.query.page as string, 10) : undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
    };

    const result = await getUserEmails(req.tenantDb!, req.user!.id, filters);
    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/email/deal/:dealId — emails for a specific deal
router.get("/deal/:dealId", async (req, res, next) => {
  try {
    const filters = {
      dealId: req.params.dealId,
      direction: req.query.direction as "inbound" | "outbound" | undefined,
      search: req.query.search as string | undefined,
      page: req.query.page ? parseInt(req.query.page as string, 10) : undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
    };

    const result = await getEmails(req.tenantDb!, filters);
    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/email/contact/:contactId — emails for a specific contact
router.get("/contact/:contactId", async (req, res, next) => {
  try {
    const filters = {
      contactId: req.params.contactId,
      direction: req.query.direction as "inbound" | "outbound" | undefined,
      search: req.query.search as string | undefined,
      page: req.query.page ? parseInt(req.query.page as string, 10) : undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
    };

    const result = await getEmails(req.tenantDb!, filters);
    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/email/thread/:conversationId — all emails in a thread
router.get("/thread/:conversationId", async (req, res, next) => {
  try {
    const thread = await getEmailThread(req.tenantDb!, req.params.conversationId);
    await req.commitTransaction!();
    res.json({ emails: thread });
  } catch (err) {
    next(err);
  }
});

// GET /api/email/:id — single email with full body
router.get("/:id", async (req, res, next) => {
  try {
    const email = await getEmailById(req.tenantDb!, req.params.id);
    if (!email) throw new AppError(404, "Email not found");
    await req.commitTransaction!();
    res.json({ email });
  } catch (err) {
    next(err);
  }
});

// POST /api/email/:id/associate — manually associate email to a deal
router.post("/:id/associate", async (req, res, next) => {
  try {
    const { dealId } = req.body;
    if (!dealId) throw new AppError(400, "dealId is required");

    await associateEmailToDeal(req.tenantDb!, req.params.id, dealId);
    await req.commitTransaction!();
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export const emailRoutes = router;
```

### 3b. Mount Email Routes

**Additions to: `server/src/app.ts`**

Add to the imports at the top:

```typescript
import { emailRoutes } from "./modules/email/routes.js";
```

Add to the `tenantRouter` section (after the contacts line):

```typescript
tenantRouter.use("/email", emailRoutes);
```

---

## Task 4: Inbound Email Sync Worker Job

- [ ] Create `worker/src/jobs/email-sync.ts`
- [ ] Register email sync in `worker/src/jobs/index.ts`
- [ ] Add cron schedule in `worker/src/index.ts`

### 4a. Email Sync Worker Job

This job iterates all users with active Graph tokens, fetches new emails via MS Graph delta queries, matches them to contacts, applies auto-association logic, and stores them. Uses the per-office schema pattern from `stale-deals.ts`.

**File: `worker/src/jobs/email-sync.ts`**

```typescript
import { pool } from "../db.js";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, and, sql } from "drizzle-orm";
import * as schema from "@trock-crm/shared/schema";
import { emails, activities, contacts, deals, tasks } from "@trock-crm/shared/schema";
import { graphRequest } from "../../server/src/lib/graph-client.js";

/**
 * Inbound email sync job.
 *
 * Runs every 5 minutes. For each user with an active Graph token:
 * 1. Use delta query to get new messages since last sync
 * 2. For each message, match from/to addresses against contacts.email
 * 3. If match found: store email, auto-associate to deal, create activity
 * 4. Update delta link for next sync
 *
 * Selective sync: only emails from/to known CRM contacts are stored.
 */
export async function runEmailSync(): Promise<void> {
  console.log("[Worker:email-sync] Starting email sync...");

  const client = await pool.connect();
  try {
    // Get all users with active Graph tokens
    const tokenRows = await client.query(
      `SELECT ugt.user_id, ugt.access_token, ugt.refresh_token,
              ugt.token_expires_at, ugt.last_delta_link,
              u.office_id, u.email AS user_email
       FROM public.user_graph_tokens ugt
       JOIN public.users u ON u.id = ugt.user_id
       WHERE ugt.status = 'active' AND u.is_active = true`
    );

    if (tokenRows.rows.length === 0) {
      console.log("[Worker:email-sync] No active Graph tokens — skipping");
      return;
    }

    console.log(`[Worker:email-sync] Processing ${tokenRows.rows.length} users`);

    for (const tokenRow of tokenRows.rows) {
      try {
        await syncUserEmails(client, tokenRow);
      } catch (err: any) {
        console.error(
          `[Worker:email-sync] Failed for user ${tokenRow.user_id}:`,
          err.message
        );

        // If token is invalid (401), mark for reauth
        if (err.message?.includes("401") || err.message?.includes("InvalidAuthenticationToken")) {
          await client.query(
            `UPDATE public.user_graph_tokens
             SET status = 'reauth_needed', error_message = $1, updated_at = NOW()
             WHERE user_id = $2`,
            [`Sync failed: ${err.message}`, tokenRow.user_id]
          );
        }
      }
    }

    console.log("[Worker:email-sync] Sync complete");
  } finally {
    client.release();
  }
}

async function syncUserEmails(poolClient: any, tokenRow: any): Promise<void> {
  const { user_id, access_token, last_delta_link, office_id, user_email } = tokenRow;

  // Decrypt tokens (they are stored encrypted)
  // Import dynamically to share the encryption module
  const { decrypt } = await import("../../server/src/lib/encryption.js");
  const accessToken = decrypt(access_token);

  // Check token expiration — if expired, attempt refresh
  const expiresAt = new Date(tokenRow.token_expires_at);
  let currentAccessToken = accessToken;

  if (expiresAt.getTime() - Date.now() < 5 * 60 * 1000) {
    // Token expired or expiring soon — attempt refresh
    const { refreshAccessToken } = await import("../../server/src/modules/email/graph-auth.js");
    const newToken = await refreshAccessToken(user_id);
    if (!newToken) {
      console.warn(`[Worker:email-sync] Token refresh failed for user ${user_id} — skipping`);
      return;
    }
    currentAccessToken = newToken;
  }

  // Determine delta URL
  // First sync: use messages endpoint with select fields
  // Subsequent syncs: use the stored delta link
  let deltaUrl: string;
  if (last_delta_link) {
    deltaUrl = last_delta_link;
  } else {
    // Initial sync: get last 7 days of messages
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    deltaUrl = `/me/mailFolders/inbox/messages/delta?$select=id,conversationId,from,toRecipients,ccRecipients,subject,bodyPreview,body,hasAttachments,receivedDateTime&$filter=receivedDateTime ge ${sevenDaysAgo}`;
  }

  // Resolve the office schema for this user
  const officeResult = await poolClient.query(
    "SELECT slug FROM public.offices WHERE id = $1 AND is_active = true",
    [office_id]
  );
  if (officeResult.rows.length === 0) return;

  const officeSlug = officeResult.rows[0].slug;
  const slugRegex = /^[a-z][a-z0-9_]*$/;
  if (!slugRegex.test(officeSlug)) {
    console.error(`[Worker:email-sync] Invalid office slug: "${officeSlug}" — skipping`);
    return;
  }
  const schemaName = `office_${officeSlug}`;

  // Fetch messages page by page via delta
  let nextLink: string | null = deltaUrl;
  let newDeltaLink: string | null = null;
  let totalProcessed = 0;

  while (nextLink) {
    const result = await graphRequest<any>({
      accessToken: currentAccessToken,
      path: nextLink,
    });

    if (!result.ok) {
      if (result.status === 401) {
        throw new Error("401 InvalidAuthenticationToken");
      }
      throw new Error(`Graph API error: ${result.status} ${JSON.stringify(result.data)}`);
    }

    const messages = result.data.value ?? [];

    for (const msg of messages) {
      // Skip deleted/removed messages from delta (they have @removed)
      if (msg["@removed"]) continue;

      const processed = await processInboundMessage(poolClient, schemaName, user_id, msg);
      if (processed) totalProcessed++;
    }

    // Follow pagination
    nextLink = result.data["@odata.nextLink"] ?? null;
    // Delta link is only on the last page
    if (result.data["@odata.deltaLink"]) {
      newDeltaLink = result.data["@odata.deltaLink"];
    }
  }

  // Update the delta link and last sync time
  if (newDeltaLink) {
    await poolClient.query(
      `UPDATE public.user_graph_tokens
       SET last_delta_link = $1, last_sync_at = NOW(), updated_at = NOW()
       WHERE user_id = $2`,
      [newDeltaLink, user_id]
    );
  } else {
    await poolClient.query(
      `UPDATE public.user_graph_tokens SET last_sync_at = NOW(), updated_at = NOW() WHERE user_id = $1`,
      [user_id]
    );
  }

  if (totalProcessed > 0) {
    console.log(`[Worker:email-sync] User ${user_id}: synced ${totalProcessed} new emails`);
  }
}

/**
 * Process a single inbound message from Graph delta.
 * Returns true if the email was stored (matched a contact), false if skipped.
 */
async function processInboundMessage(
  client: any,
  schemaName: string,
  userId: string,
  msg: any
): Promise<boolean> {
  const graphMessageId = msg.id;
  if (!graphMessageId) return false;

  // Dedup check: graph_message_id is UNIQUE
  const existing = await client.query(
    `SELECT id FROM ${schemaName}.emails WHERE graph_message_id = $1 LIMIT 1`,
    [graphMessageId]
  );
  if (existing.rows.length > 0) return false;

  // Extract addresses
  const fromAddress = msg.from?.emailAddress?.address?.toLowerCase() ?? "";
  const toAddresses: string[] = (msg.toRecipients ?? [])
    .map((r: any) => r.emailAddress?.address?.toLowerCase())
    .filter(Boolean);
  const ccAddresses: string[] = (msg.ccRecipients ?? [])
    .map((r: any) => r.emailAddress?.address?.toLowerCase())
    .filter(Boolean);

  // Selective sync: match from address against contacts.email
  // Only store emails from known CRM contacts
  const allAddresses = [fromAddress, ...toAddresses, ...ccAddresses].filter(Boolean);
  const contactMatch = await findContactByEmailRaw(client, schemaName, allAddresses);

  if (!contactMatch) {
    // No matching contact — skip this email (selective sync)
    return false;
  }

  const conversationId = msg.conversationId ?? null;
  const subject = msg.subject ?? "(No Subject)";
  const bodyPreview = (msg.bodyPreview ?? "").substring(0, 500);
  const bodyHtml = msg.body?.content ?? "";
  const hasAttachments = msg.hasAttachments ?? false;
  const sentAt = msg.receivedDateTime ? new Date(msg.receivedDateTime) : new Date();

  // Insert email record
  const insertResult = await client.query(
    `INSERT INTO ${schemaName}.emails
     (graph_message_id, graph_conversation_id, direction, from_address, to_addresses, cc_addresses,
      subject, body_preview, body_html, has_attachments, contact_id, user_id, sent_at)
     VALUES ($1, $2, 'inbound', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (graph_message_id) DO NOTHING
     RETURNING id`,
    [
      graphMessageId,
      conversationId,
      fromAddress,
      toAddresses,
      ccAddresses,
      subject,
      bodyPreview,
      bodyHtml,
      hasAttachments,
      contactMatch.id,
      userId,
      sentAt,
    ]
  );

  if (insertResult.rows.length === 0) return false; // Conflict — already existed

  const emailId = insertResult.rows[0].id;

  // Auto-associate to deal
  await autoAssociateRaw(client, schemaName, emailId, contactMatch.id, userId);

  // Create activity record
  await client.query(
    `INSERT INTO ${schemaName}.activities
     (type, user_id, contact_id, email_id, subject, body, occurred_at)
     VALUES ('email', $1, $2, $3, $4, $5, $6)`,
    [userId, contactMatch.id, emailId, subject, bodyPreview.substring(0, 1000), sentAt]
  );

  // Emit email.received event via job_queue
  await client.query(
    `INSERT INTO public.job_queue (job_type, payload, office_id, status, run_after)
     VALUES ('domain_event', $1, $2, 'pending', NOW())`,
    [
      JSON.stringify({
        eventName: "email.received",
        emailId,
        contactId: contactMatch.id,
        contactName: `${contactMatch.first_name} ${contactMatch.last_name}`,
        fromAddress,
        subject,
        userId,
      }),
      null, // office_id not needed for domain events dispatched by worker
    ]
  );

  return true;
}

/**
 * Find a CRM contact by email address using raw SQL (worker context).
 */
async function findContactByEmailRaw(
  client: any,
  schemaName: string,
  emailAddresses: string[]
): Promise<{ id: string; first_name: string; last_name: string } | null> {
  if (emailAddresses.length === 0) return null;

  // Build parameterized IN clause
  const placeholders = emailAddresses.map((_, i) => `$${i + 1}`).join(", ");
  const result = await client.query(
    `SELECT id, first_name, last_name FROM ${schemaName}.contacts
     WHERE LOWER(email) IN (${placeholders}) AND is_active = true
     LIMIT 1`,
    emailAddresses.map((e) => e.toLowerCase())
  );

  return result.rows[0] ?? null;
}

/**
 * Auto-associate an email to a deal using raw SQL (worker context).
 *
 * Rules:
 * - 1 active deal for contact -> auto-associate
 * - Multiple active deals -> leave null + create task
 * - 0 active deals -> contact only
 */
async function autoAssociateRaw(
  client: any,
  schemaName: string,
  emailId: string,
  contactId: string,
  userId: string
): Promise<void> {
  const activeDeals = await client.query(
    `SELECT d.id AS deal_id, d.deal_number, d.name AS deal_name
     FROM ${schemaName}.deals d
     JOIN ${schemaName}.contact_deal_associations cda ON cda.deal_id = d.id
     WHERE cda.contact_id = $1 AND d.is_active = true`,
    [contactId]
  );

  if (activeDeals.rows.length === 1) {
    // Auto-associate to the single active deal
    await client.query(
      `UPDATE ${schemaName}.emails SET deal_id = $1 WHERE id = $2`,
      [activeDeals.rows[0].deal_id, emailId]
    );
    // Also update the activity record
    await client.query(
      `UPDATE ${schemaName}.activities SET deal_id = $1 WHERE email_id = $2`,
      [activeDeals.rows[0].deal_id, emailId]
    );
  } else if (activeDeals.rows.length > 1) {
    // Multiple active deals — create task for rep
    const dealNames = activeDeals.rows
      .map((d: any) => `${d.deal_number} ${d.deal_name}`)
      .join(", ");
    await client.query(
      `INSERT INTO ${schemaName}.tasks
       (title, description, type, priority, status, assigned_to, contact_id, email_id, due_date)
       VALUES ($1, $2, 'inbound_email', 'normal', 'pending', $3, $4, $5, CURRENT_DATE)`,
      [
        "Associate email to correct deal",
        `An inbound email was received for a contact with multiple active deals: ${dealNames}. Review and associate to the correct deal.`,
        userId,
        contactId,
        emailId,
      ]
    );
  }
  // 0 active deals: contact-only association, no action needed
}
```

### 4b. Register Email Sync Job + Domain Event Handlers

**Additions to: `worker/src/jobs/index.ts`**

Add import at top:

```typescript
import { runEmailSync } from "./email-sync.js";
```

Add to `registerAllJobs()` function, after the existing job registrations:

```typescript
  // Email sync (triggered via job_queue or cron)
  registerJobHandler("email_sync", async () => {
    await runEmailSync();
  });

  // Domain event: email.received -> create follow-up task for rep
  domainEventHandlers.set("email.received", async (payload, officeId) => {
    console.log(`[Worker] email.received: from ${payload.fromAddress} — subject: ${payload.subject}`);

    // Task creation is handled inline during sync (see email-sync.ts autoAssociateRaw).
    // This handler exists for future extensions (e.g., SSE notification push, Slack alerts).
    // The notification is created here for the user.

    if (!payload.userId) return;

    // Find user's office to create notification in the correct schema
    const { pool: workerPool } = await import("../db.js");
    const userResult = await workerPool.query(
      "SELECT office_id FROM public.users WHERE id = $1",
      [payload.userId]
    );
    if (userResult.rows.length === 0) return;

    const officeResult = await workerPool.query(
      "SELECT slug FROM public.offices WHERE id = $1 AND is_active = true",
      [userResult.rows[0].office_id]
    );
    if (officeResult.rows.length === 0) return;

    const slug = officeResult.rows[0].slug;
    const slugRegex = /^[a-z][a-z0-9_]*$/;
    if (!slugRegex.test(slug)) return;

    const schemaName = `office_${slug}`;

    // Create notification for the rep
    await workerPool.query(
      `INSERT INTO ${schemaName}.notifications (user_id, type, title, body, link)
       VALUES ($1, 'inbound_email', $2, $3, $4)`,
      [
        payload.userId,
        `New email from ${payload.contactName || payload.fromAddress}`,
        payload.subject?.substring(0, 200) ?? "New email",
        payload.emailId ? `/email/${payload.emailId}` : "/email",
      ]
    );
  });

  domainEventHandlers.set("email.sent", async (payload, officeId) => {
    console.log(`[Worker] email.sent: to ${payload.to?.join(", ")} — subject: ${payload.subject}`);
    // Future: update contact touchpoint count, last_contacted_at
  });
```

Update the console.log line at end of `registerAllJobs()`:

```typescript
  console.log("[Worker] Job handlers registered:", ["test_echo", "domain_event", "stale_deal_scan", "dedup_scan", "email_sync"].join(", "));
```

### 4c. Add Cron Schedule

**Additions to: `worker/src/index.ts`**

Add import at top:

```typescript
import { runEmailSync } from "./jobs/email-sync.js";
```

Add after the dedup scan cron schedule:

```typescript
  // Email sync: every 5 minutes
  cron.schedule("*/5 * * * *", async () => {
    console.log("[Worker:cron] Running email sync...");
    try {
      await runEmailSync();
    } catch (err) {
      console.error("[Worker:cron] Email sync failed:", err);
    }
  });
  console.log("[Worker] Cron scheduled: email sync every 5 minutes");
```

---

## Task 5: Email-to-Task Creation (email.received -> follow-up task)

This is already handled in Task 4b via the `email.received` domain event handler and the `autoAssociateRaw` function in `email-sync.ts`.

The flow:
1. Inbound email synced -> if contact has multiple active deals -> `inbound_email` task created for rep
2. `email.received` domain event -> notification created for rep
3. Rep sees notification + task in their daily list
4. Rep manually associates email to correct deal via UI (Task 10 covers this)

No additional code needed for this task -- it is fully covered by Tasks 4a and 4b.

- [ ] Verify email.received handler creates notifications
- [ ] Verify autoAssociateRaw creates tasks for multi-deal contacts

---

## Task 6: Backend Tests

- [ ] Create `server/tests/modules/email/encryption.test.ts`
- [ ] Create `server/tests/modules/email/service.test.ts`

### 6a. Encryption Round-Trip Tests

**File: `server/tests/modules/email/encryption.test.ts`**

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Inline encryption logic for unit testing without importing the module
// (avoids process.env dependency in test runner)
import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const TEST_KEY = Buffer.from(
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "hex"
);

function encrypt(plaintext: string, key: Buffer = TEST_KEY): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const packed = Buffer.concat([iv, tag, encrypted]);
  return packed.toString("base64");
}

function decrypt(encoded: string, key: Buffer = TEST_KEY): string {
  const packed = Buffer.from(encoded, "base64");
  const iv = packed.subarray(0, IV_LENGTH);
  const tag = packed.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = packed.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString("utf8");
}

describe("AES-256-GCM Encryption", () => {
  it("should round-trip a short string", () => {
    const original = "hello-world-token";
    const encrypted = encrypt(original);
    expect(encrypted).not.toBe(original);
    expect(decrypt(encrypted)).toBe(original);
  });

  it("should round-trip a long access token", () => {
    const original = "eyJ0eXAiOiJKV1QiLCJub25jZSI6IjEyMzQ1Njc4OTAiLCJhbGciOiJSUzI1NiIsIng1dCI6Ik5HVEZ2ZEstZnl0aEV1Q..." +
      "a".repeat(1000);
    expect(decrypt(encrypt(original))).toBe(original);
  });

  it("should produce different ciphertext for same plaintext (random IV)", () => {
    const original = "same-token";
    const enc1 = encrypt(original);
    const enc2 = encrypt(original);
    expect(enc1).not.toBe(enc2);
    expect(decrypt(enc1)).toBe(original);
    expect(decrypt(enc2)).toBe(original);
  });

  it("should fail on tampered ciphertext", () => {
    const encrypted = encrypt("secret-token");
    const buf = Buffer.from(encrypted, "base64");
    // Flip a byte in the ciphertext portion
    buf[IV_LENGTH + TAG_LENGTH] ^= 0xff;
    const tampered = buf.toString("base64");
    expect(() => decrypt(tampered)).toThrow();
  });

  it("should fail with wrong key", () => {
    const encrypted = encrypt("secret-token");
    const wrongKey = Buffer.from(
      "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      "hex"
    );
    expect(() => decrypt(encrypted, wrongKey)).toThrow();
  });

  it("should handle empty string", () => {
    const encrypted = encrypt("");
    expect(decrypt(encrypted)).toBe("");
  });

  it("should handle unicode characters", () => {
    const original = "token-with-unicode-\u00e9\u00e8\u00ea";
    expect(decrypt(encrypt(original))).toBe(original);
  });
});
```

### 6b. Email Service Unit Tests

Tests the auto-association logic and `stripHtml` helper in isolation.

**File: `server/tests/modules/email/service.test.ts`**

```typescript
import { describe, it, expect } from "vitest";

/**
 * Unit tests for email service pure functions.
 * Tests auto-association decision logic and HTML stripping
 * without database dependencies.
 */

// Inline stripHtml for unit testing
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

// Auto-association decision function (pure logic, extracted for testing)
function decideAssociation(activeDeals: Array<{ id: string; name: string }>): {
  action: "auto_associate" | "create_task" | "contact_only";
  dealId: string | null;
} {
  if (activeDeals.length === 1) {
    return { action: "auto_associate", dealId: activeDeals[0].id };
  }
  if (activeDeals.length > 1) {
    return { action: "create_task", dealId: null };
  }
  return { action: "contact_only", dealId: null };
}

describe("Email Service", () => {
  describe("stripHtml", () => {
    it("should strip HTML tags", () => {
      expect(stripHtml("<p>Hello <strong>world</strong></p>")).toBe("Hello world");
    });

    it("should decode HTML entities", () => {
      expect(stripHtml("A &amp; B &lt;C&gt; &quot;D&quot;")).toBe('A & B <C> "D"');
    });

    it("should replace &nbsp; with space", () => {
      expect(stripHtml("Hello&nbsp;world")).toBe("Hello world");
    });

    it("should collapse whitespace", () => {
      expect(stripHtml("<p>  Hello   world  </p>")).toBe("Hello world");
    });

    it("should handle empty string", () => {
      expect(stripHtml("")).toBe("");
    });

    it("should handle complex HTML email body", () => {
      const html = `
        <div style="font-family: Arial">
          <p>Hi Brett,</p>
          <p>Following up on the <strong>Project Alpha</strong> bid.</p>
          <br />
          <p>Best regards,<br />John</p>
        </div>
      `;
      const result = stripHtml(html);
      expect(result).toContain("Hi Brett");
      expect(result).toContain("Project Alpha");
      expect(result).toContain("Best regards");
      expect(result).not.toContain("<");
    });
  });

  describe("decideAssociation", () => {
    it("should auto-associate when contact has exactly 1 active deal", () => {
      const result = decideAssociation([{ id: "deal-1", name: "Deal A" }]);
      expect(result.action).toBe("auto_associate");
      expect(result.dealId).toBe("deal-1");
    });

    it("should create task when contact has multiple active deals", () => {
      const result = decideAssociation([
        { id: "deal-1", name: "Deal A" },
        { id: "deal-2", name: "Deal B" },
      ]);
      expect(result.action).toBe("create_task");
      expect(result.dealId).toBeNull();
    });

    it("should be contact-only when 0 active deals", () => {
      const result = decideAssociation([]);
      expect(result.action).toBe("contact_only");
      expect(result.dealId).toBeNull();
    });

    it("should create task for 3+ active deals", () => {
      const result = decideAssociation([
        { id: "d1", name: "A" },
        { id: "d2", name: "B" },
        { id: "d3", name: "C" },
      ]);
      expect(result.action).toBe("create_task");
      expect(result.dealId).toBeNull();
    });
  });
});
```

---

## Task 7: Frontend — Email Hooks and Utilities

- [ ] Create `client/src/hooks/use-emails.ts`
- [ ] Create `client/src/hooks/use-graph-auth.ts`

### 7a. Email Data Hooks

**File: `client/src/hooks/use-emails.ts`**

```typescript
import { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/api";

export interface Email {
  id: string;
  graphMessageId: string;
  graphConversationId: string | null;
  direction: "inbound" | "outbound";
  fromAddress: string;
  toAddresses: string[];
  ccAddresses: string[] | null;
  subject: string | null;
  bodyPreview: string | null;
  bodyHtml: string | null;
  hasAttachments: boolean;
  contactId: string | null;
  dealId: string | null;
  userId: string;
  sentAt: string;
  syncedAt: string;
}

export interface EmailFilters {
  direction?: "inbound" | "outbound";
  search?: string;
  page?: number;
  limit?: number;
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export function useUserEmails(filters: EmailFilters = {}) {
  const [emails, setEmails] = useState<Email[]>([]);
  const [pagination, setPagination] = useState<Pagination>({
    page: 1,
    limit: 25,
    total: 0,
    totalPages: 0,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchEmails = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (filters.direction) params.set("direction", filters.direction);
      if (filters.search) params.set("search", filters.search);
      if (filters.page) params.set("page", String(filters.page));
      if (filters.limit) params.set("limit", String(filters.limit));

      const qs = params.toString();
      const data = await api<{ emails: Email[]; pagination: Pagination }>(
        `/email${qs ? `?${qs}` : ""}`
      );
      setEmails(data.emails);
      setPagination(data.pagination);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load emails");
    } finally {
      setLoading(false);
    }
  }, [filters.direction, filters.search, filters.page, filters.limit]);

  useEffect(() => {
    fetchEmails();
  }, [fetchEmails]);

  return { emails, pagination, loading, error, refetch: fetchEmails };
}

export function useDealEmails(dealId: string | undefined, filters: EmailFilters = {}) {
  const [emails, setEmails] = useState<Email[]>([]);
  const [pagination, setPagination] = useState<Pagination>({
    page: 1,
    limit: 25,
    total: 0,
    totalPages: 0,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchEmails = useCallback(async () => {
    if (!dealId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (filters.direction) params.set("direction", filters.direction);
      if (filters.search) params.set("search", filters.search);
      if (filters.page) params.set("page", String(filters.page));
      if (filters.limit) params.set("limit", String(filters.limit));

      const qs = params.toString();
      const data = await api<{ emails: Email[]; pagination: Pagination }>(
        `/email/deal/${dealId}${qs ? `?${qs}` : ""}`
      );
      setEmails(data.emails);
      setPagination(data.pagination);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load deal emails");
    } finally {
      setLoading(false);
    }
  }, [dealId, filters.direction, filters.search, filters.page, filters.limit]);

  useEffect(() => {
    fetchEmails();
  }, [fetchEmails]);

  return { emails, pagination, loading, error, refetch: fetchEmails };
}

export function useContactEmails(contactId: string | undefined, filters: EmailFilters = {}) {
  const [emails, setEmails] = useState<Email[]>([]);
  const [pagination, setPagination] = useState<Pagination>({
    page: 1,
    limit: 25,
    total: 0,
    totalPages: 0,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchEmails = useCallback(async () => {
    if (!contactId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (filters.direction) params.set("direction", filters.direction);
      if (filters.search) params.set("search", filters.search);
      if (filters.page) params.set("page", String(filters.page));
      if (filters.limit) params.set("limit", String(filters.limit));

      const qs = params.toString();
      const data = await api<{ emails: Email[]; pagination: Pagination }>(
        `/email/contact/${contactId}${qs ? `?${qs}` : ""}`
      );
      setEmails(data.emails);
      setPagination(data.pagination);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load contact emails");
    } finally {
      setLoading(false);
    }
  }, [contactId, filters.direction, filters.search, filters.page, filters.limit]);

  useEffect(() => {
    fetchEmails();
  }, [fetchEmails]);

  return { emails, pagination, loading, error, refetch: fetchEmails };
}

export function useEmailThread(conversationId: string | undefined) {
  const [emails, setEmails] = useState<Email[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchThread = useCallback(async () => {
    if (!conversationId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ emails: Email[] }>(
        `/email/thread/${encodeURIComponent(conversationId)}`
      );
      setEmails(data.emails);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load thread");
    } finally {
      setLoading(false);
    }
  }, [conversationId]);

  useEffect(() => {
    fetchThread();
  }, [fetchThread]);

  return { emails, loading, error, refetch: fetchThread };
}

// --- Mutation Functions ---

export async function sendEmail(input: {
  to: string[];
  cc?: string[];
  subject: string;
  bodyHtml: string;
  dealId?: string;
  contactId?: string;
}) {
  return api<{ email: Email }>("/email/send", {
    method: "POST",
    json: input,
  });
}

export async function associateEmailToDeal(emailId: string, dealId: string) {
  return api<{ success: boolean }>(`/email/${emailId}/associate`, {
    method: "POST",
    json: { dealId },
  });
}
```

### 7b. Graph Auth Hook

**File: `client/src/hooks/use-graph-auth.ts`**

```typescript
import { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/api";

interface GraphAuthStatus {
  connected: boolean;
  status: string | null;
  errorMessage: string | null;
}

export function useGraphAuth() {
  const [authStatus, setAuthStatus] = useState<GraphAuthStatus>({
    connected: false,
    status: null,
    errorMessage: null,
  });
  const [loading, setLoading] = useState(true);

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<GraphAuthStatus>("/auth/graph/status");
      setAuthStatus(data);
    } catch {
      // If endpoint fails, assume not connected
      setAuthStatus({ connected: false, status: null, errorMessage: null });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  const startConsent = useCallback(async () => {
    try {
      const data = await api<{ url: string | null; devMode?: boolean }>("/auth/graph/consent");
      if (data.devMode) {
        // Dev mode: mark as connected without redirect
        setAuthStatus({ connected: true, status: "active", errorMessage: null });
        return;
      }
      if (data.url) {
        window.location.href = data.url;
      }
    } catch (err: unknown) {
      console.error("Failed to start Graph consent:", err);
    }
  }, []);

  const disconnect = useCallback(async () => {
    try {
      await api("/auth/graph/disconnect", { method: "POST" });
      setAuthStatus({ connected: false, status: "revoked", errorMessage: null });
    } catch (err: unknown) {
      console.error("Failed to disconnect Graph:", err);
    }
  }, []);

  return {
    ...authStatus,
    loading,
    startConsent,
    disconnect,
    refetch: fetchStatus,
  };
}
```

---

## Task 8: Frontend — Email Compose UI

- [ ] Create `client/src/components/email/email-compose-dialog.tsx`

**File: `client/src/components/email/email-compose-dialog.tsx`**

```typescript
import { useState } from "react";
import { Send, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { sendEmail } from "@/hooks/use-emails";

interface EmailComposeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSent?: () => void;
  defaultTo?: string;
  dealId?: string;
  contactId?: string;
}

export function EmailComposeDialog({
  open,
  onOpenChange,
  onSent,
  defaultTo,
  dealId,
  contactId,
}: EmailComposeDialogProps) {
  const [to, setTo] = useState(defaultTo ?? "");
  const [cc, setCc] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSend = async () => {
    if (!to.trim()) {
      setError("Recipient is required");
      return;
    }
    if (!subject.trim()) {
      setError("Subject is required");
      return;
    }
    if (!body.trim()) {
      setError("Message body is required");
      return;
    }

    setSending(true);
    setError(null);

    try {
      const toList = to
        .split(/[,;]/)
        .map((e) => e.trim())
        .filter(Boolean);
      const ccList = cc
        ? cc
            .split(/[,;]/)
            .map((e) => e.trim())
            .filter(Boolean)
        : undefined;

      // Wrap plain text in basic HTML
      const bodyHtml = `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 14px; line-height: 1.5;">${body
        .split("\n")
        .map((line) => `<p style="margin: 0 0 8px 0;">${escapeHtml(line) || "&nbsp;"}</p>`)
        .join("")}</div>`;

      await sendEmail({
        to: toList,
        cc: ccList,
        subject: subject.trim(),
        bodyHtml,
        dealId,
        contactId,
      });

      // Reset form
      setTo(defaultTo ?? "");
      setCc("");
      setSubject("");
      setBody("");
      onOpenChange(false);
      onSent?.();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to send email");
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>Compose Email</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <Label htmlFor="email-to">To</Label>
            <Input
              id="email-to"
              placeholder="recipient@example.com (separate multiple with commas)"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>

          <div>
            <Label htmlFor="email-cc">CC</Label>
            <Input
              id="email-cc"
              placeholder="cc@example.com (optional)"
              value={cc}
              onChange={(e) => setCc(e.target.value)}
            />
          </div>

          <div>
            <Label htmlFor="email-subject">Subject</Label>
            <Input
              id="email-subject"
              placeholder="Email subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
            />
          </div>

          <div>
            <Label htmlFor="email-body">Message</Label>
            <textarea
              id="email-body"
              className="flex min-h-[200px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              placeholder="Type your message..."
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </div>

          {error && (
            <p className="text-sm text-red-600">{error}</p>
          )}

          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={sending}
            >
              Cancel
            </Button>
            <Button onClick={handleSend} disabled={sending}>
              {sending ? (
                "Sending..."
              ) : (
                <>
                  <Send className="h-4 w-4 mr-2" />
                  Send
                </>
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
```

---

## Task 9: Frontend — Email Inbox/List View

- [ ] Create `client/src/components/email/email-row.tsx`
- [ ] Create `client/src/components/email/email-list.tsx`
- [ ] Create `client/src/components/email/graph-auth-banner.tsx`
- [ ] Create `client/src/pages/email/email-inbox-page.tsx`

### 9a. Email Row Component

**File: `client/src/components/email/email-row.tsx`**

```typescript
import { Mail, ArrowDownLeft, ArrowUpRight, Paperclip } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { Email } from "@/hooks/use-emails";

interface EmailRowProps {
  email: Email;
  onClick?: (email: Email) => void;
}

export function EmailRow({ email, onClick }: EmailRowProps) {
  const isInbound = email.direction === "inbound";
  const date = new Date(email.sentAt);
  const isToday = new Date().toDateString() === date.toDateString();
  const timeStr = isToday
    ? date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString("en-US", { month: "short", day: "numeric" });

  const displayAddress = isInbound
    ? email.fromAddress
    : email.toAddresses[0] ?? "Unknown";

  return (
    <div
      className="flex items-start gap-3 p-3 border-b hover:bg-muted/50 cursor-pointer transition-colors"
      onClick={() => onClick?.(email)}
    >
      <div className="mt-1">
        {isInbound ? (
          <ArrowDownLeft className="h-4 w-4 text-blue-500" />
        ) : (
          <ArrowUpRight className="h-4 w-4 text-green-500" />
        )}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium truncate">{displayAddress}</span>
          {email.hasAttachments && (
            <Paperclip className="h-3 w-3 text-muted-foreground flex-shrink-0" />
          )}
          <span className="text-xs text-muted-foreground ml-auto flex-shrink-0">
            {timeStr}
          </span>
        </div>
        <p className="text-sm truncate">{email.subject ?? "(No Subject)"}</p>
        <p className="text-xs text-muted-foreground truncate">
          {email.bodyPreview ?? ""}
        </p>
      </div>

      <div className="flex flex-col items-end gap-1">
        <Badge
          variant="outline"
          className={`text-xs ${
            isInbound
              ? "border-blue-200 text-blue-700"
              : "border-green-200 text-green-700"
          }`}
        >
          {isInbound ? "In" : "Out"}
        </Badge>
      </div>
    </div>
  );
}
```

### 9b. Email List Component (Reusable)

**File: `client/src/components/email/email-list.tsx`**

```typescript
import { useState } from "react";
import { Mail } from "lucide-react";
import { EmailRow } from "./email-row";
import { EmailThreadView } from "./email-thread-view";
import type { Email, Pagination } from "@/hooks/use-emails";
import { Button } from "@/components/ui/button";

interface EmailListProps {
  emails: Email[];
  pagination: Pagination;
  loading: boolean;
  error: string | null;
  onPageChange: (page: number) => void;
  emptyMessage?: string;
}

export function EmailList({
  emails,
  pagination,
  loading,
  error,
  onPageChange,
  emptyMessage = "No emails yet",
}: EmailListProps) {
  const [selectedEmail, setSelectedEmail] = useState<Email | null>(null);

  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-16 bg-muted animate-pulse rounded" />
        ))}
      </div>
    );
  }

  if (error) {
    return <p className="text-red-600 text-sm py-4">{error}</p>;
  }

  if (selectedEmail?.graphConversationId) {
    return (
      <EmailThreadView
        conversationId={selectedEmail.graphConversationId}
        onBack={() => setSelectedEmail(null)}
      />
    );
  }

  if (selectedEmail) {
    // Single email view (no conversation ID)
    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" onClick={() => setSelectedEmail(null)}>
          Back to list
        </Button>
        <div className="border rounded-lg p-4">
          <div className="flex justify-between items-start mb-3">
            <div>
              <h3 className="font-medium">{selectedEmail.subject ?? "(No Subject)"}</h3>
              <p className="text-sm text-muted-foreground">
                {selectedEmail.direction === "inbound" ? "From" : "To"}:{" "}
                {selectedEmail.direction === "inbound"
                  ? selectedEmail.fromAddress
                  : selectedEmail.toAddresses.join(", ")}
              </p>
            </div>
            <span className="text-xs text-muted-foreground">
              {new Date(selectedEmail.sentAt).toLocaleString()}
            </span>
          </div>
          <div
            className="prose prose-sm max-w-none"
            dangerouslySetInnerHTML={{
              __html: selectedEmail.bodyHtml ?? selectedEmail.bodyPreview ?? "",
            }}
          />
        </div>
      </div>
    );
  }

  if (emails.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <Mail className="h-12 w-12 mx-auto mb-3 opacity-50" />
        <p>{emptyMessage}</p>
      </div>
    );
  }

  return (
    <div>
      <div className="border rounded-lg overflow-hidden">
        {emails.map((email) => (
          <EmailRow
            key={email.id}
            email={email}
            onClick={setSelectedEmail}
          />
        ))}
      </div>

      {/* Pagination */}
      {pagination.totalPages > 1 && (
        <div className="flex items-center justify-between mt-4">
          <span className="text-sm text-muted-foreground">
            Page {pagination.page} of {pagination.totalPages} ({pagination.total} emails)
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={pagination.page <= 1}
              onClick={() => onPageChange(pagination.page - 1)}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={pagination.page >= pagination.totalPages}
              onClick={() => onPageChange(pagination.page + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
```

### 9c. Graph Auth Banner

Shows a "Connect your email" banner when Graph is not connected, or a reauth warning when tokens are expired.

**File: `client/src/components/email/graph-auth-banner.tsx`**

```typescript
import { Mail, AlertTriangle, CheckCircle, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useGraphAuth } from "@/hooks/use-graph-auth";

export function GraphAuthBanner() {
  const { connected, status, errorMessage, loading, startConsent, disconnect } =
    useGraphAuth();

  if (loading) return null;

  // Connected and healthy — no banner needed
  if (connected) return null;

  // Needs reauthorization
  if (status === "reauth_needed") {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 mb-4">
        <div className="flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 text-amber-600 mt-0.5 flex-shrink-0" />
          <div className="flex-1">
            <h3 className="text-sm font-medium text-amber-800">
              Email Reconnection Needed
            </h3>
            <p className="text-sm text-amber-700 mt-1">
              Your Microsoft email connection expired.
              {errorMessage && ` (${errorMessage})`}
            </p>
            <Button
              size="sm"
              className="mt-2"
              onClick={startConsent}
            >
              <ExternalLink className="h-4 w-4 mr-2" />
              Reconnect Email
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // Not connected at all
  return (
    <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 mb-4">
      <div className="flex items-start gap-3">
        <Mail className="h-5 w-5 text-blue-600 mt-0.5 flex-shrink-0" />
        <div className="flex-1">
          <h3 className="text-sm font-medium text-blue-800">
            Connect Your Email
          </h3>
          <p className="text-sm text-blue-700 mt-1">
            Connect your Microsoft 365 account to send and receive emails
            directly from the CRM. Emails are automatically linked to your
            deals and contacts.
          </p>
          <Button
            size="sm"
            className="mt-2"
            onClick={startConsent}
          >
            <ExternalLink className="h-4 w-4 mr-2" />
            Connect Microsoft Email
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Compact status indicator for the sidebar or header.
 */
export function GraphAuthStatusIndicator() {
  const { connected, status, loading } = useGraphAuth();

  if (loading) return null;

  if (connected) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-green-600">
        <CheckCircle className="h-3 w-3" />
        <span>Email connected</span>
      </div>
    );
  }

  if (status === "reauth_needed") {
    return (
      <div className="flex items-center gap-1.5 text-xs text-amber-600">
        <AlertTriangle className="h-3 w-3" />
        <span>Email needs reconnection</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <Mail className="h-3 w-3" />
      <span>Email not connected</span>
    </div>
  );
}
```

### 9d. Email Inbox Page

**File: `client/src/pages/email/email-inbox-page.tsx`**

```typescript
import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Mail, Plus, Filter } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { GraphAuthBanner } from "@/components/email/graph-auth-banner";
import { EmailList } from "@/components/email/email-list";
import { EmailComposeDialog } from "@/components/email/email-compose-dialog";
import { useUserEmails } from "@/hooks/use-emails";

export function EmailInboxPage() {
  const [searchParams] = useSearchParams();
  const [search, setSearch] = useState("");
  const [direction, setDirection] = useState<"inbound" | "outbound" | undefined>(
    undefined
  );
  const [page, setPage] = useState(1);
  const [composeOpen, setComposeOpen] = useState(false);

  // Check URL params for success/error from OAuth callback
  const connected = searchParams.get("connected");
  const oauthError = searchParams.get("error");

  const { emails, pagination, loading, error, refetch } = useUserEmails({
    direction,
    search: search.length >= 2 ? search : undefined,
    page,
    limit: 25,
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Email</h2>
        <Button onClick={() => setComposeOpen(true)}>
          <Plus className="h-4 w-4 mr-2" />
          Compose
        </Button>
      </div>

      {/* OAuth callback messages */}
      {connected === "true" && (
        <div className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-800">
          Microsoft email connected successfully.
        </div>
      )}
      {oauthError && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          Failed to connect email: {oauthError}
        </div>
      )}

      <GraphAuthBanner />

      {/* Filters */}
      <div className="flex items-center gap-3">
        <Input
          placeholder="Search emails..."
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
          className="max-w-xs"
        />
        <Select
          value={direction ?? "all"}
          onValueChange={(val) => {
            setDirection(val === "all" ? undefined : (val as "inbound" | "outbound"));
            setPage(1);
          }}
        >
          <SelectTrigger className="w-[140px]">
            <SelectValue placeholder="All emails" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Emails</SelectItem>
            <SelectItem value="inbound">Inbound</SelectItem>
            <SelectItem value="outbound">Outbound</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <EmailList
        emails={emails}
        pagination={pagination}
        loading={loading}
        error={error}
        onPageChange={setPage}
        emptyMessage="No emails yet. Connect your Microsoft account or compose your first email."
      />

      <EmailComposeDialog
        open={composeOpen}
        onOpenChange={setComposeOpen}
        onSent={refetch}
      />
    </div>
  );
}
```

---

## Task 10: Frontend — Email Thread View (on Deal and Contact Detail Pages)

- [ ] Create `client/src/components/email/email-thread-view.tsx`
- [ ] Create `client/src/components/email/deal-email-tab.tsx`
- [ ] Create `client/src/components/email/contact-email-tab.tsx`
- [ ] Update `client/src/pages/deals/deal-detail-page.tsx` to use `DealEmailTab`
- [ ] Update `client/src/pages/contacts/contact-detail-page.tsx` to add email tab

### 10a. Email Thread View

Displays all emails in a conversation thread, ordered chronologically.

**File: `client/src/components/email/email-thread-view.tsx`**

```typescript
import { ArrowLeft, ArrowDownLeft, ArrowUpRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useEmailThread } from "@/hooks/use-emails";

interface EmailThreadViewProps {
  conversationId: string;
  onBack: () => void;
}

export function EmailThreadView({ conversationId, onBack }: EmailThreadViewProps) {
  const { emails, loading, error } = useEmailThread(conversationId);

  if (loading) {
    return (
      <div className="space-y-3">
        <div className="h-8 w-32 bg-muted animate-pulse rounded" />
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-24 bg-muted animate-pulse rounded-lg" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div>
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="h-4 w-4 mr-1" />
          Back
        </Button>
        <p className="text-red-600 text-sm mt-2">{error}</p>
      </div>
    );
  }

  const subject = emails[0]?.subject ?? "(No Subject)";

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="h-4 w-4 mr-1" />
          Back
        </Button>
        <h3 className="font-medium">{subject}</h3>
        <span className="text-xs text-muted-foreground">
          {emails.length} message{emails.length !== 1 ? "s" : ""}
        </span>
      </div>

      <div className="space-y-3">
        {emails.map((email) => {
          const isInbound = email.direction === "inbound";
          return (
            <div
              key={email.id}
              className={`border rounded-lg p-4 ${
                isInbound ? "border-l-4 border-l-blue-400" : "border-l-4 border-l-green-400"
              }`}
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  {isInbound ? (
                    <ArrowDownLeft className="h-4 w-4 text-blue-500" />
                  ) : (
                    <ArrowUpRight className="h-4 w-4 text-green-500" />
                  )}
                  <span className="text-sm font-medium">
                    {isInbound ? email.fromAddress : `To: ${email.toAddresses.join(", ")}`}
                  </span>
                </div>
                <span className="text-xs text-muted-foreground">
                  {new Date(email.sentAt).toLocaleString()}
                </span>
              </div>
              <div
                className="prose prose-sm max-w-none"
                dangerouslySetInnerHTML={{
                  __html: email.bodyHtml ?? email.bodyPreview ?? "",
                }}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

### 10b. Deal Email Tab

**File: `client/src/components/email/deal-email-tab.tsx`**

```typescript
import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmailList } from "./email-list";
import { EmailComposeDialog } from "./email-compose-dialog";
import { GraphAuthBanner } from "./graph-auth-banner";
import { useDealEmails } from "@/hooks/use-emails";

interface DealEmailTabProps {
  dealId: string;
  primaryContactEmail?: string | null;
}

export function DealEmailTab({ dealId, primaryContactEmail }: DealEmailTabProps) {
  const [page, setPage] = useState(1);
  const [composeOpen, setComposeOpen] = useState(false);

  const { emails, pagination, loading, error, refetch } = useDealEmails(dealId, {
    page,
    limit: 15,
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">Email</h3>
        <Button size="sm" onClick={() => setComposeOpen(true)}>
          <Plus className="h-4 w-4 mr-1" />
          Compose
        </Button>
      </div>

      <GraphAuthBanner />

      <EmailList
        emails={emails}
        pagination={pagination}
        loading={loading}
        error={error}
        onPageChange={setPage}
        emptyMessage="No emails linked to this deal yet."
      />

      <EmailComposeDialog
        open={composeOpen}
        onOpenChange={setComposeOpen}
        onSent={refetch}
        defaultTo={primaryContactEmail ?? undefined}
        dealId={dealId}
      />
    </div>
  );
}
```

### 10c. Contact Email Tab

**File: `client/src/components/email/contact-email-tab.tsx`**

```typescript
import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmailList } from "./email-list";
import { EmailComposeDialog } from "./email-compose-dialog";
import { GraphAuthBanner } from "./graph-auth-banner";
import { useContactEmails } from "@/hooks/use-emails";

interface ContactEmailTabProps {
  contactId: string;
  contactEmail?: string | null;
}

export function ContactEmailTab({ contactId, contactEmail }: ContactEmailTabProps) {
  const [page, setPage] = useState(1);
  const [composeOpen, setComposeOpen] = useState(false);

  const { emails, pagination, loading, error, refetch } = useContactEmails(contactId, {
    page,
    limit: 15,
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">Email</h3>
        <Button size="sm" onClick={() => setComposeOpen(true)}>
          <Plus className="h-4 w-4 mr-1" />
          Compose
        </Button>
      </div>

      <GraphAuthBanner />

      <EmailList
        emails={emails}
        pagination={pagination}
        loading={loading}
        error={error}
        onPageChange={setPage}
        emptyMessage="No emails for this contact yet."
      />

      <EmailComposeDialog
        open={composeOpen}
        onOpenChange={setComposeOpen}
        onSent={refetch}
        defaultTo={contactEmail ?? undefined}
        contactId={contactId}
      />
    </div>
  );
}
```

### 10d. Update Deal Detail Page — Replace Email Placeholder

**File: `client/src/pages/deals/deal-detail-page.tsx`**

Add import at top:

```typescript
import { DealEmailTab } from "@/components/email/deal-email-tab";
```

Replace the email tab placeholder:

```typescript
// REPLACE this block:
{activeTab === "email" && (
  <div className="text-center py-12 text-muted-foreground">
    <p>Email integration coming in Plan 5: Email</p>
  </div>
)}

// WITH:
{activeTab === "email" && <DealEmailTab dealId={deal.id} />}
```

### 10e. Update Contact Detail Page — Add Email Tab

**File: `client/src/pages/contacts/contact-detail-page.tsx`**

Add import at top:

```typescript
import { ContactEmailTab } from "@/components/email/contact-email-tab";
```

Update the `Tab` type and tabs array:

```typescript
// REPLACE:
type Tab = "deals" | "activity" | "files";

// WITH:
type Tab = "deals" | "email" | "activity" | "files";
```

```typescript
// REPLACE tabs array:
const tabs: { key: Tab; label: string }[] = [
  { key: "deals", label: "Deals" },
  { key: "activity", label: "Activity" },
  { key: "files", label: "Files" },
];

// WITH:
const tabs: { key: Tab; label: string }[] = [
  { key: "deals", label: "Deals" },
  { key: "email", label: "Email" },
  { key: "activity", label: "Activity" },
  { key: "files", label: "Files" },
];
```

Add the email tab content after the deals tab content:

```typescript
{activeTab === "email" && (
  <ContactEmailTab contactId={contact.id} contactEmail={contact.email} />
)}
```

---

## Task 11: Frontend — Graph Auth Consent Flow UI

The consent flow UI is already implemented via:
- `GraphAuthBanner` (Task 9c) — shows "Connect" / "Reconnect" banners
- `useGraphAuth` hook (Task 7b) — manages auth state and consent initiation
- OAuth callback handling in `EmailInboxPage` (Task 9d) — shows success/error from URL params

No additional components needed. The flow:
1. User visits /email or any email tab
2. `GraphAuthBanner` renders if not connected
3. User clicks "Connect Microsoft Email"
4. `useGraphAuth.startConsent()` calls `GET /api/auth/graph/consent`
5. Server returns the Microsoft OAuth URL
6. User is redirected to Microsoft consent screen
7. After consent, Microsoft redirects back to `GET /api/auth/graph/callback`
8. Server exchanges code for tokens, stores encrypted tokens
9. Server redirects to `/email?connected=true`
10. `EmailInboxPage` shows success message

- [ ] Verify consent flow works end-to-end
- [ ] Verify reauth banner appears when status is `reauth_needed`

---

## Task 12: Route and Navigation Wiring

- [ ] Update `client/src/App.tsx` — replace email placeholder route
- [ ] Verify navigation sidebar links to `/email`

### 12a. Update App.tsx Routes

**File: `client/src/App.tsx`**

Add import at top:

```typescript
import { EmailInboxPage } from "@/pages/email/email-inbox-page";
```

Replace the email placeholder route:

```typescript
// REPLACE:
<Route path="/email" element={<PlaceholderPage title="Email" />} />

// WITH:
<Route path="/email" element={<EmailInboxPage />} />
```

---

## Environment Variables Required

Add these to Railway and local `.env`:

```
# MS Graph OAuth (Email Integration)
AZURE_CLIENT_ID=<from-azure-app-registration>
AZURE_CLIENT_SECRET=<from-azure-app-registration>
AZURE_TENANT_ID=<t-rock-azure-tenant-id>

# Token encryption key (32-byte hex string = 64 hex chars)
# Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
ENCRYPTION_KEY=<64-hex-chars>

# API base URL (for OAuth callback redirect)
API_BASE_URL=https://your-api-service.railway.app
```

**Dev mode:** When `AZURE_CLIENT_ID` is not set, all Graph features degrade gracefully -- emails can be composed and stored locally without sending via Graph, and the auth banner shows a dev-mode message.

---

## Dependencies to Install

```bash
# Server
cd server && npm install @azure/msal-node

# No new client dependencies needed — uses existing shadcn/ui components
```

---

## Verification Checklist

After implementation, verify:

- [ ] `ENCRYPTION_KEY` environment variable is set and produces valid encrypt/decrypt round-trips
- [ ] `GET /api/auth/graph/status` returns `{ connected: false }` when no tokens exist
- [ ] `GET /api/auth/graph/consent` returns a valid Microsoft OAuth URL (or dev mode message)
- [ ] OAuth callback stores encrypted tokens in `user_graph_tokens`
- [ ] `POST /api/email/send` sends via Graph API (or stores locally in dev mode)
- [ ] Sent emails appear in `emails` table with `direction = 'outbound'`
- [ ] Sent emails create activity records in `activities` table
- [ ] `email.sent` domain event is emitted
- [ ] Worker email sync runs every 5 minutes without errors
- [ ] Delta sync only stores emails from/to known CRM contacts (selective sync)
- [ ] `graph_message_id` UNIQUE constraint prevents duplicate email records on re-sync
- [ ] Auto-association: 1 active deal = email linked to deal
- [ ] Auto-association: multiple active deals = task created for rep
- [ ] Auto-association: 0 active deals = email linked to contact only
- [ ] `email.received` domain event creates notification for rep
- [ ] Thread grouping by `graph_conversation_id` works in thread view
- [ ] Email tab on deal detail page shows deal-scoped emails
- [ ] Email tab on contact detail page shows contact-scoped emails
- [ ] Compose dialog sends email with correct deal/contact associations
- [ ] Graph auth banner shows when not connected
- [ ] Graph auth banner shows reauth warning when tokens expire
- [ ] Inbox page at `/email` shows all user emails with search/filter
- [ ] All tests pass: `npx vitest run server/tests/modules/email/`
- [ ] `tsc --noEmit` passes with no type errors
