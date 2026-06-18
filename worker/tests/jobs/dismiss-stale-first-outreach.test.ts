import { afterEach, describe, expect, it, vi } from "vitest";

// One office's cleanup throws; the script must keep going AND report the failure (so the entry-point exits
// non-zero) rather than silently succeeding.
const queryMock = vi.fn();
vi.mock("../../src/db.js", () => ({
  pool: { connect: async () => ({ query: queryMock, release: vi.fn() }), end: vi.fn() },
}));

const { runDismissStaleFirstOutreach } = await import("../../src/scripts/dismiss-stale-first-outreach.js");

afterEach(() => queryMock.mockReset());

describe("runDismissStaleFirstOutreach", () => {
  it("processes every office and records per-office failures (non-zero exit signal)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM public.offices")) {
        return { rows: [{ id: "g", slug: "good" }, { id: "b", slug: "bad" }] };
      }
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
      if (sql.includes("office_bad")) throw new Error("boom"); // the dismiss UPDATE for the bad office
      if (sql.includes("office_good")) return { rows: [], rowCount: 0 }; // good office: nothing to dismiss
      return { rows: [] };
    });

    const result = await runDismissStaleFirstOutreach(false); // dry run

    expect(result.failures).toBe(1); // the bad office is counted, not swallowed
    expect(result.total).toBe(0); // good office had nothing to dismiss
    // The good office still ran (the bad one didn't abort the loop).
    expect(queryMock.mock.calls.some(([sql]) => typeof sql === "string" && sql.includes("office_good"))).toBe(true);
    errorSpy.mockRestore();
  });

  it("reports zero failures when all offices succeed", async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM public.offices")) return { rows: [{ id: "g", slug: "good" }] };
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
      return { rows: [], rowCount: 0 };
    });
    const result = await runDismissStaleFirstOutreach(false);
    expect(result.failures).toBe(0);
  });
});
