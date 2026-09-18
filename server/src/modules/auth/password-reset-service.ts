import { eq, sql } from "drizzle-orm";
import { userLocalAuth, users } from "@trock-crm/shared/schema";
import { db, pool, releasePooledClient } from "../../db.js";
import { closeUserSseConnections } from "../notifications/sse-manager.js";
import { sendSystemEmail } from "../../lib/resend-client.js";
import { hashPassword, recordLocalAuthEvent } from "./local-auth-service.js";
import { buildPasswordChangedEmail, buildPasswordResetEmail } from "./password-reset-emails.js";
import { generateResetToken, hashResetToken } from "./reset-tokens.js";
import { incrementTokenVersion } from "./session-invalidation.js";

/**
 * Self-service password reset for CRM local-auth users.
 *
 * Separate from local-auth-service.ts (already ~600 lines) and from the field reset flow, whose consume
 * path filters role = 'field_contractor'.
 *
 * The threat model is an attacker who knows a valid T-Rock email, has NO mailbox access, and can make
 * unlimited unauthenticated requests. Everything below follows from that: identical responses, no
 * timing signal, and a token that is useless without the inbox.
 */

// 60 minutes. The field flow uses 30; this is longer on purpose, because a link that expires while
// someone walks away sends them back to emailing an admin, which is the problem being solved. The
// token is single-use and 256-bit, so the TTL bounds blast radius rather than doing the security work.
export const RESET_TTL_MINUTES = 60;

const RATE_LIMIT_WINDOW_MINUTES = 15;
const RATE_LIMIT_MAX_REQUESTS = 3;

/**
 * Where reset links point.
 *
 * NOT the FRONTEND_URL helper the other emails use: that resolves to the Railway frontend subdomain,
 * and NOT ONBOARDING_CLEANUP_URL, which is a different service again. This must be the origin people
 * actually sign in at.
 */
const DEFAULT_RESET_BASE_URL = "https://trockcrm.com";

export type QueryClient = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
  /**
   * Runs fn against a SINGLE dedicated connection inside BEGIN/COMMIT.
   *
   * Required, not a convenience. `pool.query` hands out an arbitrary connection per call, so a
   * read-then-write gate spread across several calls has no isolation at all -- and BEGIN issued
   * through the pool would not even land on the same connection as the statements it is meant to wrap.
   */
  transaction: <T>(fn: (tx: QueryClient) => Promise<T>) => Promise<T>;
};

/**
 * The production query client, backed by the shared pg pool.
 *
 * Deliberately the pool and NOT `db.execute(sql.raw(text, params))`: sql.raw does not bind $n
 * parameters, so the raw-SQL helpers here would silently receive unsubstituted placeholders in
 * production while passing under PGlite in tests. Same parameterised statements in both places.
 */
export const dbClient: QueryClient = {
  query: (text: string, params?: unknown[]) => pool.query(text, params as unknown[]),
  transaction: async (fn) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const scoped: QueryClient = {
        query: (text: string, params?: unknown[]) => client.query(text, params as unknown[]),
        // Already inside a transaction -- nesting would issue a second BEGIN, which Postgres warns
        // about and ignores, so the inner "commit" would end the OUTER transaction early.
        transaction: (inner) => inner(scoped),
      };
      const result = await fn(scoped);
      await client.query("COMMIT");
      client.release();
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      // releasePooledClient discards a connection broken mid-transaction rather than returning a
      // poisoned one to the pool.
      releasePooledClient(client, err);
      throw err;
    }
  },
};

export function resetExpiry(baseDate = new Date()): Date {
  return new Date(baseDate.getTime() + RESET_TTL_MINUTES * 60 * 1000);
}

export function resetUrl(rawToken: string): string {
  const configured = (process.env.PASSWORD_RESET_BASE_URL ?? "").trim().replace(/\/+$/, "");
  // Falls back rather than throwing. The request route answers 200 BEFORE sending mail, so a throw
  // here would produce "check your email" and no email at all -- a feature that ships dead with only a
  // log line to show for it. Same durable-backstop shape as resolveFrontendBaseUrl in the daily summary.
  let base = DEFAULT_RESET_BASE_URL;
  if (configured) {
    try {
      const parsed = new URL(configured);
      // Must be absolute http(s): a relative value would build a link that breaks in email clients.
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        base = (parsed.origin + parsed.pathname).replace(/\/+$/, "");
      }
    } catch {
      /* not a valid absolute URL -- keep the default */
    }
  }
  // FRAGMENT, not query string. The fragment is never transmitted to the server, so the token cannot
  // appear in Railway/proxy access logs, in Referer, or in server-side error reporting that captures
  // request URLs. The SPA reads location.hash and POSTs the value in a body.
  return `${base}/reset-password#token=${encodeURIComponent(rawToken)}`;
}

