import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationSql = readFileSync(
  resolve(import.meta.dirname, "../../../../migrations/0187_field_user_password_resets.sql"),
  "utf8",
);

describe("migration 0187: field user password resets", () => {
  it("adds accurate local-auth audit events idempotently", () => {
    expect(migrationSql).toContain("ADD VALUE IF NOT EXISTS 'password_reset_requested'");
    expect(migrationSql).toContain("ADD VALUE IF NOT EXISTS 'password_reset_completed'");
  });

  it("stores only reset-token hashes with expiry and single-use state", () => {
    expect(migrationSql).toContain("CREATE TABLE IF NOT EXISTS public.field_user_password_resets");
    expect(migrationSql).toContain("token_hash text NOT NULL UNIQUE");
    expect(migrationSql).toContain("expires_at timestamptz NOT NULL");
    expect(migrationSql).toContain("used_at timestamptz");
    expect(migrationSql).toContain("invalidated_at timestamptz");
  });

  it("keeps safe user deletion semantics and indexes active reset lookups", () => {
    expect(migrationSql).toContain("REFERENCES public.users(id) ON DELETE CASCADE");
    expect(migrationSql).toContain("REFERENCES public.users(id) ON DELETE SET NULL");
    expect(migrationSql).toContain("field_user_password_resets_active_user_idx");
    expect(migrationSql).toContain("WHERE used_at IS NULL AND invalidated_at IS NULL");
  });
});
