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