/**
 * Eligible = active user, local auth row exists, enabled, not revoked.
 *
 * Revoked users are deliberately ineligible: revocation must not be undoable by self-serve reset.
 * Anything else returns null and the caller sends no email -- while still returning the SAME generic
 * response to the requester.
 */
export async function selectEligibleUser(
  client: QueryClient,
  email: string
): Promise<{ id: string; email: string; display_name: string } | null> {
  const result = await client.query(
    `SELECT u.id, u.email, COALESCE(u.display_name, u.email) AS display_name
       FROM public.users u
       JOIN public.user_local_auth la ON la.user_id = u.id
      WHERE lower(u.email) = lower($1)
        AND u.is_active = true
        AND la.is_enabled = true
        AND la.revoked_at IS NULL
        -- Field contractors are excluded. They HAVE user_local_auth rows, so without this they would
        -- be eligible here and a T-Rock Cam crew member could self-serve a reset from a CRM-branded
        -- email -- rewriting their field password and, because field auth also checks token_version,
        -- signing them out of the field app. The field flow is admin-initiated by design and filters
        -- role on its own consume path; this is the complementary filter that makes the two flows
        -- partition instead of overlap.
        AND u.role <> 'field_contractor'
      LIMIT 1`,
    [email]
  );
  return (result.rows ?? [])[0] ?? null;
}

/**
 * Counts ALL rows in the window, including used and invalidated ones. Counting only live rows would
 * let someone refill their quota simply by burning each link as it arrived.
 *
 * Counted from persisted rows rather than memory so the limit holds across API replicas and restarts.
 */
export async function countRecentResets(
  client: QueryClient,
  userId: string,
  windowMinutes: number
): Promise<number> {
  const result = await client.query(
    `SELECT count(*)::int AS n
       FROM public.user_password_resets
      WHERE user_id = $1
        AND created_at > now() - ($2 || ' minutes')::interval`,
    [userId, String(windowMinutes)]
  );
  return (result.rows ?? [])[0]?.n ?? 0;
}

/**
 * Issues a token, or returns null when the caller should send no email.
 *
 * NEVER throws for ineligibility -- the route must respond identically either way, so "not eligible"
 * and "rate limited" are both just null here and both still produce the generic 200 upstream.
 */
export async function issueResetToken(
  client: QueryClient,
  email: string,
  requestedIp: string | null
): Promise<{ rawToken: string; user: { id: string; email: string; display_name: string } } | null> {
  const user = await selectEligibleUser(client, email);
  if (!user) return null;

  const rawToken = generateResetToken();
  const tokenHash = hashResetToken(rawToken);

  /**
   * Count, invalidate and insert run in ONE transaction behind a per-account advisory lock.
   *
   * Spread across pooled connections this gate was bypassable: at READ COMMITTED an uncommitted INSERT
   * is invisible to a concurrent count, so N simultaneous requests all read the same number and all
   * insert. Measured at 6 accepted out of 6 against a cap of 3 -- six emails to one mailbox from one
   * burst, which is precisely the flooding the limit exists to prevent. The IP limiter is no backstop
   * because it is keyed by IP, not by account.
   *
   * The lock is taken BEFORE the count so the whole read-decide-write sequence is serialized per user;
   * it releases at commit. Keyed by hashtext(user_id) -- collisions across different users are possible
   * but harmless, costing at most brief serialization between two unrelated accounts.
   */
  const issued = await client.transaction(async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [user.id]);

    const recent = await countRecentResets(tx, user.id, RATE_LIMIT_WINDOW_MINUTES);
    if (recent >= RATE_LIMIT_MAX_REQUESTS) return false;

    // One live link at a time: requesting a new link kills the previous one, so a forwarded or
    // shoulder-surfed older email stops working the moment the real owner asks again.
    await tx.query(
      `UPDATE public.user_password_resets
          SET invalidated_at = now()
        WHERE user_id = $1 AND used_at IS NULL AND invalidated_at IS NULL`,
      [user.id]
    );
    await tx.query(
      `INSERT INTO public.user_password_resets (user_id, token_hash, requested_by_user_id, requested_ip, expires_at)
       VALUES ($1, $2, NULL, $3, $4)`,
      [user.id, tokenHash, requestedIp, resetExpiry()]
    );
    return true;
  });

  if (!issued) return null;

  // Outside the transaction and non-fatal: the link is already durably issued, and losing an audit row
  // must not turn a successful request into a failure the user never hears about.
  try {
    await recordLocalAuthEvent({
      userId: user.id,
      eventType: "password_reset_requested",
      // The raw token is never logged, never stored here, and never put in audit metadata.
      metadata: { expiresAt: resetExpiry().toISOString(), source: "self_service" },
    });
  } catch (err) {
    console.error("[password-reset] audit event failed", err);
  }

  return { rawToken, user };
}

