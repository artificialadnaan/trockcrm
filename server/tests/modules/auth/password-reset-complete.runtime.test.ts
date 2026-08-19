import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  completePasswordReset,
  isResetTokenUsable,
  type QueryClient,
} from "../../../src/modules/auth/password-reset-service.js";
import { hashResetToken } from "../../../src/modules/auth/reset-tokens.js";

/**
 * Exercises the REAL completion path against real SQL, not a consume-only primitive.
 *
 * Consuming used to be its own statement, so a failure between the consume and the password write
 * burned the link while leaving the password unchanged -- the user was told their link was invalid and
 * had to request another email. Both halves now share one transaction, and the assertions below check
 * the pair rather than either side alone.
 */

let db: PGlite;
let txChain: Promise<unknown> = Promise.resolve();

// PGlite is a single connection, so transactions are serialized through a chain the way a pool
// serializes statements on one checked-out connection.
const client = (): QueryClient => ({
  query: (sql: string, params?: unknown[]) => db.query(sql, params as unknown[]),
  transaction: async (fn) => {
    const run = txChain.then(async () => {
      await db.exec("BEGIN");
      try {
        const result = await fn(client());
        await db.exec("COMMIT");
        return result;
      } catch (err) {
        await db.exec("ROLLBACK");
        throw err;
      }
    });
    txChain = run.catch(() => undefined);
    return run as never;
  },
});

const USER = "11111111-1111-1111-1111-111111111111";
const USER_REVOKED = "11111111-1111-1111-1111-111111111112";
const USER_INACTIVE = "11111111-1111-1111-1111-111111111113";
const USER_FIELD = "11111111-1111-1111-1111-111111111114";

const NEW_PASSWORD = ["correct", "horse", "battery"].join("-");
const OLD_HASH = "scrypt$deadbeef$cafebabe";

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE public.users (
      id uuid PRIMARY KEY,
      email text NOT NULL,
      display_name text,
      role text NOT NULL DEFAULT 'rep',
      is_active boolean NOT NULL DEFAULT true,
      token_version integer NOT NULL DEFAULT 0
    );
    CREATE TABLE public.user_local_auth (
      user_id uuid PRIMARY KEY,
      password_hash text NOT NULL,
      must_change_password boolean NOT NULL DEFAULT true,
      is_enabled boolean NOT NULL DEFAULT true,
      invite_expires_at timestamptz,
      failed_login_attempts integer NOT NULL DEFAULT 0,
      last_failed_login_at timestamptz,
      locked_until timestamptz,
      password_changed_at timestamptz,
      revoked_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE public.user_password_resets (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL,
      token_hash text NOT NULL UNIQUE,
      expires_at timestamptz NOT NULL,
      used_at timestamptz,
      invalidated_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec("DELETE FROM public.user_password_resets;");
  await db.exec("DELETE FROM public.user_local_auth;");
  await db.exec("DELETE FROM public.users;");
  await db.query(
    `INSERT INTO public.users (id, email, display_name, role, is_active, token_version) VALUES
       ($1,'ok@trockgc.com','Ok User','rep',true,4),
       ($2,'revoked@trockgc.com','Revoked','rep',true,0),
       ($3,'inactive@trockgc.com','Inactive','rep',false,0),
       ($4,'crew@trockgc.com','Crew','field_contractor',true,0)`,
    [USER, USER_REVOKED, USER_INACTIVE, USER_FIELD]
  );
  // Locked out and forced to change: the state a real user is in when they reach this flow.
  await db.query(
    `INSERT INTO public.user_local_auth
       (user_id, password_hash, must_change_password, is_enabled, failed_login_attempts, locked_until, revoked_at)
     VALUES
       ($1,$5,true,true,5, now() + interval '10 minutes', NULL),
       ($2,$5,false,true,0,NULL, now()),
       ($3,$5,false,true,0,NULL,NULL),
       ($4,$5,false,true,0,NULL,NULL)`,
    [USER, USER_REVOKED, USER_INACTIVE, USER_FIELD, OLD_HASH]
  );
});

async function seed(
  token: string,
  userId = USER,
  opts: { expiresIn?: string; used?: boolean; invalidated?: boolean } = {}
) {
  await db.query(
    `INSERT INTO public.user_password_resets (user_id, token_hash, expires_at, used_at, invalidated_at)
     VALUES ($1, $2, now() + ($3)::interval, $4, $5)`,
    [
      userId,
      hashResetToken(token),
      opts.expiresIn ?? "1 hour",
      opts.used ? new Date() : null,
      opts.invalidated ? new Date() : null,
    ]
  );
}

async function authRow(userId = USER) {
  const { rows } = await db.query<{
    password_hash: string;
    must_change_password: boolean;
    failed_login_attempts: number;
    locked_until: Date | null;
  }>(`SELECT password_hash, must_change_password, failed_login_attempts, locked_until
        FROM public.user_local_auth WHERE user_id = $1`, [userId]);
  return rows[0];
}

async function tokenVersion(userId = USER) {
  const { rows } = await db.query<{ token_version: number }>(
    `SELECT token_version FROM public.users WHERE id = $1`,
    [userId]
  );
  return rows[0]?.token_version;
}

