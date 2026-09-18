import crypto from "crypto";

/**
 * Token generation and hashing for single-use reset links.
 *
 * Lives here rather than in field-users/service.ts, where it started, so the CRM auth path does not
 * import from the field module to do its own auth. The field flow re-exports these under its original
 * names, so both flows share ONE implementation -- two copies that drifted would mean a token issued by
 * one path could not be consumed by the other.
 */

// 32 bytes = 256 bits. The token is not guessable, so no rate limit is load-bearing for brute force;
// the limits that exist are there to stop mailbox flooding, not search.
const RESET_TOKEN_BYTES = 32;

export function generateResetToken(): string {
  // base64url, so the value survives a URL fragment without escaping.
  return crypto.randomBytes(RESET_TOKEN_BYTES).toString("base64url");
}

/**
 * SHA-256, deliberately NOT a password KDF.
 *
 * The input is already 256-bit uniform random, so there is no dictionary to attack and a slow KDF buys
 * nothing. On an unauthenticated lookup path it would actively hurt: it hands anyone a cheap way to
 * burn server CPU. Constant-time comparison is likewise unnecessary -- lookup is an indexed equality on
 * a hash of a high-entropy secret, not a comparison against a user-supplied guess.
 */
export function hashResetToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}
