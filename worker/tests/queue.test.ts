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

const { deadJob, deferJob, pollJobs, pollBidBoardIngestJobs, registerJobHandler, recoverStaleJobs, __resetQueueStateForTest, __setQueueQueryTimeoutForTest } = await import("../src/queue.js");

// ── Pool harness ────────────────────────────────────────────────────────────────────────────────
// Both the CLAIM path and the OUTCOME-WRITE path check out an explicit client via pool.connect() (the
// outcome write was moved off the convenience pool.query() so a timed-out write can be DESTROYED via
// release(err) instead of leaking a pool slot). So the harness routes EVERY connect() through one shared
// query router and hands back a FRESH client per checkout — mirroring reality, where the claim connection
// and each outcome-write connection are distinct checkouts with independent release() lifecycles.
//
// `queryRouter(sql, params)` owns the claim SQL (BEGIN/COMMIT/ROLLBACK/SELECT/mark-processing) AND the
// guarded outcome writes (SET status = 'completed'|'dead'|'pending' … AND status = 'processing'). Recorded
// queries land in `queries` (from any checked-out client) so outcome-write assertions inspect that instead
// of the old pool.query mock. `releases` records every client.release(arg) so a leaked/destroyed connection
// is observable. `recoverStaleJobs` still hits pool.query directly, so queryMock is kept for it.
type QueryCall = [string, unknown[] | undefined];

type PoolHarness = {
  queries: QueryCall[];
  releases: unknown[];
  connectCount: () => number;
};

function installPool(
  router: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>
): PoolHarness {
  const queries: QueryCall[] = [];
  const releases: unknown[] = [];
  connectMock.mockImplementation(async () => ({
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      queries.push([sql, params]);
      return router(sql, params);
    }),
    release: vi.fn((arg?: unknown) => {
      releases.push(arg);
    }),
  }));
  return { queries, releases, connectCount: () => connectMock.mock.calls.length };
}

/** A router for the common case: a single claimed job (or none), all queries succeeding. */
function claimRouter(rows: () => any[]) {
  let claimed = false;
  return async (sql: string) => {
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
    if (sql.includes("SELECT * FROM public.job_queue")) {
      if (claimed) return { rows: [] };
      claimed = true;
      return { rows: rows() };
    }
    if (sql.includes("UPDATE public.job_queue SET status = 'processing'")) return { rows: [] };
    // Outcome writes (guarded terminal updates) succeed by default.
    if (sql.includes("public.job_queue SET status =")) return { rows: [] };
    throw new Error(`Unexpected SQL: ${sql}`);
  };
}

function outcomeWrites(queries: QueryCall[]): QueryCall[] {
  return queries.filter(([sql]) => sql.includes("public.job_queue SET status =") && sql.includes("status = 'processing'"));
}

