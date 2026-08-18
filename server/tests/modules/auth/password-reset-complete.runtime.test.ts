import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  consumeResetToken,
  isResetTokenUsable,
} from "../../../src/modules/auth/password-reset-service.js";
import { hashResetToken } from "../../../src/modules/auth/reset-tokens.js";

let db: PGlite;
const client = () => ({
  query: (sql: string, params?: unknown[]) => db.query(sql, params as unknown[]),
});
const USER = "11111111-1111-1111-1111-111111111111";

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
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
});

async function seed(
  token: string,
  opts: { expiresIn?: string; used?: boolean; invalidated?: boolean } = {}
) {
  await db.query(
    `INSERT INTO public.user_password_resets (user_id, token_hash, expires_at, used_at, invalidated_at)
     VALUES ($1, $2, now() + ($3)::interval, $4, $5)`,
    [
      USER,
      hashResetToken(token),
      opts.expiresIn ?? "1 hour",
      opts.used ? new Date() : null,
      opts.invalidated ? new Date() : null,
    ]
  );
}

describe("consumeResetToken", () => {
  it("consumes a valid token once and returns the user id", async () => {
    await seed("good-token");
    expect(await consumeResetToken(client(), "good-token")).toBe(USER);
  });

  it("rejects the SAME token on a second use", async () => {
    await seed("good-token");
    expect(await consumeResetToken(client(), "good-token")).toBe(USER);
    expect(await consumeResetToken(client(), "good-token")).toBeNull();
  });

  it("lets exactly one of two CONCURRENT consumptions win", async () => {
    await seed("race-token");
    // The TOCTOU case. A SELECT-then-UPDATE would let both of these succeed even inside a transaction
    // at READ COMMITTED; one atomic UPDATE evaluates `used_at IS NULL` under its own row lock.
    const results = await Promise.all([
      consumeResetToken(client(), "race-token"),
      consumeResetToken(client(), "race-token"),
    ]);
    expect(results.filter((r) => r === USER)).toHaveLength(1);
    expect(results.filter((r) => r === null)).toHaveLength(1);
  });

  it("rejects an expired token", async () => {
    await seed("old-token", { expiresIn: "-1 minute" });
    expect(await consumeResetToken(client(), "old-token")).toBeNull();
  });

  it("rejects an invalidated token", async () => {
    await seed("dead-token", { invalidated: true });
    expect(await consumeResetToken(client(), "dead-token")).toBeNull();
  });

  it("rejects an unknown token", async () => {
    expect(await consumeResetToken(client(), "never-existed")).toBeNull();
  });

  it("stamps used_at rather than deleting, so the row still counts against the rate limit", async () => {
    await seed("audited-token");
    await consumeResetToken(client(), "audited-token");
    const { rows } = await db.query<{ used_at: Date | null }>(
      `SELECT used_at FROM public.user_password_resets WHERE token_hash = $1`,
      [hashResetToken("audited-token")]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.used_at).toBeTruthy();
  });

  it("never matches on the RAW token, only its hash", async () => {
    await seed("raw-token");
    const { rows } = await db.query(
      `SELECT 1 FROM public.user_password_resets WHERE token_hash = $1`,
      ["raw-token"]
    );
    // Storing the raw value would make a database leak immediately usable.
    expect(rows).toHaveLength(0);
  });
});

describe("isResetTokenUsable", () => {
  it("reports a live token as usable", async () => {
    await seed("live-token");
    expect(await isResetTokenUsable(client(), "live-token")).toBe(true);
  });

  it("does NOT consume the token it checks", async () => {
    await seed("peek-token");
    expect(await isResetTokenUsable(client(), "peek-token")).toBe(true);
    expect(await isResetTokenUsable(client(), "peek-token")).toBe(true);
    expect(await consumeResetToken(client(), "peek-token")).toBe(USER);
  });

  it("reports expired, used, invalidated and unknown tokens identically", async () => {
    await seed("expired-token", { expiresIn: "-1 minute" });
    await seed("used-token", { used: true });
    await seed("void-token", { invalidated: true });
    expect(await isResetTokenUsable(client(), "expired-token")).toBe(false);
    expect(await isResetTokenUsable(client(), "used-token")).toBe(false);
    expect(await isResetTokenUsable(client(), "void-token")).toBe(false);
    expect(await isResetTokenUsable(client(), "unknown-token")).toBe(false);
  });
});
