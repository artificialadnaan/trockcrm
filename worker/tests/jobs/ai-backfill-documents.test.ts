import { beforeEach, describe, expect, it, vi } from "vitest";

const connectMock = vi.fn();

vi.mock("../../src/db.js", () => ({
  pool: {
    connect: connectMock,
  },
}));

const { runAiBackfillDocuments } = await import("../../src/jobs/ai-backfill-documents.js");

function createClient(queryImpl: (sql: string, params: unknown[]) => Promise<{ rows: any[] }>) {
  return {
    query: vi.fn(queryImpl),
    release: vi.fn(),
  };
}

describe("ai backfill documents job", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("queues indexing jobs for missing historical sources and requeues itself when the batch is full", async () => {
    const client = createClient(async (sql, params) => {
      if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] };

      if (sql.includes("FROM public.offices")) {
        return { rows: [{ slug: "beta" }] };
      }

      if (sql.includes("FROM office_beta.emails")) {
        expect(params).toEqual([2]);
        return { rows: [{ id: "email-1" }, { id: "email-2" }] };
      }

      if (sql.startsWith("INSERT INTO public.job_queue")) {
        return { rows: [] };
      }

      throw new Error(`Unexpected SQL: ${sql}`);
    });
    connectMock.mockResolvedValue(client);

    await runAiBackfillDocuments(
      {
        officeId: "office-1",
        sourceType: "email_message",
        batchSize: 2,
      },
      null
    );

    const insertCalls = client.query.mock.calls.filter(([sql]) =>
      typeof sql === "string" && sql.startsWith("INSERT INTO public.job_queue")
    );

    expect(insertCalls).toHaveLength(3);
    expect(insertCalls[0][1]?.[0]).toContain("\"sourceType\":\"email_message\"");
    expect(insertCalls[2][1]?.[0]).toContain("\"sourceType\":\"email_message\"");
    expect(insertCalls[2][1]?.[0]).toContain("\"batchSize\":2");
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("scans all supported source types by default", async () => {
    const client = createClient(async (sql) => {
      if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] };

      if (sql.includes("FROM public.offices")) {
        return { rows: [{ slug: "beta" }] };
      }

      if (sql.includes("FROM office_beta.emails")) return { rows: [{ id: "email-1" }] };
      if (sql.includes("FROM office_beta.activities")) return { rows: [{ id: "activity-1" }] };
      if (sql.includes("FROM office_beta.deals d")) return { rows: [{ id: "deal-1" }] };
      if (sql.startsWith("INSERT INTO public.job_queue")) return { rows: [] };

      throw new Error(`Unexpected SQL: ${sql}`);
    });
    connectMock.mockResolvedValue(client);

    await runAiBackfillDocuments({ officeId: "office-1", batchSize: 5 }, null);

    const payloads = client.query.mock.calls
      .filter(([sql]) => typeof sql === "string" && sql.startsWith("INSERT INTO public.job_queue"))
      .map(([, params]) => String(params?.[0] ?? ""));

    expect(payloads.some((payload) => payload.includes("\"sourceType\":\"email_message\""))).toBe(true);
    expect(payloads.some((payload) => payload.includes("\"sourceType\":\"activity_note\""))).toBe(true);
    expect(payloads.some((payload) => payload.includes("\"sourceType\":\"estimate_snapshot\""))).toBe(true);
  });
});