describe("worker queue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetQueueStateForTest(); // clear the cross-tick pendingRecoveries singleton between cases
  });

  it("marks non-retryable job results dead without requeueing", async () => {
    const jobType = "unit_test_non_retryable_job";
    registerJobHandler(jobType, async () => deadJob("missing requestedBy"));

    const { queries } = installPool(
      claimRouter(() => [
        { id: 41, job_type: jobType, office_id: "office-1", payload: { dealId: "deal-1" }, attempts: 0, max_attempts: 5 },
      ])
    );

    await pollJobs();

    // The processing-mark carries the job id.
    const markProcessing = queries.find(([sql]) => sql.includes("SET status = 'processing'"));
    expect(markProcessing?.[1]).toEqual([41]);
    // The dead outcome write is bound to the claimed attempt (job.attempts 0 → attempt 1).
    const deadWrite = queries.find(([sql]) => sql.includes("SET status = 'dead'") && sql.includes("status = 'processing'"));
    expect(deadWrite).toBeTruthy();
    expect(deadWrite![0]).toBe(
      "UPDATE public.job_queue SET status = 'dead', last_error = $1 WHERE id = $2 AND status = 'processing' AND attempts = $3"
    );
    expect(deadWrite![1]).toEqual(["missing requestedBy", 41, 1]);
    // Never a pending retry.
    expect(queries.some(([sql]) => sql.includes("run_after = NOW() + make_interval"))).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(
      "[Worker] Job 41 (unit_test_non_retryable_job) rejected without retry: missing requestedBy"
    );
  });

  it("reschedules an explicitly deferred handler result WITHOUT consuming an attempt (rolls the claim back)", async () => {
    const jobType = "unit_test_explicit_defer";
    registerJobHandler(jobType, async () => deferJob("waiting for another worker lease", 300));
    const { queries } = installPool(
      claimRouter(() => [{ id: 42, job_type: jobType, office_id: "office-1", payload: {}, attempts: 0, max_attempts: 5 }])
    );

    await pollJobs();

    const pendingWrite = queries.find(([sql]) => sql.includes("SET status = 'pending'"));
    expect(pendingWrite).toBeTruthy();
    // A DEFERRAL must not burn a queue attempt — the outcome write rolls the claim's increment back
    // (attempts = attempts - 1), so repeated deferrals of a genuinely-leased job can't dead-letter it unrun.
    expect(pendingWrite![0]).toContain("attempts = attempts - 1");
    // Still guarded on the CLAIMED attempt so a late flush can't roll back a re-claim.
    expect(pendingWrite![0]).toContain("AND attempts = $4");
    expect(pendingWrite![1]).toEqual(["waiting for another worker lease", 300, 42, 1]);
    expect(queries.some(([sql]) => sql.includes("SET status = 'completed'"))).toBe(false);
    // A deferral is NOT a failure retry — the failure-retry pending write (no attempt rollback) must not appear.
    const retryWrite = queries.find(
      ([sql]) => sql.includes("SET status = 'pending'") && !sql.includes("attempts = attempts - 1")
    );
    expect(retryWrite).toBeUndefined();
  });

  it("releases the poll (claim) connection BEFORE running job handlers (so nested pool.connect can't deadlock)", async () => {
    const jobType = "unit_test_release_before_handler";
    let releasesAtHandlerTime = -1;
    const releases: unknown[] = [];
    connectMock.mockImplementation(async () => ({
      query: vi.fn(async (sql: string) => {
        if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] };
        if (sql.includes("SELECT * FROM public.job_queue")) {
          return { rows: [{ id: 77, job_type: jobType, office_id: "office-1", payload: {}, attempts: 0, max_attempts: 5 }] };
        }
        if (sql.includes("UPDATE public.job_queue SET status = 'processing'")) return { rows: [] };
        if (sql.includes("public.job_queue SET status =")) return { rows: [] };
        throw new Error(`Unexpected SQL: ${sql}`);
      }),
      release: vi.fn((arg?: unknown) => releases.push(arg)),
    }));
    registerJobHandler(jobType, async () => {
      // The claim connection must already be back in the pool before handlers (which open their own
      // nested pool.connect) run — otherwise a batch can exhaust the pool and wedge pollJobs forever.
      releasesAtHandlerTime = releases.length;
    });

    await pollJobs();

    // Exactly one connection (the claim) had been released by the time the handler ran; the outcome-write
    // connection is only checked out AFTER the handler resolves.
    expect(releasesAtHandlerTime).toBe(1);
    // The claim connection was returned CLEAN (no destroy error).
    expect(releases[0]).toBeUndefined();
  });

  it("swallows a pool-acquire failure as a skipped tick (no throw) and stays pollable", async () => {
    // With connectionTimeoutMillis set, an exhausted pool rejects the acquire. It must NOT escape as an
    // unhandled rejection (setInterval(pollJobs) is bare) and must NOT wedge the `polling` guard.
    connectMock.mockRejectedValueOnce(new Error("timeout exceeded when trying to connect"));
    await expect(pollJobs()).resolves.toBeUndefined();

    // A healthy connection on the next tick proves the guard was released (connect is attempted again).
    const { releases } = installPool(claimRouter(() => []));
    await pollJobs();
    expect(connectMock).toHaveBeenCalledTimes(2);
    expect(releases).toHaveLength(1); // the claim connection, returned clean
    expect(releases[0]).toBeUndefined();
  });

  it("claims at most RUN_CONCURRENCY rows per tick (the claim LIMIT is the concurrency bound)", async () => {
    // Concurrency is bounded by the claim itself — we claim only what we immediately run — so a hung
    // handler can't strand extra pre-claimed 'processing' rows. Assert the claim SELECT uses LIMIT 3.
    const { queries } = installPool(claimRouter(() => []));

    await pollJobs();

    const claim = queries.find(([sql]) => sql.includes("SELECT * FROM public.job_queue"));
    // Parameterized ($1), not interpolated — static query text, LIMIT bound = RUN_CONCURRENCY (3).
    expect(claim![0]).toMatch(/LIMIT \$1\b/);
    expect(claim![1]).toEqual([3]);
  });

  it("does not reject pollJobs when a job's outcome write fails (self-registers for retry)", async () => {
    // processJob persists its outcome via attemptRecovery, which SWALLOWS a write failure (keeps the intent
    // in pendingRecoveries for a later tick). So even under pool pressure processJob doesn't reject — it
    // can't escape the bare setInterval(pollJobs) as an unhandled rejection or clear `polling` mid-flight.
    const jobType = "unit_test_recording_failure";
    registerJobHandler(jobType, async () => {}); // handler succeeds; the FAILURE is recording the outcome
    let claimed = false;
    installPool(async (sql: string) => {
      if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] };
      if (sql.includes("SELECT * FROM public.job_queue")) {
        if (claimed) return { rows: [] };
        claimed = true;
        return { rows: [{ id: 88, job_type: jobType, office_id: "office-1", payload: {}, attempts: 0, max_attempts: 5 }] };
      }
      if (sql.includes("UPDATE public.job_queue SET status = 'processing'")) return { rows: [] };
      // The outcome (completed) write fails — as an exhausted pool / dead socket would.
      if (sql.includes("public.job_queue SET status =")) throw new Error("timeout exceeded when trying to connect");
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    await expect(pollJobs()).resolves.toBeUndefined(); // did NOT reject

    // `polling` was reset, so the next tick still runs.
    await expect(pollJobs()).resolves.toBeUndefined();
    // Two ticks each check out a claim connection (tick 2 also re-attempts the deferred write via the flush).
    expect(connectMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("destroys the claim connection (release(err)) when ROLLBACK fails after a poll error", async () => {
    // A broken connection whose ROLLBACK also fails must NOT be returned to the pool as healthy — the next
    // caller could inherit a connection still mid-transaction. release(err) tells the pool to discard it.
    const releases: unknown[] = [];
    connectMock.mockImplementation(async () => ({
      query: vi.fn(async (sql: string) => {
        if (sql === "BEGIN") return { rows: [] };
        if (sql.includes("SELECT * FROM public.job_queue")) throw new Error("claim boom"); // enter catch
        if (sql === "ROLLBACK") throw new Error("rollback boom"); // rollback also fails
        throw new Error(`Unexpected SQL: ${sql}`);
      }),
      release: vi.fn((arg?: unknown) => releases.push(arg)),
    }));

    await expect(pollJobs()).resolves.toBeUndefined(); // swallowed, no throw

    expect(releases).toHaveLength(1);
    expect(releases[0]).toBeInstanceOf(Error); // destroyed, not returned healthy
  });

  it("recovers a SUCCEEDED job as 'completed' (never re-run as pending) when its outcome write fails", async () => {
    // The intent for a succeeded handler is 'completed'. If that write fails it's kept in pendingRecoveries
    // and replayed as 'completed' — NOT reset to pending (which would re-run an already-successful handler).
    const jobType = "unit_test_succeeded_recovery";
    registerJobHandler(jobType, async () => {}); // handler SUCCEEDS
    let claimed = false;
    let completedAttempts = 0;
    const { queries } = installPool(async (sql: string) => {
      if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] };
      if (sql.includes("SELECT * FROM public.job_queue")) {
        if (claimed) return { rows: [] }; // tick 2 claims nothing — only the flush runs
        claimed = true;
        return { rows: [{ id: 99, job_type: jobType, office_id: "office-1", payload: {}, attempts: 0, max_attempts: 5 }] };
      }
      if (sql.includes("UPDATE public.job_queue SET status = 'processing'")) return { rows: [] };
      if (sql.includes("SET status = 'completed'")) {
        completedAttempts++;
        if (completedAttempts === 1) throw new Error("completed write failed"); // tick 1 fails
        return { rows: [] }; // tick 2 flush succeeds
      }
      if (sql.includes("public.job_queue SET status =")) return { rows: [] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    await pollJobs(); // tick 1: completed write fails → kept in pendingRecoveries
    await pollJobs(); // tick 2: flush replays the completed write

    // Recovered as 'completed' (guarded), and NEVER as pending (would re-run a succeeded job).
    const completedCall = queries.find(
      ([sql]) => sql.includes("SET status = 'completed'") && sql.includes("status = 'processing'")
    );
    expect(completedCall).toBeTruthy();
    expect(queries.some(([sql]) => sql.includes("SET status = 'pending'"))).toBe(false);
  });

  it("dead-letters a FINAL-attempt failure (never retries past the cap)", async () => {
    // attempts=4, max=5 → newAttempts=5 >= max, so processJob's intent is 'dead', not a pending retry.
    const jobType = "unit_test_final_attempt";
    registerJobHandler(jobType, async () => {
      throw new Error("handler boom"); // → processJob catch → dead intent (newAttempts >= max)
    });
    const { queries } = installPool(
      claimRouter(() => [{ id: 77, job_type: jobType, office_id: "office-1", payload: {}, attempts: 4, max_attempts: 5 }])
    );

    await pollJobs();

    const deadCall = outcomeWrites(queries).find(([sql]) => sql.includes("SET status = 'dead'"));
    expect(deadCall).toBeTruthy();
    expect(deadCall![1]).toEqual(expect.arrayContaining([77]));
    // Never a pending retry — the cap is respected.
    expect(queries.some(([sql]) => sql.includes("SET status = 'pending'"))).toBe(false);
  });

  it("retries a NON-final failure as pending with processJob's exponential backoff (not a fixed delay)", async () => {
    // attempts=1, max=5 → newAttempts=2 → backoff = 3^2 = 9s. Recovery must replay THAT backoff, not a
    // hardcoded 30s (the metadata processJob computed is carried, not reconstructed).
    const jobType = "unit_test_backoff";
    registerJobHandler(jobType, async () => {
      throw new Error("handler boom");
    });
    const { queries } = installPool(
      claimRouter(() => [{ id: 66, job_type: jobType, office_id: "office-1", payload: {}, attempts: 1, max_attempts: 5 }])
    );

    await pollJobs();

    const pendingCall = outcomeWrites(queries).find(([sql]) => sql.includes("SET status = 'pending'"));
    expect(pendingCall).toBeTruthy();
    // Bound to the claimed attempt so a late flush can't stomp a re-claim.
    expect(pendingCall![0]).toContain("AND attempts = $4");
    // A failure retry (thrown error) DOES consume the attempt — unlike a deliberate deferral, it must NOT roll
    // the claim back (otherwise a persistently-failing job would loop forever without ever dead-lettering).
    expect(pendingCall![0]).not.toContain("attempts = attempts - 1");
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
    let claimed = false;
    let pendingWrites = 0;
    const { queries } = installPool(async (sql: string) => {
      if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] };
      if (sql.includes("SELECT * FROM public.job_queue")) {
        if (claimed) return { rows: [] }; // tick 2 claims nothing — only the flush runs
        claimed = true;
        return { rows: [{ id: 55, job_type: jobType, office_id: "office-1", payload: {}, attempts: 0, max_attempts: 5 }] };
      }
      if (sql.includes("UPDATE public.job_queue SET status = 'processing'")) return { rows: [] };
      if (sql.includes("SET status = 'pending'") && sql.includes("status = 'processing'")) {
        pendingWrites++;
        if (pendingWrites === 1) throw new Error("pending write failed"); // tick 1 fails
        return { rows: [] }; // tick 2 flush succeeds
      }
      if (sql.includes("public.job_queue SET status =")) return { rows: [] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    await pollJobs(); // tick 1 → job 55 pending write deferred
    await pollJobs(); // tick 2 → flush retries and succeeds

    const pendingCallsForJob55 = queries.filter(
      ([sql, params]) =>
        sql.includes("SET status = 'pending'") &&
        sql.includes("status = 'processing'") &&
        Array.isArray(params) && (params as unknown[]).includes(55)
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
    let claimed = false;
    const { queries } = installPool(async (sql: string) => {
      if (sql === "BEGIN" || sql === "ROLLBACK") return { rows: [] };
      if (sql.includes("SELECT * FROM public.job_queue")) {
        if (claimed) return { rows: [] };
        claimed = true;
        return { rows: [{ id: 33, job_type: jobType, office_id: "office-1", payload: {}, attempts: 0, max_attempts: 5 }] };
      }
      if (sql.includes("UPDATE public.job_queue SET status = 'processing'")) return { rows: [] };
      if (sql === "COMMIT") throw new Error("commit rejected after server-side apply"); // dead socket post-commit
      if (sql.includes("public.job_queue SET status =")) return { rows: [] }; // the requeue (guarded) succeeds
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    await pollJobs();

    const requeue = queries.find(
      ([sql, params]) =>
        sql.includes("SET status = 'pending'") &&
        sql.includes("status = 'processing'") &&
        Array.isArray(params) && (params as unknown[]).includes(33)
    );
    expect(requeue).toBeTruthy();
  });

  it("recoverStaleJobs requeues stale 'processing' rows to pending (at-least-once; never dead-letters)", async () => {
    // `attempts` is incremented at claim time, so a crash BEFORE the handler runs leaves a final-attempt
    // row at attempts==max even though it never executed. Startup recovery can't tell that from a
    // handler-ran-but-outcome-write-failed row, so it must requeue (favor at-least-once) rather than
    // dead-letter — otherwise it silently drops never-run work. (The cap is enforced in the run phase,
    // where the handler is known to have executed.) recoverStaleJobs uses pool.query directly.
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

  it("does NOT hang on a silently-dead socket — times out the claim query and DESTROYS the connection", async () => {
    // The worker pool sets no query_timeout; a dead socket would otherwise hang the claim (and the poller's
    // reentrancy guard) forever. withQueueTimeout must reject, and the poisoned client must be destroyed.
    __setQueueQueryTimeoutForTest(20); // shrink so the test doesn't wait the real 30s
    try {
      const releases: unknown[] = [];
      connectMock.mockImplementation(async () => ({
        query: vi.fn((sql: string) => {
          if (sql === "BEGIN") return Promise.resolve({ rows: [] });
          if (sql.includes("SELECT * FROM public.job_queue")) return new Promise(() => {}); // never settles
          return Promise.resolve({ rows: [] });
        }),
        release: vi.fn((arg?: unknown) => releases.push(arg)),
      }));

      await expect(pollJobs()).resolves.toBeUndefined(); // completes (doesn't hang, doesn't reject)

      expect(releases).toHaveLength(1);
      expect(releases[0]).toBeInstanceOf(Error); // destroyed (release(err)), not returned healthy
    } finally {
      __setQueueQueryTimeoutForTest(30_000); // restore for the other tests
    }
  });

  it("does NOT hang — and does NOT leak the pool slot — when the OUTCOME write's socket is silently dead", async () => {
    // The outcome write is the second dead-socket surface. A hung write must (1) time out rather than wedge
    // the run phase / reentrancy guard, and (2) DESTROY its checked-out client via release(err) so the slot
    // is reclaimed immediately — otherwise the per-tick flush re-attempts it and the leaked slots exhaust
    // the pool (max 10), stalling unrelated jobs. This is the exact bug this change fixes.
    __setQueueQueryTimeoutForTest(20);
    try {
      const jobType = "unit_test_outcome_dead_socket";
      registerJobHandler(jobType, async () => {}); // handler succeeds → a 'completed' outcome write follows
      let claimed = false;
      const releases: unknown[] = [];
      connectMock.mockImplementation(async () => ({
        query: vi.fn((sql: string) => {
          if (sql === "BEGIN" || sql === "COMMIT") return Promise.resolve({ rows: [] });
          if (sql.includes("SELECT * FROM public.job_queue")) {
            if (claimed) return Promise.resolve({ rows: [] });
            claimed = true;
            return Promise.resolve({
              rows: [{ id: 21, job_type: jobType, office_id: "office-1", payload: {}, attempts: 0, max_attempts: 5 }],
            });
          }
          if (sql.includes("UPDATE public.job_queue SET status = 'processing'")) return Promise.resolve({ rows: [] });
          if (sql.includes("public.job_queue SET status =")) return new Promise(() => {}); // outcome write never settles
          throw new Error(`Unexpected SQL: ${sql}`);
        }),
        release: vi.fn((arg?: unknown) => releases.push(arg)),
      }));

      await expect(pollJobs()).resolves.toBeUndefined(); // completes (doesn't hang, doesn't reject)

      // Two checkouts: the claim connection (returned clean) and the outcome-write connection (DESTROYED).
      expect(connectMock).toHaveBeenCalledTimes(2);
      expect(releases).toHaveLength(2);
      expect(releases[0]).toBeUndefined(); // claim connection returned clean
      expect(releases[1]).toBeInstanceOf(Error); // outcome-write connection destroyed — slot reclaimed, no leak
    } finally {
      __setQueueQueryTimeoutForTest(30_000);
    }
  });

  it("main pollJobs EXCLUDES bid_board_ingest from its claim (that type runs on a dedicated poller)", async () => {
    // A multi-minute bid_board_ingest must not hold the main `polling` guard across its run phase and starve
    // every other job type — so the main claim predicate excludes it.
    const { queries } = installPool(claimRouter(() => []));

    await pollJobs();

    const claim = queries.find(([sql]) => sql.includes("SELECT * FROM public.job_queue"));
    expect(claim![0]).toContain("job_type <> 'bid_board_ingest'");
  });

  it("pollBidBoardIngestJobs claims ONLY bid_board_ingest, one at a time (LIMIT 1)", async () => {
    const { queries } = installPool(claimRouter(() => []));

    await pollBidBoardIngestJobs();

    const claim = queries.find(([sql]) => sql.includes("SELECT * FROM public.job_queue"));
    expect(claim![0]).toContain("job_type = 'bid_board_ingest'");
    expect(claim![0]).not.toContain("<>"); // only-this-type, not exclude-this-type
    expect(claim![1]).toEqual([1]); // BID_BOARD_INGEST_CONCURRENCY — one import at a time
  });

  it("the dedicated poller reschedules a DEFERRED bid_board_ingest result as pending without consuming an attempt", async () => {
    // A live-leased inbox row surfaces as deferJob(...) → the queue row must go back to 'pending' with the
    // requested delay, NOT 'completed' (which would strand the inbox until the slow periodic sweep). And the
    // deferral must ROLL BACK the claim's attempt increment: startup recovery can requeue an import still running
    // on another replica, and each defer would otherwise burn a queue attempt until the row dead-letters unrun.
    registerJobHandler("bid_board_ingest", async () => deferJob("inbox lease held by a live handler", 182));
    const { queries } = installPool(
      claimRouter(() => [
        { id: 51, job_type: "bid_board_ingest", office_id: "office-1", payload: { inboxId: "i1" }, attempts: 0, max_attempts: 8 },
      ])
    );

    await pollBidBoardIngestJobs();

    const pendingWrite = queries.find(([sql]) => sql.includes("SET status = 'pending'"));
    expect(pendingWrite).toBeTruthy();
    expect(pendingWrite![0]).toContain("attempts = attempts - 1"); // attempt not consumed
    expect(pendingWrite![1]).toEqual(["inbox lease held by a live handler", 182, 51, 1]);
    expect(queries.some(([sql]) => sql.includes("SET status = 'completed'"))).toBe(false);
  });
});
