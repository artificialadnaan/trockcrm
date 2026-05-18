import { beforeEach, describe, expect, it, vi } from "vitest";

const connectMock = vi.fn();
const queryMock = vi.fn();
const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

vi.mock("../src/db.js", () => ({
  pool: {
    connect: connectMock,
    query: queryMock,
  },
}));

const { deadJob, pollJobs, registerJobHandler } = await import("../src/queue.js");

describe("worker queue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("marks non-retryable job results dead without requeueing", async () => {
    const jobType = "unit_test_non_retryable_job";
    registerJobHandler(jobType, async () => deadJob("missing requestedBy"));

    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] };
        if (sql.includes("SELECT * FROM public.job_queue")) {
          return {
            rows: [
              {
                id: 41,
                job_type: jobType,
                office_id: "office-1",
                payload: { dealId: "deal-1" },
                attempts: 0,
                max_attempts: 5,
              },
            ],
          };
        }
        if (sql.includes("UPDATE public.job_queue SET status = 'processing'")) {
          expect(params).toEqual([41]);
          return { rows: [] };
        }
        throw new Error(`Unexpected client SQL: ${sql}`);
      }),
      release: vi.fn(),
    };
    connectMock.mockResolvedValue(client);
    queryMock.mockResolvedValue({ rows: [] });

    await pollJobs();

    expect(queryMock).toHaveBeenCalledWith(
      "UPDATE public.job_queue SET status = 'dead', last_error = $1 WHERE id = $2",
      ["missing requestedBy", 41]
    );
    expect(queryMock).not.toHaveBeenCalledWith(
      expect.stringContaining("run_after = NOW() + make_interval"),
      expect.anything()
    );
    expect(errorSpy).toHaveBeenCalledWith(
      "[Worker] Job 41 (unit_test_non_retryable_job) rejected without retry: missing requestedBy"
    );
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
