import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  resolve(import.meta.dirname, "../../../../migrations/0150_deal_estimator_user_id.sql"),
  "utf8"
);

describe("migration 0150: deals.estimator_user_id", () => {
  it("adds estimator_user_id as a nullable uuid FK to public.users with ON DELETE SET NULL", () => {
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS estimator_user_id uuid");
    expect(sql).toContain("REFERENCES public.users(id) ON DELETE SET NULL");
  });

  it("indexes estimator_user_id (partial, non-null) for the rep/estimator filter", () => {
    expect(sql).toContain("deals_estimator_user_id_idx");
    expect(sql).toContain("(estimator_user_id) WHERE estimator_user_id IS NOT NULL");
  });

  it("applies per-tenant via office_ schema discovery (mirrors 0128)", () => {
    expect(sql).toContain("nspname LIKE 'office\\_%' ESCAPE '\\'");
    expect(sql).toContain("%1$I.deals");
  });
});
