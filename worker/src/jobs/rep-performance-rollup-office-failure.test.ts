import { afterEach, describe, expect, it, vi } from "vitest";

const connectMock = vi.hoisted(() => vi.fn());

vi.mock("../db.js", () => ({
  pool: {
    connect: connectMock,
  },
}));

import { runRepPerformanceRollup } from "./rep-performance-rollup.js";

describe("rep performance rollup office failure isolation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs one office failure and continues refreshing later offices", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const insertSchemas: string[] = [];
    const transactionCommands: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) {
          transactionCommands.push(sql);
        }

        if (sql.includes("SELECT id, slug, name FROM public.offices")) {
          return {
            rows: [
              { id: "office-a", slug: "a", name: "Office A" },
              { id: "office-b", slug: "b", name: "Office B" },
              { id: "office-c", slug: "c", name: "Office C" },
            ],
            rowCount: 3,
          };
        }

        if (sql.includes("INSERT INTO public.rep_performance_snapshots")) {
          if (sql.includes("office_b.deals")) {
            throw new Error("office b failed");
          }
          if (sql.includes("office_a.deals")) insertSchemas.push("office_a");
          if (sql.includes("office_c.deals")) insertSchemas.push("office_c");
          return { rows: [], rowCount: 1 };
        }

        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    connectMock.mockResolvedValue(client);

    await expect(runRepPerformanceRollup(new Date("2026-05-07T12:00:00.000Z"))).resolves.toBe(14);

    expect(insertSchemas).toContain("office_a");
    expect(insertSchemas).toContain("office_c");
    expect(insertSchemas).not.toContain("office_b");
    expect(transactionCommands.filter((command) => command === "COMMIT")).toHaveLength(2);
    expect(transactionCommands.filter((command) => command === "ROLLBACK")).toHaveLength(1);
    expect(errorSpy).toHaveBeenCalledWith(
      "[Worker:rep-performance-rollup] Office office-b failed:",
      expect.any(Error)
    );
  });

  it("does not count rows from an office transaction that rolls back after a later period fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let insertAttempts = 0;
    const transactionCommands: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) {
          transactionCommands.push(sql);
        }

        if (sql.includes("SELECT id, slug, name FROM public.offices")) {
          return {
            rows: [{ id: "office-a", slug: "a", name: "Office A" }],
            rowCount: 1,
          };
        }

        if (sql.includes("INSERT INTO public.rep_performance_snapshots")) {
          insertAttempts += 1;
          if (insertAttempts === 2) {
            throw new Error("second period failed");
          }
          return { rows: [], rowCount: 1 };
        }

        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    connectMock.mockResolvedValue(client);

    await expect(runRepPerformanceRollup(new Date("2026-05-07T12:00:00.000Z"))).resolves.toBe(0);

    expect(insertAttempts).toBe(2);
    expect(transactionCommands).toEqual(["BEGIN", "ROLLBACK"]);
  });
});
