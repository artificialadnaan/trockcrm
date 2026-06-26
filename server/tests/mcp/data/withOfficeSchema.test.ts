import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => {
  const query = vi.fn().mockResolvedValue({ rows: [] });
  const release = vi.fn();
  const client = { query, release };
  return {
    query,
    release,
    client,
    connect: vi.fn().mockResolvedValue(client),
    drizzle: vi.fn(() => ({ __tenantDb: true })),
  };
});

vi.mock("../../../src/db.js", () => ({ pool: { connect: mocks.connect }, db: {} }));
vi.mock("drizzle-orm/node-postgres", () => ({ drizzle: mocks.drizzle }));

const { withOfficeSchema } = await import("../../../src/mcp/data/withOfficeSchema.js");

describe("withOfficeSchema", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.query.mockResolvedValue({ rows: [] });
    mocks.connect.mockResolvedValue(mocks.client);
    mocks.drizzle.mockReturnValue({ __tenantDb: true });
  });

  it("rejects an office outside the allowlist without ever opening a connection", async () => {
    await expect(withOfficeSchema("office_evil" as never, async () => 1)).rejects.toThrow();
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("selects the schema via a PARAMETERIZED set_config (never interpolated)", async () => {
    await withOfficeSchema("office_dallas", async () => "ok");
    const setConfigCall = mocks.query.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("set_config('search_path'")
    );
    expect(setConfigCall).toBeDefined();
    expect(setConfigCall?.[0]).toContain("$1"); // parameter placeholder, not the value
    expect(setConfigCall?.[1]).toEqual(["office_dallas,public"]);
  });

  it("runs read-only: BEGIN + transaction_read_only + COMMIT, and returns fn's result", async () => {
    const result = await withOfficeSchema("office_dallas", async (db) => {
      expect(db).toEqual({ __tenantDb: true });
      return 42;
    });
    expect(result).toBe(42);
    const sql = mocks.query.mock.calls.map((c) => String(c[0]));
    expect(sql).toContain("BEGIN");
    expect(sql.some((s) => s.includes("transaction_read_only = on"))).toBe(true);
    expect(sql).toContain("COMMIT");
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("rolls back and releases when the callback throws", async () => {
    await expect(
      withOfficeSchema("office_dallas", async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    const sql = mocks.query.mock.calls.map((c) => String(c[0]));
    expect(sql).toContain("ROLLBACK");
    expect(sql).not.toContain("COMMIT");
    expect(mocks.release).toHaveBeenCalledOnce();
  });
});
