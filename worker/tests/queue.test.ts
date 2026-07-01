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

const { deadJob, pollJobs, registerJobHandler, recoverStaleJobs, __resetQueueStateForTest } = await import("../src/queue.js");

describe("worker queue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetQueueStateForTest(); // clear the cross-tick pendingRecoveries singleton between cases
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
      "UPDATE public.job_queue SET status = 'dead', last_error = $1 WHERE id = $2 AND status = 'processing' AND attempts = $3",
      ["missing requestedBy", 41, 1] // [error, id, claimedAttempt] — job.attempts 0 → attempt 1
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

  it("releases the poll connection BEFORE running job handlers (so nested pool.connect can't deadlock)", async () => {
    const jobType = "unit_test_release_before_handler";
    let releaseCountAtHandlerTime = -1;
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] };
        if (sql.includes("SELECT * FROM public.job_queue")) {
          return { rows: [{ id: 77, job_type: jobType, office_id: "office-1", payload: {}, attempts: 0, max_attempts: 5 }] };
        }
        if (sql.includes("UPDATE public.job_queue SET status = 'processing'")) return { rows: [] };
        throw new Error(`Unexpected client SQL: ${sql}`);
      }),
      release: vi.fn(),
    };
    registerJobHandler(jobType, async () => {
      // The claim connection must already be back in the pool before handlers (which open their own
      // nested pool.connect) run — otherwise a batch can exhaust the pool and wedge pollJobs forever.
      releaseCountAtHandlerTime = client.release.mock.calls.length;
    });
    connectMock.mockResolvedValue(client);
    queryMock.mockResolvedValue({ rows: [] });

    await pollJobs();

    expect(releaseCountAtHandlerTime).toBe(1);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("swallows a pool-acquire failure as a skipped tick (no throw) and stays pollable", async () => {
    // With connectionTimeoutMillis set, an exhausted pool rejects the acquire. It must NOT escape as an
    // unhandled rejection (setInterval(pollJobs) is bare) and must NOT wedge the `polling` guard.
    connectMock.mockRejectedValueOnce(new Error("timeout exceeded when trying to connect"));
    await expect(pollJobs()).resolves.toBeUndefined();

    // A healthy connection on the next tick proves the guard was released (connect is attempted again).
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] };
        if (sql.includes("SELECT * FROM public.job_queue")) return { rows: [] };
        throw new Error(`Unexpected client SQL: ${sql}`);
      }),
      release: vi.fn(),
    };
    connectMock.mockResolvedValueOnce(client);
    await pollJobs();
    expect(connectMock).toHaveBeenCalledTimes(2);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("claims at most RUN_CONCURRENCY rows per tick (the claim LIMIT is the concurrency bound)", async () => {
    // Concurrency is bounded by the claim itself — we claim only what we immediately run — so a hung
    // handler can't strand extra pre-claimed 'processing' rows. Assert the claim SELECT uses LIMIT 3.
    let claimSql = "";
    let claimParams: unknown[] | undefined;
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes("SELECT * FROM public.job_queue")) {
          claimSql = sql;
          claimParams = params;
          return { rows: [] };
        }
        if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] };
        throw new Error(`Unexpected client SQL: ${sql}`);
      }),
      release: vi.fn(),
    };
    connectMock.mockResolvedValue(client);

    await pollJobs();

    // Parameterized ($1), not interpolated — static query text, LIMIT bound = RUN_CONCURRENCY (3).
    expect(claimSql).toMatch(/LIMIT \$1\b/);
    expect(claimParams).toEqual([3]);
  });

  it("does not reject pollJobs when a job's outcome write fails (self-registers for retry)", async () => {
    // processJob persists its outcome via attemptRecovery, which SWALLOWS a write failure (keeps the intent
    // in pendingRecoveries for a later tick). So even under pool pressure processJob doesn't reject — it
    // can't escape the bare setInterval(pollJobs) as an unhandled rejection or clear `polling` mid-flight.
    const jobType = "unit_test_recording_failure";
    registerJobHandler(jobType, async () => {}); // handler succeeds; the FAILURE is recording the outcome
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] };
        if (sql.includes("SELECT * FROM public.job_queue")) {
          return { rows: [{ id: 88, job_type: jobType, office_id: "office-1", payload: {}, attempts: 0, max_attempts: 5 }] };
        }
        if (sql.includes("UPDATE public.job_queue SET status = 'processing'")) return { rows: [] };
        throw new Error(`Unexpected client SQL: ${sql}`);
      }),
      release: vi.fn(),
    };
    connectMock.mockResolvedValue(client);
    // pool.query (the completion write in processJob) rejects — as an exhausted pool would.
    queryMock.mockRejectedValue(new Error("timeout exceeded when trying to connect"));

    await expect(pollJobs()).resolves.toBeUndefined(); // did NOT reject

    // `polling` was reset, so the next tick still runs.
    await expect(pollJobs()).resolves.toBeUndefined();
    expect(connectMock).toHaveBeenCalledTimes(2);
  });

  it("destroys the claim connection (release(err)) when ROLLBACK fails after a poll error", async () => {
    // A broken connection whose ROLLBACK also fails must NOT be returned to the pool as healthy — the next
    // caller could inherit a connection still mid-transaction. release(err) tells the pool to discard it.
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql === "BEGIN") return { rows: [] };
        if (sql.includes("SELECT * FROM public.job_queue")) throw new Error("claim boom"); // enter catch
        if (sql === "ROLLBACK") throw new Error("rollback boom"); // rollback also fails
        throw new Error(`Unexpected client SQL: ${sql}`);
      }),
      release: vi.fn(),
    };
    connectMock.mockResolvedValue(client);

    await expect(pollJobs()).resolves.toBeUndefined(); // swallowed, no throw

    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release.mock.calls[0][0]).toBeInstanceOf(Error); // destroyed, not returned healthy
  });

  it("recovers a SUCCEEDED job as 'completed' (never re-run as pending) when its outcome write fails", async () => {
    // The intent for a succeeded handler is 'completed'. If that write fails it's kept in pendingRecoveries
    // and replayed as 'completed' — NOT reset to pending (which would re-run an already-successful handler).
    const jobType = "unit_test_succeeded_recovery";
    registerJobHandler(jobType, async () => {}); // handler SUCCEEDS
    let claimRows = [{ id: 99, job_type: jobType, office_id: "office-1", payload: {}, attempts: 0, max_attempts: 5 }];
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] };
        if (sql.includes("SELECT * FROM public.job_queue")) {
          const rows = claimRows;
          claimRows = [];
          return { rows };
        }
        if (sql.includes("UPDATE public.job_queue SET status = 'processing'")) return { rows: [] };
        throw new Error(`Unexpected client SQL: ${sql}`);
      }),
      release: vi.fn(),
    };
    connectMock.mockResolvedValue(client);
    // The 'completed' write fails on its first attempt (tick 1) and succeeds on the flush (tick 2).
    let completedAttempts = 0;
    queryMock.mockImplementation(async (sql: string) => {
      if (String(sql).includes("SET status = 'completed'")) {
        completedAttempts++;
        if (completedAttempts === 1) throw new Error("completed write failed");
      }
      return { rows: [] };
    });

    await pollJobs(); // tick 1: completed write fails → kept in pendingRecoveries
    await pollJobs(); // tick 2: flush replays the completed write

    // Recovered as 'completed' (guarded), and NEVER as pending (would re-run a succeeded job).
    const completedCall = queryMock.mock.calls.find(
      (c) => String(c[0]).includes("SET status = 'completed'") && String(c[0]).includes("status = 'processing'")
    );
    expect(completedCall).toBeTruthy();
    const pendingCall = queryMock.mock.calls.find((c) => String(c[0]).includes("SET status = 'pending'"));
    expect(pendingCall).toBeFalsy();
  });

  it("dead-letters a FINAL-attempt failure (never retries past the cap)", async () => {
    // attempts=4, max=5 → newAttempts=5 >= max, so processJob's intent is 'dead', not a pending retry.
    const jobType = "unit_test_final_attempt";
    registerJobHandler(jobType, async () => {
      throw new Error("handler boom"); // → processJob catch → dead intent (newAttempts >= max)
    });
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] };
        if (sql.includes("SELECT * FROM public.job_queue")) {
          return { rows: [{ id: 77, job_type: jobType, office_id: "office-1", payload: {}, attempts: 4, max_attempts: 5 }] };
        }
        if (sql.includes("UPDATE public.job_queue SET status = 'processing'")) return { rows: [] };
        throw new Error(`Unexpected client SQL: ${sql}`);
      }),
      release: vi.fn(),
    };
    connectMock.mockResolvedValue(client);
    queryMock.mockResolvedValue({ rows: [] });

    await pollJobs();

    const deadCall = queryMock.mock.calls.find(
      (c) => String(c[0]).includes("SET status = 'dead'") && String(c[0]).includes("status = 'processing'")
    );
    expect(deadCall).toBeTruthy();
    expect(deadCall![1]).toEqual(expect.arrayContaining([77]));
    // Never a pending retry — the cap is respected.
    const pendingCall = queryMock.mock.calls.find((c) => String(c[0]).includes("SET status = 'pending'"));
    expect(pendingCall).toBeFalsy();
  });

  it("retries a NON-final failure as pending with processJob's exponential backoff (not a fixed delay)", async () => {
    // attempts=1, max=5 → newAttempts=2 → backoff = 3^2 = 9s. Recovery must replay THAT backoff, not a
    // hardcoded 30s (the metadata processJob computed is carried, not reconstructed).
    const jobType = "unit_test_backoff";
    registerJobHandler(jobType, async () => {
      throw new Error("handler boom");
    });
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] };
        if (sql.includes("SELECT * FROM public.job_queue")) {
          return { rows: [{ id: 66, job_type: jobType, office_id: "office-1", payload: {}, attempts: 1, max_attempts: 5 }] };
        }
        if (sql.includes("UPDATE public.job_queue SET status = 'processing'")) return { rows: [] };
        throw new Error(`Unexpected client SQL: ${sql}`);
      }),
      release: vi.fn(),
    };
    connectMock.mockResolvedValue(client);
    queryMock.mockResolvedValue({ rows: [] });

    await pollJobs();

    const pendingCall = queryMock.mock.calls.find(
      (c) => String(c[0]).includes("SET status = 'pending'") && String(c[0]).includes("status = 'processing'")
    );
    expect(pendingCall).toBeTruthy();
    // Bound to the claimed attempt so a late flush can't stomp a re-claim.
    expect(String(pendingCall![0])).toContain("AND attempts = $4");
    // params = [error, backoffSeconds, id, claimedAttempt] — backoff 3^2 = 9 (NOT the old fixed 30), attempt 2.
    expect(pendingCall![1]).toEqual(["handler boom", 9, 66, 2]);
  });

  it("retries an outcome write on a later tick when it fails (self-heals, no restart)", async () => {
    // A non-final failure → pending intent (backoff 3^1=3). The pending write fails on tick 1 (deferred to
    // pendingRecoveries) and is replayed by tick 2's flushPendingRecoveries — with the SAME backoff.
    const jobType = "unit_test_recovery_retry";
    registerJobHandler(jobType, async () => {
      throw new Error("handler boom"); // non-final (attempts 0/max 5) → pending retry intent
    });
    let claimRows = [{ id: 55, job_type: jobType, office_id: "office-1", payload: {}, attempts: 0, max_attempts: 5 }];
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] };
        if (sql.includes("SELECT * FROM public.job_queue")) {
          const rows = claimRows;
          claimRows = []; // tick 2 claims nothing — only the flush runs
          return { rows };
        }
        if (sql.includes("UPDATE public.job_queue SET status = 'processing'")) return { rows: [] };
        throw new Error(`Unexpected client SQL: ${sql}`);
      }),
      release: vi.fn(),
    };
    connectMock.mockResolvedValue(client);
    // The pending write fails on its first attempt (tick 1) and succeeds on the flush (tick 2).
    let pendingWrites = 0;
    queryMock.mockImplementation(async (sql: string) => {
      if (String(sql).includes("SET status = 'pending'") && String(sql).includes("status = 'processing'")) {
        pendingWrites++;
        if (pendingWrites === 1) throw new Error("pending write failed");
      }
      return { rows: [] };
    });

    await pollJobs(); // tick 1 → job 55 pending write deferred
    await pollJobs(); // tick 2 → flush retries and succeeds

    const pendingCallsForJob55 = queryMock.mock.calls.filter(
      (c) =>
        String(c[0]).includes("SET status = 'pending'") &&
        String(c[0]).includes("status = 'processing'") &&
        Array.isArray(c[1]) && (c[1] as unknown[]).includes(55)
    );
    // one failed attempt on tick 1 + one successful retry on tick 2, both with the SAME backoff (3^1=3) and
    // bound to the SAME claimed attempt (1) so a late flush can't stomp a re-claim.
    expect(pendingCallsForJob55.length).toBeGreaterThanOrEqual(2);
    expect(pendingCallsForJob55[0][1]).toEqual(["handler boom", 3, 55, 1]);
  });

  it("requeues rows to pending when the claim COMMIT fails (it may have committed server-side)", async () => {
    // A COMMIT that lands server-side but returns a rejection (dead socket after commit) leaves the claimed
    // rows 'processing'; `claimed` is reset so the run phase skips them. pollJobs must requeue them.
    const jobType = "unit_test_commit_uncertain";
    registerJobHandler(jobType, async () => {});
    const client = {
      query: vi.fn(async (sql: string) => {
        const s = String(sql);
        if (s === "BEGIN" || s === "ROLLBACK") return { rows: [] };
        if (s.includes("SELECT * FROM public.job_queue")) {
          return { rows: [{ id: 33, job_type: jobType, office_id: "office-1", payload: {}, attempts: 0, max_attempts: 5 }] };
        }
        if (s.includes("UPDATE public.job_queue SET status = 'processing'")) return { rows: [] };
        if (s === "COMMIT") throw new Error("commit rejected after server-side apply"); // dead socket post-commit
        throw new Error(`Unexpected client SQL: ${s}`);
      }),
      release: vi.fn(),
    };
    connectMock.mockResolvedValue(client);
    queryMock.mockResolvedValue({ rows: [] }); // the requeue (pool.query, guarded) succeeds

    await pollJobs();

    const requeue = queryMock.mock.calls.find(
      (c) =>
        String(c[0]).includes("SET status = 'pending'") &&
        String(c[0]).includes("status = 'processing'") &&
        Array.isArray(c[1]) && (c[1] as unknown[]).includes(33)
    );
    expect(requeue).toBeTruthy();
  });

  it("recoverStaleJobs requeues stale 'processing' rows to pending (at-least-once; never dead-letters)", async () => {
    // `attempts` is incremented at claim time, so a crash BEFORE the handler runs leaves a final-attempt
    // row at attempts==max even though it never executed. Startup recovery can't tell that from a
    // handler-ran-but-outcome-write-failed row, so it must requeue (favor at-least-once) rather than
    // dead-letter — otherwise it silently drops never-run work. (The cap is enforced in the run phase,
    // where the handler is known to have executed.)
    queryMock.mockResolvedValue({ rows: [] });

    await recoverStaleJobs();

    const call = queryMock.mock.calls.find(
      (c) => String(c[0]).includes("status = 'processing'") && String(c[0]).includes("started_processing_at")
    );
    expect(call).toBeTruthy();
    const sql = String(call![0]);
    expect(sql).toMatch(/SET status = 'pending'/);
    expect(sql).not.toMatch(/THEN 'dead'/); // must NOT dead-letter a possibly-never-run final attempt
  });
});