describe("completePasswordReset", () => {
  it("consumes the token and writes the new password in one go", async () => {
    await seed("good-token");
    expect(await completePasswordReset(client(), "good-token", NEW_PASSWORD)).toBe(USER);

    const row = await authRow();
    expect(row?.password_hash).not.toBe(OLD_HASH);
    expect(row?.password_hash?.startsWith("scrypt$")).toBe(true);
    expect(row?.must_change_password).toBe(false);
  });

  it("bumps token_version, killing every existing session", async () => {
    await seed("good-token");
    await completePasswordReset(client(), "good-token", NEW_PASSWORD);
    // Was 4. Monotonic +1, so every JWT minted at 4 or below is now stale.
    expect(await tokenVersion()).toBe(5);
  });

  it("clears the lockout, so the user can actually log in afterwards", async () => {
    await seed("good-token");
    await completePasswordReset(client(), "good-token", NEW_PASSWORD);

    const row = await authRow();
    // Without this they reset successfully, still cannot log in, and contact the admin anyway.
    expect(row?.failed_login_attempts).toBe(0);
    expect(row?.locked_until).toBeNull();
  });

  it("rejects the SAME token on a second use", async () => {
    await seed("good-token");
    expect(await completePasswordReset(client(), "good-token", NEW_PASSWORD)).toBe(USER);
    expect(await completePasswordReset(client(), "good-token", NEW_PASSWORD)).toBeNull();
  });

  it("lets exactly one of two CONCURRENT completions win", async () => {
    await seed("race-token");
    const results = await Promise.all([
      completePasswordReset(client(), "race-token", NEW_PASSWORD),
      completePasswordReset(client(), "race-token", NEW_PASSWORD),
    ]);
    expect(results.filter((r) => r === USER)).toHaveLength(1);
    expect(results.filter((r) => r === null)).toHaveLength(1);
    // One winner means one bump, not two.
    expect(await tokenVersion()).toBe(5);
  });

  it("rejects an expired token and changes nothing", async () => {
    await seed("old-token", USER, { expiresIn: "-1 minute" });
    expect(await completePasswordReset(client(), "old-token", NEW_PASSWORD)).toBeNull();
    expect((await authRow())?.password_hash).toBe(OLD_HASH);
    expect(await tokenVersion()).toBe(4);
  });

  it("rejects an invalidated token", async () => {
    await seed("dead-token", USER, { invalidated: true });
    expect(await completePasswordReset(client(), "dead-token", NEW_PASSWORD)).toBeNull();
    expect((await authRow())?.password_hash).toBe(OLD_HASH);
  });

  it("rejects an unknown token", async () => {
    expect(await completePasswordReset(client(), "never-existed", NEW_PASSWORD)).toBeNull();
  });

  it("invalidates the account's OTHER live links", async () => {
    await seed("used-one");
    await seed("sibling-link");
    await completePasswordReset(client(), "used-one", NEW_PASSWORD);

    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.user_password_resets
        WHERE user_id = $1 AND used_at IS NULL AND invalidated_at IS NULL`,
      [USER]
    );
    expect(rows[0]?.n).toBe(0);
  });

  it("rejects a password below the policy WITHOUT consuming the token", async () => {
    await seed("typo-token");
    await expect(completePasswordReset(client(), "typo-token", "short")).rejects.toThrow(
      /at least 12 characters/
    );
    // The link must survive a typo, or the user needs a whole new email to try again.
    expect(await isResetTokenUsable(client(), "typo-token")).toBe(true);
  });
});

describe("eligibility is re-checked at APPLY time, not only at issue time", () => {
  // The link was legitimately issued; the account changed inside the 60-minute TTL. "Revocation must
  // not be undoable by self-serve reset" has to hold here too.
  it.each([
    ["revoked", USER_REVOKED],
    ["deactivated", USER_INACTIVE],
    ["a field contractor", USER_FIELD],
  ])("refuses to apply for %s", async (_label, userId) => {
    await seed("stale-token", userId);
    expect(await completePasswordReset(client(), "stale-token", NEW_PASSWORD)).toBeNull();

    const row = await authRow(userId);
    expect(row?.password_hash).toBe(OLD_HASH);
    expect(await tokenVersion(userId)).toBe(0);
  });

  it("still burns the token, because it really was used", async () => {
    await seed("stale-token", USER_REVOKED);
    await completePasswordReset(client(), "stale-token", NEW_PASSWORD);
    expect(await isResetTokenUsable(client(), "stale-token")).toBe(false);
  });
});

describe("isResetTokenUsable", () => {
  it("reports a live token as usable without consuming it", async () => {
    await seed("peek-token");
    expect(await isResetTokenUsable(client(), "peek-token")).toBe(true);
    expect(await isResetTokenUsable(client(), "peek-token")).toBe(true);
    expect(await completePasswordReset(client(), "peek-token", NEW_PASSWORD)).toBe(USER);
  });

  it("reports expired, used, invalidated and unknown tokens identically", async () => {
    await seed("expired-token", USER, { expiresIn: "-1 minute" });
    await seed("used-token", USER, { used: true });
    await seed("void-token", USER, { invalidated: true });
    expect(await isResetTokenUsable(client(), "expired-token")).toBe(false);
    expect(await isResetTokenUsable(client(), "used-token")).toBe(false);
    expect(await isResetTokenUsable(client(), "void-token")).toBe(false);
    expect(await isResetTokenUsable(client(), "unknown-token")).toBe(false);
  });
});
