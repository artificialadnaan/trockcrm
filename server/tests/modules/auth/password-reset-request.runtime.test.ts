import { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  countRecentResets,
  resetUrl,
  selectEligibleUser,
} from "../../../src/modules/auth/password-reset-service.js";

/**
 * Real Postgres types, not string mocks: expires_at/created_at are timestamptz and the rate-limit
 * window is an interval comparison, so a text-typed shortcut would hide a timestamp mismatch.
 */

let db: PGlite;
const client = () => ({
  query: (sql: string, params?: unknown[]) => db.query(sql, params as unknown[]),
});

const USER_OK = "11111111-1111-1111-1111-111111111111";
const USER_REVOKED = "11111111-1111-1111-1111-111111111112";
const USER_NEVER_INVITED = "11111111-1111-1111-1111-111111111113";
const USER_INACTIVE = "11111111-1111-1111-1111-111111111114";
const USER_DISABLED = "11111111-1111-1111-1111-111111111115";

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE public.users (
      id uuid PRIMARY KEY,
      email text NOT NULL,
      display_name text,
      is_active boolean NOT NULL DEFAULT true
    );
    CREATE TABLE public.user_local_auth (
      user_id uuid PRIMARY KEY,
      is_enabled boolean NOT NULL DEFAULT true,
      revoked_at timestamptz
    );
    CREATE TABLE public.user_password_resets (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL,
      token_hash text NOT NULL UNIQUE,
      requested_by_user_id uuid,
      requested_ip text,
      expires_at timestamptz NOT NULL,
      used_at timestamptz,
      invalidated_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO public.users (id, email, display_name, is_active) VALUES
      ('${USER_OK}', 'ok@trockgc.com', 'Ok User', true),
      ('${USER_REVOKED}', 'revoked@trockgc.com', 'Revoked User', true),
      ('${USER_NEVER_INVITED}', 'never@trockgc.com', 'Never Invited', true),
      ('${USER_INACTIVE}', 'inactive@trockgc.com', 'Inactive User', false),
      ('${USER_DISABLED}', 'disabled@trockgc.com', 'Disabled User', true);
    INSERT INTO public.user_local_auth (user_id, is_enabled, revoked_at) VALUES
      ('${USER_OK}', true, NULL),
      ('${USER_REVOKED}', true, now()),
      ('${USER_INACTIVE}', true, NULL),
      ('${USER_DISABLED}', false, NULL);
  `);
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec("DELETE FROM public.user_password_resets;");
});

describe("password reset eligibility", () => {
  it("accepts an active, invited, non-revoked user", async () => {
    expect(await selectEligibleUser(client(), "ok@trockgc.com")).toMatchObject({ id: USER_OK });
  });

  it("rejects a revoked user, because revocation must not be undoable by self-serve reset", async () => {
    expect(await selectEligibleUser(client(), "revoked@trockgc.com")).toBeNull();
  });

  it("rejects a user who was never invited", async () => {
    expect(await selectEligibleUser(client(), "never@trockgc.com")).toBeNull();
  });

  it("rejects an inactive user", async () => {
    expect(await selectEligibleUser(client(), "inactive@trockgc.com")).toBeNull();
  });

  it("rejects a user whose local auth is disabled", async () => {
    expect(await selectEligibleUser(client(), "disabled@trockgc.com")).toBeNull();
  });

  it("rejects an unknown address", async () => {
    expect(await selectEligibleUser(client(), "nobody@trockgc.com")).toBeNull();
  });

  it("matches email case-insensitively", async () => {
    expect(await selectEligibleUser(client(), "OK@TrockGC.com")).toMatchObject({ id: USER_OK });
  });

  it("falls back to the email when display_name is null", async () => {
    await db.query(`UPDATE public.users SET display_name = NULL WHERE id = $1`, [USER_OK]);
    const user = await selectEligibleUser(client(), "ok@trockgc.com");
    expect(user?.display_name).toBe("ok@trockgc.com");
    await db.query(`UPDATE public.users SET display_name = 'Ok User' WHERE id = $1`, [USER_OK]);
  });
});

describe("per-account rate limit", () => {
  it("counts only rows inside the window", async () => {
    await db.query(
      `INSERT INTO public.user_password_resets (user_id, token_hash, expires_at, created_at)
       VALUES ($1,'h1',now()+interval '1 hour', now()),
              ($1,'h2',now()+interval '1 hour', now() - interval '5 minutes'),
              ($1,'h3',now()+interval '1 hour', now() - interval '40 minutes')`,
      [USER_OK]
    );
    expect(await countRecentResets(client(), USER_OK, 15)).toBe(2);
  });

  it("counts USED and INVALIDATED rows too, so burning a link cannot refill the quota", async () => {
    await db.query(
      `INSERT INTO public.user_password_resets (user_id, token_hash, expires_at, created_at, used_at, invalidated_at)
       VALUES ($1,'used',now()+interval '1 hour', now(), now(), NULL),
              ($1,'dead',now()+interval '1 hour', now(), NULL, now())`,
      [USER_OK]
    );
    expect(await countRecentResets(client(), USER_OK, 15)).toBe(2);
  });

  it("does not count another user's rows", async () => {
    await db.query(
      `INSERT INTO public.user_password_resets (user_id, token_hash, expires_at)
       VALUES ($1,'other',now()+interval '1 hour')`,
      [USER_REVOKED]
    );
    expect(await countRecentResets(client(), USER_OK, 15)).toBe(0);
  });
});

describe("reset URL", () => {
  const previous = process.env.PASSWORD_RESET_BASE_URL;
  afterEach(() => {
    if (previous === undefined) delete process.env.PASSWORD_RESET_BASE_URL;
    else process.env.PASSWORD_RESET_BASE_URL = previous;
  });

  it("puts the token in the FRAGMENT so it never reaches the server", () => {
    process.env.PASSWORD_RESET_BASE_URL = "https://trockcrm.com";
    const url = resetUrl("abc-123");
    expect(url).toBe("https://trockcrm.com/reset-password#token=abc-123");
    // Everything before the '#' is what a proxy, access log or Referer header can see.
    expect(url.split("#")[0]).not.toContain("abc-123");
  });

  it("defaults to the sign-in origin rather than throwing when the env var is unset", () => {
    delete process.env.PASSWORD_RESET_BASE_URL;
    // Throwing here would be silent death: the route answers 200 before sending mail, so an unset var
    // would mean "check your email" and no email, forever, with only a log line to show for it.
    expect(resetUrl("tok")).toBe("https://trockcrm.com/reset-password#token=tok");
  });

  it("ignores a blank or whitespace-only override", () => {
    process.env.PASSWORD_RESET_BASE_URL = "   ";
    expect(resetUrl("tok")).toBe("https://trockcrm.com/reset-password#token=tok");
  });

  it("ignores a non-absolute override, which would build a broken link in an email client", () => {
    process.env.PASSWORD_RESET_BASE_URL = "/app";
    expect(resetUrl("tok")).toBe("https://trockcrm.com/reset-password#token=tok");
  });

  it("strips trailing slashes so the path never doubles up", () => {
    process.env.PASSWORD_RESET_BASE_URL = "https://trockcrm.com///";
    expect(resetUrl("tok")).toBe("https://trockcrm.com/reset-password#token=tok");
  });

  it("percent-encodes a token containing URL-significant characters", () => {
    process.env.PASSWORD_RESET_BASE_URL = "https://trockcrm.com";
    expect(resetUrl("a#b&c")).toBe("https://trockcrm.com/reset-password#token=a%23b%26c");
  });
});
