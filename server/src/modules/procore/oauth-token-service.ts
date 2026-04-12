import { eq } from "drizzle-orm";
import { db } from "../../db.js";
import { decrypt, encrypt } from "../../lib/encryption.js";
import { procoreOauthTokens } from "@trock-crm/shared/schema";

export interface ProcoreOauthTokenData {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  scopes: string[];
  accountEmail?: string | null;
  accountName?: string | null;
}

type ProcoreOauthDb = Pick<typeof db, "select" | "insert" | "update" | "delete">;

interface RefreshStoredProcoreOauthTokensOptions {
  dbClient?: ProcoreOauthDb;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export async function upsertProcoreOauthTokens(
  tokens: ProcoreOauthTokenData,
  dbClient: ProcoreOauthDb = db
): Promise<void> {
  const encryptedAccessToken = encrypt(tokens.accessToken);
  const encryptedRefreshToken = encrypt(tokens.refreshToken);

  await dbClient.insert(procoreOauthTokens).values({
    singletonKey: 1,
    accessToken: encryptedAccessToken,
    refreshToken: encryptedRefreshToken,
    tokenExpiresAt: tokens.expiresAt,
    scopes: tokens.scopes,
    connectedAccountEmail: tokens.accountEmail ?? null,
    connectedAccountName: tokens.accountName ?? null,
    status: "active",
    lastError: null,
  }).onConflictDoUpdate({
    target: procoreOauthTokens.singletonKey,
    set: {
      singletonKey: 1,
      accessToken: encryptedAccessToken,
      refreshToken: encryptedRefreshToken,
      tokenExpiresAt: tokens.expiresAt,
      scopes: tokens.scopes,
      connectedAccountEmail: tokens.accountEmail ?? null,
      connectedAccountName: tokens.accountName ?? null,
      status: "active",
      lastError: null,
      updatedAt: new Date(),
    },
  });
}

export async function getStoredProcoreOauthTokens(
  dbClient: ProcoreOauthDb = db
): Promise<
  | {
      id: string;
      accessToken: string;
      refreshToken: string;
      expiresAt: Date;
      scopes: string[];
      accountEmail: string | null;
      accountName: string | null;
      status: string;
      lastError: string | null;
    }
  | null
> {
  const rows = await dbClient
    .select()
    .from(procoreOauthTokens)
    .where(eq(procoreOauthTokens.singletonKey, 1))
    .limit(1);
  const row = rows[0];
  if (!row) return null;

  return {
    id: row.id,
    accessToken: decrypt(row.accessToken),
    refreshToken: decrypt(row.refreshToken),
    expiresAt: row.tokenExpiresAt,
    scopes: row.scopes,
    accountEmail: row.connectedAccountEmail ?? null,
    accountName: row.connectedAccountName ?? null,
    status: row.status,
    lastError: row.lastError ?? null,
  };
}

export async function markProcoreOauthReauthNeeded(
  dbClient: ProcoreOauthDb = db,
  errorMessage: string
): Promise<void> {
  await dbClient
    .update(procoreOauthTokens)
    .set({
      status: "reauth_needed",
      lastError: errorMessage,
      updatedAt: new Date(),
    })
    .where(eq(procoreOauthTokens.singletonKey, 1));
}

export async function clearStoredProcoreOauthTokens(
  dbClient: ProcoreOauthDb = db
): Promise<void> {
  await dbClient
    .delete(procoreOauthTokens)
    .where(eq(procoreOauthTokens.singletonKey, 1));
}

export async function refreshStoredProcoreOauthTokens(
  refreshToken: string,
  options: RefreshStoredProcoreOauthTokensOptions = {}
): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const dbClient = options.dbClient ?? db;
  const now = options.now ?? (() => new Date());
  const existingTokens = await getStoredProcoreOauthTokens(dbClient);

  const response = await fetchImpl("https://login.procore.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: process.env.PROCORE_CLIENT_ID,
      client_secret: process.env.PROCORE_CLIENT_SECRET,
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    const errorText = (await response.text().catch(() => "")) || "refresh failed";
    await markProcoreOauthReauthNeeded(dbClient, errorText);
    throw new Error("PROCORE_OAUTH_REFRESH_FAILED");
  }

  const data = await response.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope?: string;
  };

  await upsertProcoreOauthTokens(
    {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? refreshToken,
      expiresAt: new Date(now().getTime() + data.expires_in * 1000),
      scopes: data.scope?.split(" ") ?? [],
      accountEmail: existingTokens?.accountEmail ?? null,
      accountName: existingTokens?.accountName ?? null,
    },
    dbClient
  );

  return data.access_token;
}
