import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrationSql } from "../../helpers/migration-sql.js";

/**
 * Executes migration 0226 as it ships, rather than retyping its DDL into the test. A hand copy would let
 * this suite keep passing against constraints the migration no longer creates.
 *
 * The constraints asserted here are load-bearing for the reset flow, not decoration:
 *   - token_hash UNIQUE is what makes "consume exactly once" a single indexed UPDATE.
 *   - ON DELETE CASCADE stops a deleted user's live links from outliving the account.
 *   - the unfiltered (user_id, created_at) index is what the per-account rate limit counts on.
 */

let db: PGlite;

const USER = "11111111-1111-1111-1111-111111111111";

beforeAll(async () => {
  db = new PGlite();
  // Minimal users table -- 0226 only needs the FK target to exist.
  await db.exec(`
    CREATE TABLE public.users (
      id uuid PRIMARY KEY,
      email text NOT NULL
    );
    INSERT INTO public.users (id, email) VALUES ('${USER}', 'ok@trockgc.com');
  `);
  await db.exec(migrationSql("0226_user_password_resets"));
});

afterAll(async () => {
  await db.close();
});

describe("migration 0226 user_password_resets", () => {
  it("creates the table with the columns the service writes", async () => {
    const { rows } = await db.query<{ column_name: string; data_type: string; is_nullable: string }>(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'user_password_resets'`
    );
    const byName = new Map(rows.map((r) => [r.column_name, r]));

    // Assert PRESENCE of every column the service depends on, so a dropped column fails here.
    for (const column of [
      "id",
      "user_id",
      "token_hash",
      "requested_by_user_id",
      "requested_ip",
      "expires_at",
      "used_at",
      "invalidated_at",
      "created_at",
    ]) {
      expect(byName.has(column), `missing column ${column}`).toBe(true);
    }

    expect(byName.get("user_id")?.is_nullable).toBe("NO");
    expect(byName.get("token_hash")?.is_nullable).toBe("NO");
    expect(byName.get("expires_at")?.is_nullable).toBe("NO");
    // Self-service resets have no actor, so this MUST stay nullable.
    expect(byName.get("requested_by_user_id")?.is_nullable).toBe("YES");
    // Timestamps must be timestamptz -- the TTL and rate-limit windows are interval comparisons.
    expect(byName.get("expires_at")?.data_type).toBe("timestamp with time zone");
    expect(byName.get("created_at")?.data_type).toBe("timestamp with time zone");
  });

  it("rejects a duplicate token_hash", async () => {
    await db.query(
      `INSERT INTO public.user_password_resets (user_id, token_hash, expires_at)
       VALUES ($1, 'dupe-hash', now() + interval '1 hour')`,
      [USER]
    );

    await expect(
      db.query(
        `INSERT INTO public.user_password_resets (user_id, token_hash, expires_at)
         VALUES ($1, 'dupe-hash', now() + interval '1 hour')`,
        [USER]
      )
    ).rejects.toThrow();
  });

  it("defaults id and created_at so the service can omit them", async () => {
    const { rows } = await db.query<{ id: string; created_at: Date }>(
      `INSERT INTO public.user_password_resets (user_id, token_hash, expires_at)
       VALUES ($1, 'defaulted-hash', now() + interval '1 hour')
       RETURNING id, created_at`,
      [USER]
    );
    expect(rows[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(rows[0]?.created_at).toBeTruthy();
  });

  it("cascades the delete so a removed user leaves no live links behind", async () => {
    const doomed = "22222222-2222-2222-2222-222222222222";
    await db.query(`INSERT INTO public.users (id, email) VALUES ($1, 'doomed@trockgc.com')`, [doomed]);
    await db.query(
      `INSERT INTO public.user_password_resets (user_id, token_hash, expires_at)
       VALUES ($1, 'doomed-hash', now() + interval '1 hour')`,
      [doomed]
    );

    await db.query(`DELETE FROM public.users WHERE id = $1`, [doomed]);

    const { rows } = await db.query(
      `SELECT 1 FROM public.user_password_resets WHERE token_hash = 'doomed-hash'`
    );
    expect(rows).toHaveLength(0);
  });

  it("creates both indexes, including the unfiltered one the rate limit needs", async () => {
    const { rows } = await db.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'user_password_resets'`
    );
    const byName = new Map(rows.map((r) => [r.indexname, r.indexdef]));

    expect(byName.has("user_password_resets_active_user_idx")).toBe(true);
    expect(byName.get("user_password_resets_active_user_idx")).toMatch(/WHERE/i);

    // A used or invalidated row still counts against the per-account limit, so this one must NOT be
    // partial -- otherwise burning a link would refill the quota.
    expect(byName.has("user_password_resets_user_created_idx")).toBe(true);
    expect(byName.get("user_password_resets_user_created_idx")).not.toMatch(/WHERE/i);
  });

  it("is idempotent -- re-running the migration is a no-op", async () => {
    await expect(db.exec(migrationSql("0226_user_password_resets"))).resolves.toBeDefined();
  });
});
