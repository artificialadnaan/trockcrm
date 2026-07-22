import crypto from "crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@trock-crm/shared/schema";
import { scorecardCorrectiveActionTokens } from "@trock-crm/shared/schema";

type TenantDb = NodePgDatabase<typeof schema>;

const TOKEN_BYTES = 32;

export type CorrectiveActionRole = "superintendent" | "project_manager";

export interface MintCorrectiveActionTokenInput {
  scorecardId: string;
  recipientEmail: string;
  role: CorrectiveActionRole;
  /** Time-to-live in days from now. */
  ttlDays: number;
}

export interface VerifiedCorrectiveActionToken {
  scorecardId: string;
  recipientEmail: string;
  role: CorrectiveActionRole;
}

/** Random raw token handed to the recipient (in the email); never stored. */
export function generateRawCorrectiveActionToken(): string {
  return crypto.randomBytes(TOKEN_BYTES).toString("base64url");
}

/** sha256 hex of a raw token — this is what the row stores (hash at rest, mirroring public_photo_tokens). */
export function hashCorrectiveActionToken(rawToken: string): string {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

/**
 * Mint a recipient-bound web token for a scorecard's corrective-action flow. Returns the RAW token to embed
 * in the recipient's email; the DB row stores only its sha256 hash + an expiry (now + ttlDays). Runs in the
 * deal's office schema (the caller sets search_path / passes the tenant db). Mirrors public_photo_tokens.
 */
export async function mintCorrectiveActionToken(
  db: TenantDb,
  input: MintCorrectiveActionTokenInput,
): Promise<{ rawToken: string }> {
  const rawToken = generateRawCorrectiveActionToken();
  const tokenHash = hashCorrectiveActionToken(rawToken);
  const expiresAt = new Date(Date.now() + input.ttlDays * 24 * 60 * 60 * 1000);
  await db.insert(scorecardCorrectiveActionTokens).values({
    scorecardId: input.scorecardId,
    tokenHash,
    recipientEmail: input.recipientEmail,
    role: input.role,
    expiresAt,
  });
  return { rawToken };
}

/**
 * Verify a raw web token. Returns the bound { scorecardId, recipientEmail, role } for a valid, unexpired
 * token, or null for an unknown / tampered / expired one. Read-only (no consumption): the corrective-action
 * flow allows multiple per-item submissions until the scorecard closes, so the token stays usable up to its
 * expiry. The token_hash lookup means a tampered raw value hashes to a different (non-existent) row → null.
 */
export async function verifyCorrectiveActionToken(
  db: TenantDb,
  rawToken: string,
): Promise<VerifiedCorrectiveActionToken | null> {
  if (!rawToken) return null;
  const tokenHash = hashCorrectiveActionToken(rawToken);
  const rows = await db
    .select({
      scorecardId: scorecardCorrectiveActionTokens.scorecardId,
      recipientEmail: scorecardCorrectiveActionTokens.recipientEmail,
      role: scorecardCorrectiveActionTokens.role,
    })
    .from(scorecardCorrectiveActionTokens)
    .where(
      and(
        eq(scorecardCorrectiveActionTokens.tokenHash, tokenHash),
        gt(scorecardCorrectiveActionTokens.expiresAt, sql`now()`),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    scorecardId: row.scorecardId,
    recipientEmail: row.recipientEmail,
    role: row.role as CorrectiveActionRole,
  };
}