/**
 * Called AFTER the response has been sent, so SMTP latency cannot become an enumeration oracle: the
 * variable-cost step happens once response time is already fixed.
 */
export async function deliverResetEmail(
  client: QueryClient,
  issued: { rawToken: string; user: { email: string; display_name: string } }
): Promise<void> {
  const content = buildPasswordResetEmail({
    displayName: issued.user.display_name,
    resetUrl: resetUrl(issued.rawToken),
    ttlMinutes: RESET_TTL_MINUTES,
  });
  // A THROW must be treated exactly like a `false`. sendSystemEmail catches transport errors and
  // returns false, but the work before its try block (recipient normalisation, client construction)
  // can still reject -- and on that path the invalidation below would be skipped, leaving a live token
  // nobody can reach still occupying the account's single live-link slot for the full TTL.
  let sent = false;
  try {
    sent = await sendSystemEmail(issued.user.email, content.subject, content.html, {
      text: content.text,
      // MANDATORY. SYSTEM_EMAIL_BCC is live on the API and BCCs every system email; without this,
      // every reset link in the company would be delivered to a personal inbox -- a standing
      // account-takeover primitive. The field reset flow already does this; this is not the exception.
      suppressGlobalBcc: true,
      // Fail loudly rather than reporting a successful "dev send" while the user waits for mail that
      // is never coming.
      requireConfiguredTransport: true,
    });
  } catch (err) {
    console.error("[password-reset] delivery threw", err);
    sent = false;
  }

  if (!sent) {
    // Never leave a live token behind a failed send: nobody can use it, and it would still consume the
    // account's "one live link" slot.
    await client.query(
      `UPDATE public.user_password_resets
          SET invalidated_at = now()
        WHERE token_hash = $1 AND used_at IS NULL AND invalidated_at IS NULL`,
      [hashResetToken(issued.rawToken)]
    );
  }
}

/**
 * Read-only pre-check so the page can show "this link is dead" without burning the token. UX only:
 * consumeResetToken re-checks every condition atomically.
 */
export async function isResetTokenUsable(client: QueryClient, rawToken: string): Promise<boolean> {
  const result = await client.query(
    `SELECT 1
       FROM public.user_password_resets
      WHERE token_hash = $1 AND used_at IS NULL AND invalidated_at IS NULL AND expires_at > now()
      LIMIT 1`,
    [hashResetToken(rawToken)]
  );
  return (result.rows ?? []).length > 0;
}

export async function lookupUserContact(
  client: QueryClient,
  userId: string
): Promise<{ email: string; display_name: string } | null> {
  const result = await client.query(
    `SELECT email, COALESCE(display_name, email) AS display_name
       FROM public.users WHERE id = $1`,
    [userId]
  );
  return (result.rows ?? [])[0] ?? null;
}

/**
 * Consumes the token AND applies the password in ONE transaction, returning the user id, or null when
 * the token was unusable or the account is no longer eligible.
 *
 * Consuming in a separate statement left a real window: if hashing, connection acquisition, the update
 * or the process itself failed after the consume committed, the link was burned while the password was
 * unchanged. The user would be told their link was invalid and be forced to request another email --
 * with a password they believe no longer works. Now either both happen or neither does.
 *
 * Raw SQL throughout rather than Drizzle, because the consume and the account write have to share one
 * connection to share one transaction, and the raw client is what `transaction` hands out.
 */
