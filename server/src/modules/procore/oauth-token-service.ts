import { eq } from "drizzle-orm";
import { db } from "../../db.js";
import { decrypt, encrypt } from "../../lib/encryption.js";
import { procoreOauthTokens } from "../../../../shared/src/schema/public/procore-oauth-tokens.js";

export interface ProcoreOauthTokenData {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  scopes: string[];
  accountEmail?: string | null;
  accountName?: string | null;
}

type ProcoreOauthDb = Pick<typeof db, "select" | "insert" | "update">;

export async function upsertProcoreOauthTokens(
  dbClient: ProcoreOauthDb,
  tokens: ProcoreOauthTokenData
): Promise<void> {
  const encryptedAccessToken = encrypt(tokens.accessToken);
  const encryptedRefreshToken = encrypt(tokens.refreshToken);

  const existingRows = await dbClient
    .select({ id: procoreOauthTokens.id })
    .from(procoreOauthTokens)
    .limit(1);

  const row = existingRows[0];
  if (row) {
    await dbClient
      .update(procoreOauthTokens)
      .set({
        accessToken: encryptedAccessToken,
        refreshToken: encryptedRefreshToken,
        tokenExpiresAt: tokens.expiresAt,
        scopes: tokens.scopes,
        connectedAccountEmail: tokens.accountEmail ?? null,
        connectedAccountName: tokens.accountName ?? null,
        status: "active",
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(procoreOauthTokens.id, row.id));
    return;
  }

  await dbClient.insert(procoreOauthTokens).values({
    accessToken: encryptedAccessToken,
    refreshToken: encryptedRefreshToken,
    tokenExpiresAt: tokens.expiresAt,
    scopes: tokens.scopes,
    connectedAccountEmail: tokens.accountEmail ?? null,
    connectedAccountName: tokens.accountName ?? null,
    status: "active",
    lastError: null,
  });
}

export async function getStoredProcoreOauthTokens(
  dbClient: ProcoreOauthDb
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
  const rows = await dbClient.select().from(procoreOauthTokens).limit(1);
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
  dbClient: ProcoreOauthDb,
  errorMessage: string
): Promise<void> {
  const rows = await dbClient.select({ id: procoreOauthTokens.id }).from(procoreOauthTokens).limit(1);
  const row = rows[0];
  if (!row) return;

  await dbClient
    .update(procoreOauthTokens)
    .set({
      status: "reauth_needed",
      lastError: errorMessage,
      updatedAt: new Date(),
    })
    .where(eq(procoreOauthTokens.id, row.id));
}
