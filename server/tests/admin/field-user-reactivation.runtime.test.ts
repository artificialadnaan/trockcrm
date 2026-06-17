import { describe, it, expect, vi, beforeEach } from "vitest";

// Capture the SQL setFieldUserActive issues without a real DB, so we can gate-prove (in CI) that the
// field reactivation/deactivation path bumps token_version — the field-user parity of the CRM
// reactivation fix. Combined with isTokenVersionStale (version-behind => stale), this proves a
// pre-deactivation 30-day field JWT is invalidated on reactivation.
const captured = vi.hoisted(() => ({ sqls: [] as unknown[] }));

vi.mock("../../src/db.js", () => ({
  db: {
    execute: (s: unknown) => {
      captured.sqls.push(s);
      return { rows: [{ id: "f1", email: "f@x.com", first_name: "F", last_name: "L", phone: null, is_active: true }] };
    },
  },
  pool: { query: () => ({ rows: [] }) },
}));

import { setFieldUserActive } from "../../src/modules/field-users/service.js";

// Render a drizzle sql`` object's static text (param chunks render empty; the literal SET clause stays).
function extractSqlText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  if (Array.isArray((value as { queryChunks?: unknown[] }).queryChunks)) {
    return (value as { queryChunks: unknown[] }).queryChunks.map(extractSqlText).join("");
  }
  if ("value" in (value as Record<string, unknown>)) {
    const chunkValue = (value as { value: unknown }).value;
    if (Array.isArray(chunkValue)) return chunkValue.map(extractSqlText).join("");
    if (typeof chunkValue === "string") return chunkValue;
  }
  return "";
}

describe("setFieldUserActive — field reactivation invalidates pre-deactivation tokens", () => {
  beforeEach(() => {
    captured.sqls.length = 0;
  });

  it("bumps token_version on REACTIVATE (active: true)", async () => {
    await setFieldUserActive({ userId: "f1", tenantId: "t1", active: true });
    const text = captured.sqls.map(extractSqlText).join(" ");
    expect(text).toContain("token_version = token_version + 1");
    expect(text).toContain("is_active");
  });

  it("bumps token_version on DEACTIVATE (active: false) too", async () => {
    await setFieldUserActive({ userId: "f1", tenantId: "t1", active: false });
    const text = captured.sqls.map(extractSqlText).join(" ");
    expect(text).toContain("token_version = token_version + 1");
  });
});