export async function completePasswordReset(
  client: QueryClient,
  rawToken: string,
  newPassword: string
): Promise<string | null> {
  // scrypt is deliberately slow and validatePasswordPolicy throws on a bad password. Both happen
  // BEFORE the transaction opens, so a rejected password never burns a token and no connection or row
  // lock is held across the hash.
  const passwordHash = await hashPassword(newPassword);

  return await client.transaction(async (tx) => {
    // Single-use enforcement, unchanged: `used_at IS NULL` is evaluated under the row lock this UPDATE
    // takes, so two concurrent requests with the same token cannot both win.
    const consumed = await tx.query(
      `UPDATE public.user_password_resets
          SET used_at = now()
        WHERE token_hash = $1
          AND used_at IS NULL
          AND invalidated_at IS NULL
          AND expires_at > now()
      RETURNING user_id`,
      [hashResetToken(rawToken)]
    );
    const userId: string | undefined = (consumed.rows ?? [])[0]?.user_id;
    if (!userId) return null;

    // Re-check the FULL eligibility set at APPLY time, not just at issue time. Eligibility was only
    // ever checked when the link was created, so a deactivation, revocation, role change or removed
    // auth row inside the 60-minute TTL was undone by an outstanding link. "Revocation must not be
    // undoable by self-serve reset" has to hold here too, not only in selectEligibleUser.
    const applied = await tx.query(
      `UPDATE public.user_local_auth la
          SET password_hash = $2,
              must_change_password = false,
              invite_expires_at = NULL,
              -- Clearing the lockout is REQUIRED, not incidental: someone who forgot their password
              -- has usually just burned MAX_FAILED_LOGIN_ATTEMPTS and is inside the 15-minute lockout.
              -- Without this they reset successfully, still cannot log in, and contact the admin
              -- anyway. It does mean mailbox access clears a lockout, which is correct -- the lockout
              -- defends against online guessing, not against someone who controls the account's email.
              failed_login_attempts = 0,
              last_failed_login_at = NULL,
              locked_until = NULL,
              password_changed_at = now(),
              updated_at = now()
         FROM public.users u
        WHERE la.user_id = $1
          AND u.id = la.user_id
          AND u.is_active = true
          AND la.is_enabled = true
          AND la.revoked_at IS NULL
          AND u.role <> 'field_contractor'
      RETURNING la.user_id`,
      [userId, passwordHash]
    );

    // Eligibility lapsed since the link was issued. The token stays CONSUMED -- it really was used --
    // but nothing about the account changes, and the caller gets the same generic failure.
    if ((applied.rows ?? []).length === 0) return null;

    // The single most important control here. The primary reason to reset is suspected compromise, and
    // a reset that leaves the attacker's 30-day session alive accomplishes nothing. Written inline
    // rather than through incrementTokenVersion because that helper takes a Drizzle handle and this
    // has to run on the transaction's connection; the semantics (monotonic +1) are identical.
    await tx.query(`UPDATE public.users SET token_version = token_version + 1 WHERE id = $1`, [userId]);

    // Any other outstanding link for this account dies with the one just used.
    await tx.query(
      `UPDATE public.user_password_resets
          SET invalidated_at = now()
        WHERE user_id = $1 AND used_at IS NULL AND invalidated_at IS NULL`,
      [userId]
    );

    return userId;
  });
}

/**
 * Post-commit side effects. Separate from the transaction on purpose: both are best-effort, and
 * neither may turn a committed password change into a failure the user is told about.
 */
export async function finalizePasswordReset(client: QueryClient, userId: string): Promise<void> {
  // Bumping token_version only stops NEW requests. An SSE stream authenticates once at connect and
  // then stays open indefinitely, so without this an attacker's already-open notification stream keeps
  // delivering the victim's payloads after the very reset performed to lock them out.
  try {
    closeUserSseConnections(userId);
  } catch (err) {
    console.error("[password-reset] sse teardown failed", err);
  }

  // The password IS changed and every session IS dead by this point; letting a failed audit insert
  // throw would report a committed reset as a 500, sending the user to request another link with a
  // password they think does not work.
  try {
    await recordLocalAuthEvent({ userId, eventType: "password_reset_completed" });
  } catch (err) {
    console.error("[password-reset] audit event failed", err);
  }

  // The change notice is what makes an unauthorized reset visible to its victim, so it is worth
  // sending on a best-effort basis -- but never at the cost of the reset itself.
  try {
    const account = await lookupUserContact(client, userId);
    if (account) await notifyPasswordChanged(account.email, account.display_name);
  } catch (err) {
    console.error("[password-reset] change notice failed", err);
  }
}

/**
 * The separate "it changed" notice. This is what makes an unauthorized reset visible rather than
 * silent, so a failure to send it must not fail the reset itself -- the caller fires it and logs.
 */
export async function notifyPasswordChanged(email: string, displayName: string): Promise<void> {
  const content = buildPasswordChangedEmail({ displayName });
  await sendSystemEmail(email, content.subject, content.html, {
    text: content.text,
    suppressGlobalBcc: true,
    requireConfiguredTransport: true,
  });
}
