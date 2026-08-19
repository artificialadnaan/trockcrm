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

const {
  deadJob,
  deferJob,
  pollJobs,
  pollBidBoardIngestJobs,
  pollAiReportJobs,
  pollGlassesWalkthroughForwardJobs,
  pollWeeklyReportSendJobs,
  registerJobHandler,
  recoverStaleJobs,
  __resetQueueStateForTest,
  __setQueueQueryTimeoutForTest,
  __setJobLeaseRenewIntervalForTest,
  __awaitJobLeaseSweepForTest,
  __setJobLeaseSweepDueForTest,
} = await import("../src/queue.js");

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
// is observable. `recoverStaleJobs` takes an explicit client too now, so NOTHING in queue.ts reaches for
// pool.query any more — queryMock is kept only to complete the mocked pool's shape, and a test asserting it
// was never called is asserting exactly that.
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
    // Lease renewals: part of the ordinary claim lifecycle, not an outcome — a claimed row is re-stamped
    // for as long as its handler runs so an expiry sweep can tell a live delivery from a dead worker's.
    if (sql.includes("SET started_processing_at = NOW() WHERE")) return { rows: [] };
    // The expired-lease sweep. Matched BEFORE the outcome-write branch and by its own predicate, because
    // its UPDATE is `SET status = 'pending' … WHERE status = 'processing'` — an outcome write's exact
    // shape. Anything filtering these queries loosely will pick it up, and it belongs to no claim.
    if (sql.includes("started_processing_at <")) return { rows: [] };
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

  // ── Two attempts of ONE row, overlapping ────────────────────────────────────────────────────────
  // The state every case below starts from: a lease expired under a handler that was slow rather than dead
  // (its renewals were failing, or the process was paused), the sweep requeued the row, and a second worker
  // claimed it. For a while both attempts are live, and pendingRecoveries is keyed by JOB ID alone — so the
  // older attempt can reach the newer attempt's intent, which is the newer attempt's only record of an
  // outcome that has already happened. Losing it leaves the row 'processing' with nobody renewing it: no
  // poller selects that status, so it waits out a full lease and is then RE-RUN, work already done.
  //
  // One process cannot claim one row twice on one poller — the reentrancy guard is in the way, and it is not
  // what these cases are about. So the second poller stands in for the second WORKER PROCESS: the fake
  // ignores the claim's job_type predicate, both pollers are handed the SAME row (id 42, same type, at the
  // attempts value each would really see), and the queue code under test cannot tell the difference — it
  // reads a claimed row and a job id, never which loop claimed it.
  const OVERLAP_JOB_ID = 42;

  /** A statement the router parks until the test opens it — how one write is held across another worker's
   *  entire delivery, which is the interleaving these cases exist for. */
  function latch(): { held: Promise<void>; open: () => void } {
    let open!: () => void;
    const held = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { held, open };
  }

  async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    throw new Error("Timed out waiting for the expected statement to be issued");
  }

  /** Completed-outcome writes for the overlap row bound to one specific attempt. */
  function completedWritesForAttempt(queries: QueryCall[], attempt: number): QueryCall[] {
    return queries.filter(
      ([sql, params]) =>
        sql.includes("SET status = 'completed'") &&
        Array.isArray(params) &&
        (params as unknown[])[0] === OVERLAP_JOB_ID &&
        (params as unknown[])[1] === attempt
    );
  }

  /** Rows for the overlap job as each worker's claim would see them (worker 2 claims after a requeue). */
  function overlapRow(jobType: string, attempts: number) {
    return { id: OVERLAP_JOB_ID, job_type: jobType, office_id: "office-1", payload: {}, attempts, max_attempts: 5 };
  }

  /**
   * The statements every overlap case answers identically: the transaction verbs, the two-worker claim
   * branch keyed on job type, and the two lease writes. Only the `SET status = 'completed'` branch
   * differs between them, so that is the one thing a case supplies.
   *
   * Extracted because three copies of a router is three places to update when `claimAndRunJobs` gains a
   * statement — and the failure mode of missing one is not a red test, it is `Unexpected SQL` from a
   * case that was supposed to be exercising something else entirely.
   */
  function overlapRouter(
    jobType: string,
    onCompletedWrite: (params: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number }>,
  ) {
    let worker1Claimed = false;
    let worker2Claimed = false;
    return async (sql: string, params?: unknown[]) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
      if (sql.includes("SELECT * FROM public.job_queue")) {
        if (sql.includes("job_type = 'ai_report_generation'")) {
          if (worker2Claimed) return { rows: [] };
          worker2Claimed = true;
          return { rows: [overlapRow(jobType, 1)] }; // requeued at 1 by the sweep -> this claim is attempt 2
        }
        if (worker1Claimed) return { rows: [] };
        worker1Claimed = true;
        return { rows: [overlapRow(jobType, 0)] }; // -> attempt 1
      }
      if (sql.includes("UPDATE public.job_queue SET status = 'processing'")) return { rows: [] };
      if (sql.includes("SET started_processing_at = NOW() WHERE")) return { rows: [] };
      if (sql.includes("SET status = 'completed'")) return onCompletedWrite((params ?? []) as unknown[]);
      throw new Error(`Unexpected SQL: ${sql}`);
    };
  }

  it("a STALE attempt's zero-row outcome write does not delete the NEWER attempt's recovery intent", async () => {
    // The stale attempt's guarded write is answered normally by PostgreSQL and matches NOTHING (the row is at
    // attempts 2 now), so it resolved nothing at all — and a delete keyed on job id alone would still throw
    // away the newer attempt's intent, the only surviving record that this walk's handler already succeeded.
    const jobType = "unit_test_overlapping_attempts";
    registerJobHandler(jobType, async () => {}); // both deliveries succeed; the race is over the WRITE
    const gate = latch();
    let staleWriteIssued = false;
    let newerWrites = 0;
    const { queries } = installPool(
      overlapRouter(jobType, async (params) => {
        if (params[1] === 1) {
          staleWriteIssued = true;
          await gate.held;
          return { rows: [], rowCount: 0 }; // guarded on attempts = 1; the row is at 2 -> matched nothing
        }
        newerWrites += 1;
        if (newerWrites === 1) throw new Error("outcome write failed (pool exhausted)");
        return { rows: [], rowCount: 1 };
      }),
    );

    const worker1 = pollJobs(); // claims attempt 1, handler succeeds, outcome write held open
    await waitUntil(() => staleWriteIssued);
    // Worker 2, meanwhile, runs the whole delivery: claims attempt 2, succeeds, and its outcome write fails
    // under pool pressure — so 'completed' for attempt 2 now lives ONLY in pendingRecoveries.
    await pollAiReportJobs();
    gate.open();
    await worker1; // the stale, zero-row write lands here

    await pollJobs(); // the next tick's flush must still have the newer intent to replay

    // Worker 2's own failed write, then the flush replaying it. Without the ownership check the flush finds
    // nothing to replay, and the row stays 'processing' until a sweep re-runs a walk that already completed.
    expect(completedWritesForAttempt(queries, 2)).toHaveLength(2);
  });

  it("a STALE attempt's FAILED outcome write does not overwrite the NEWER attempt's recovery intent", async () => {
    // The same collision one statement over: the stale attempt's write fails rather than returning zero rows,
    // and storing its own intent would evict the newer one just as completely. Attempt 1's intent can never
    // match again — a re-claim only moves attempts forward — so the replay would be a doomed write every tick
    // while the outcome that DID happen is gone.
    const jobType = "unit_test_overlapping_attempts_failed_write";
    registerJobHandler(jobType, async () => {});
    const gate = latch();
    let staleWriteIssued = false;
    let newerWrites = 0;
    const { queries } = installPool(
      overlapRouter(jobType, async (params) => {
        if (params[1] === 1) {
          staleWriteIssued = true;
          await gate.held;
          throw new Error("stale outcome write failed (pool exhausted)");
        }
        newerWrites += 1;
        if (newerWrites === 1) throw new Error("outcome write failed (pool exhausted)");
        return { rows: [], rowCount: 1 };
      }),
    );

    const worker1 = pollJobs();
    await waitUntil(() => staleWriteIssued);
    await pollAiReportJobs();
    gate.open();
    await worker1;

    await pollJobs();

    expect(completedWritesForAttempt(queries, 2)).toHaveLength(2); // failed write + flush replay
    // …and the superseded attempt is never replayed: it is one write, its own, and no later tick repeats it.
    expect(completedWritesForAttempt(queries, 1)).toHaveLength(1);
  });

  it("a flush in flight does not delete an intent stored while it was waiting", async () => {
    // Third statement, same assumption. The flush snapshots the map and deletes by job id after its write,
    // but the dedicated pollers keep running deliveries throughout a main-poller tick — so the entry it
    // deletes need not be the entry it wrote.
    const jobType = "unit_test_flush_overwritten_intent";
    registerJobHandler(jobType, async () => {});
    const gate = latch();
    let flushWriteIssued = false;
    let staleWrites = 0;
    let newerWrites = 0;
    const { queries } = installPool(
      overlapRouter(jobType, async (params) => {
        if (params[1] === 1) {
          staleWrites += 1;
          if (staleWrites === 1) throw new Error("outcome write failed (pool exhausted)"); // -> intent for attempt 1
          flushWriteIssued = true;
          await gate.held; // the FLUSH's replay of that intent, held open
          return { rows: [], rowCount: 0 }; // the row moved to attempt 2 -> matched nothing
        }
        newerWrites += 1;
        if (newerWrites === 1) throw new Error("outcome write failed (pool exhausted)");
        return { rows: [], rowCount: 1 };
      }),
    );

    await pollJobs(); // tick 1: attempt 1 succeeds, its write fails → intent for attempt 1
    const tick2 = pollJobs(); // tick 2: the flush replays that intent — held open
    await waitUntil(() => flushWriteIssued);
    await pollAiReportJobs(); // worker 2's whole delivery lands here, replacing the intent with attempt 2's
    gate.open();
    await tick2;

    await pollJobs(); // tick 3: the flush must replay the intent it did NOT write

    expect(completedWritesForAttempt(queries, 2)).toHaveLength(2);
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
    // where the handler is known to have executed.)
    const { queries, releases } = installPool(claimRouter(() => []));

    await recoverStaleJobs();

    const call = queries.find(
      ([sql]) => sql.includes("status = 'processing'") && sql.includes("started_processing_at")
    );
    expect(call).toBeTruthy();
    const sql = String(call![0]);
    expect(sql).toMatch(/SET status = 'pending'/);
    expect(sql).not.toMatch(/THEN 'dead'/); // must NOT dead-letter a possibly-never-run final attempt
    // On an EXPLICIT client, like every other statement this module issues — never the pool's unbounded
    // convenience query, which cannot be time-bounded without leaking the slot it is holding.
    expect(queryMock).not.toHaveBeenCalled();
    expect(releases).toEqual([undefined]); // a clean statement returns its connection, it doesn't destroy it
  });

  // ── The claim is a LEASE ──────────────────────────────────────────────────────────────────────────
  //
  // A claim marks a row 'processing' and nothing else ever selects that status, so an unrenewed claim whose
  // owner died is not a delayed job, it is a job that stopped existing as work: the dedicated pollers take
  // only 'pending' rows, and startup recovery only sees rows already five minutes old — a worker that
  // crashes and restarts inside that window leaves the row behind forever, with no dead letter and no
  // alert. The renewal below is what lets the sweep run on a timer instead of once at boot without
  // reclaiming a live multi-GB forward out from under the worker still uploading it.
  it("renews a claimed row's lease for as long as its handler runs, bound to the attempt it claimed", async () => {
    // Shrunk so the case exercises real renewals in milliseconds instead of waiting out a production minute.
    __setJobLeaseRenewIntervalForTest(5);
    try {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      registerJobHandler("glasses_walkthrough_forward", async () => {
        await held; // stands in for a forward that is still moving bytes
      });
      const { queries } = installPool(
        claimRouter(() => [
          {
            id: 61,
            job_type: "glasses_walkthrough_forward",
            office_id: "office-1",
            payload: {},
            attempts: 2,
            max_attempts: 10,
          },
        ])
      );
      const renewals = () =>
        queries.filter(([sql]) => sql.startsWith("UPDATE public.job_queue SET started_processing_at"));

      const inFlight = pollGlassesWalkthroughForwardJobs();
      await new Promise((resolve) => setTimeout(resolve, 40));

      expect(renewals().length).toBeGreaterThan(0);
      // Bound to the CLAIMED attempt (pre-claim 2 → 3), exactly like every outcome write. A renewal that is
      // not attempt-bound is worse than none: a handler whose lease already lapsed and whose row another
      // worker re-claimed would keep pushing the timestamp forward under the NEW owner, so that owner's
      // lease could never expire either — one dead worker would make a row permanently unreclaimable.
      expect(renewals()[0][0]).toBe(
        "UPDATE public.job_queue SET started_processing_at = NOW() WHERE id = $1 AND status = 'processing' AND attempts = $2"
      );
      expect(renewals()[0][1]).toEqual([61, 3]);

      release();
      await inFlight;
      // …and renewals STOP when the handler lets go of the row. A lease that outlives its owner is a row
      // no sweep can ever reclaim.
      const afterFinish = renewals().length;
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(renewals().length).toBe(afterFinish);
    } finally {
      __setJobLeaseRenewIntervalForTest(60_000);
    }
  });

  it("sweeps expired leases on ordinary poll ticks, not only at startup", async () => {
    // The startup-only sweep is exactly what strands a crashed forward: it requeues rows already five
    // minutes stale, so a worker that dies 30 seconds into a walk and restarts leaves that row 'processing'
    // with nothing that will ever look at it again. The sweep rides the main poller for the same reason
    // flushPendingRecoveries does — one place, for every poller, rather than a private timer per job type.
    __setJobLeaseSweepDueForTest();
    const { queries } = installPool(claimRouter(() => []));
    // The sweep goes through a checked-out client now, like every other statement this module issues, so
    // it is observed on the harness's recorded queries rather than on the convenience pool.query.
    const sweeps = () => queries.filter(([sql]) => sql.includes("started_processing_at <"));

    await pollJobs();
    await __awaitJobLeaseSweepForTest(); // the tick no longer waits for it, so the assertion has to
    expect(sweeps()).toHaveLength(1);

    // Throttled to its own cadence rather than the poll interval: at POLL_INTERVAL_MS this would otherwise
    // be a full-table UPDATE several times a minute to reclaim rows that appear only when a worker dies.
    await pollJobs();
    await __awaitJobLeaseSweepForTest();
    expect(sweeps()).toHaveLength(1);
  });

  it("GUARD: a failing lease sweep cannot reject a poll tick — or anything else", async () => {
    // Nothing awaits the sweep now, which sharpens this: pollJobs runs under a bare setInterval (index.ts),
    // so an escaping rejection is an UNHANDLED rejection that takes the worker down — and the sweep's own
    // statement is exactly what fails when the pool is exhausted, i.e. when the worker is already having a
    // bad minute. The tick must skip, not die.
    __setJobLeaseSweepDueForTest();
    const router = claimRouter(() => []);
    installPool(async (sql: string) => {
      if (sql.includes("started_processing_at <")) throw new Error("timeout exceeded when trying to connect");
      return router(sql);
    });
    await expect(pollJobs()).resolves.toBeUndefined();
    await expect(__awaitJobLeaseSweepForTest()).resolves.toBeUndefined();
  });

  it("does NOT let a wedged lease sweep stop the poller — bounds it, destroys its socket, keeps claiming", async () => {
    // The sweep used the pool's convenience `query`, which is unbounded — unlike the claim, the renewal and
    // the outcome write, which all check out an explicit client under QUEUE_QUERY_TIMEOUT_MS. That was
    // survivable while it ran once at startup. Running it every tick from inside pollJobs, it is not: a
    // silently-dead socket (or an UPDATE parked behind a lock) leaves that promise PENDING, the surrounding
    // catch cannot run on a promise that never settles, and the tick never finishes — so `polling` stays
    // true and this worker stops claiming EVERY job type it serves. A self-healing mechanism that can wedge
    // the thing it heals is worse than no mechanism.
    __setJobLeaseSweepDueForTest();
    __setQueueQueryTimeoutForTest(20);
    // The convenience query is what the sweep used to reach for; the explicit client is what it reaches for
    // now. BOTH go quiet here, so the case describes one broken socket rather than one implementation.
    queryMock.mockImplementation(() => new Promise(() => {}));
    try {
      const jobType = "unit_test_sweep_dead_socket";
      let ran = 0;
      registerJobHandler(jobType, async () => {
        ran += 1;
      });
      const releases: unknown[] = [];
      const router = claimRouter(() => [
        { id: 71, job_type: jobType, office_id: "office-1", payload: {}, attempts: 0, max_attempts: 5 },
      ]);
      connectMock.mockImplementation(async () => ({
        query: vi.fn((sql: string, params?: unknown[]) => {
          if (sql.includes("started_processing_at <")) return new Promise(() => {}); // the sweep's UPDATE, wedged
          return router(sql, params);
        }),
        release: vi.fn((arg?: unknown) => releases.push(arg)),
      }));

      await expect(pollJobs()).resolves.toBeUndefined(); // before the fix this never settles at all

      // The tick did its actual job while the sweep was stuck — which is the whole point: the sweep is
      // background self-healing, and nothing in a poll tick depends on its outcome, so it must not be able
      // to delay one, let alone end them.
      expect(ran).toBe(1);
      // Never the unbounded convenience query again: a pool.query that never settles ALSO keeps its
      // checked-out client forever, so the sweep would leak a pool slot a minute until max 10 is gone.
      expect(queryMock).not.toHaveBeenCalled();
      // And the sweep itself still terminates and destroys its poisoned connection via release(err).
      await expect(__awaitJobLeaseSweepForTest()).resolves.toBeUndefined();
      expect(releases.some((arg) => arg instanceof Error)).toBe(true);
    } finally {
      __setQueueQueryTimeoutForTest(30_000);
      queryMock.mockResolvedValue({ rows: [] });
    }
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

  it("main pollJobs EXCLUDES every long-running type from its claim (those run on dedicated pollers)", async () => {
    // A multi-minute job must not hold the main `polling` guard across its run phase and starve every other
    // job type — so the main claim predicate excludes each one that has its own poller.
    const { queries } = installPool(claimRouter(() => []));

    await pollJobs();

    const claim = queries.find(([sql]) => sql.includes("SELECT * FROM public.job_queue"));
    expect(claim![0]).toContain("bid_board_ingest");
    // ai_report_generation is a Claude vision pass over up to 60 photographs — same starvation risk.
    expect(claim![0]).toContain("ai_report_generation");
    // glasses_walkthrough_forward relays a walk's clips (potentially gigabytes) via ranged R2 reads — same
    // starvation risk, so it must also be excluded from the main poller's claim.
    expect(claim![0]).toContain("glasses_walkthrough_forward");
    // weekly_report_send renders the client PDF first, decoding every photo on the report into memory and
    // uploading to R2 — the same shape as ai_report_generation, and the same exclusion.
    expect(claim![0]).toContain("weekly_report_send");
    expect(claim![0]).toContain("NOT IN");
  });

  it("pollAiReportJobs claims ONLY ai_report_generation, one at a time (LIMIT 1)", async () => {
    // Serialized on purpose: each run holds tens of MB of decoded image data, so concurrent reports are the
    // straightforward way to OOM the worker.
    const { queries } = installPool(claimRouter(() => []));

    await pollAiReportJobs();

    const claim = queries.find(([sql]) => sql.includes("SELECT * FROM public.job_queue"));
    expect(claim![0]).toContain("job_type = 'ai_report_generation'");
    expect(claim![0]).not.toContain("NOT IN"); // only-this-type, not exclude-these-types
    expect(claim![1]).toEqual([1]); // AI_REPORT_CONCURRENCY — one report at a time
  });

  it("pollWeeklyReportSendJobs claims ONLY weekly_report_send, one at a time (LIMIT 1)", async () => {
    // Serialized for the same two reasons as the AI report above. A send renders the report's PDF before it
    // can send, which decodes every photo on it into memory and uploads to R2 — so three on the main
    // poller's shared slots is the OOM shape, and it is also a starvation shape, because that poller also
    // carries RFP delivery and email sync while a Monday morning sends many reports at once.
    const { queries } = installPool(claimRouter(() => []));

    await pollWeeklyReportSendJobs();

    const claim = queries.find(([sql]) => sql.includes("SELECT * FROM public.job_queue"));
    expect(claim![0]).toContain("job_type = 'weekly_report_send'");
    expect(claim![0]).not.toContain("NOT IN"); // only-this-type, not exclude-these-types
    expect(claim![1]).toEqual([1]); // WEEKLY_REPORT_SEND_CONCURRENCY — one client report at a time
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

  it("pollGlassesWalkthroughForwardJobs claims ONLY glasses_walkthrough_forward, one at a time (LIMIT 1)", async () => {
    // A walkthrough forward relays multiple clips — potentially gigabytes — through ranged R2 reads. It gets
    // the same dedicated-poller treatment as bid_board_ingest / ai_report_generation so it can't starve the
    // main poller's email/domain-event/delivery jobs behind a video upload.
    const { queries } = installPool(claimRouter(() => []));

    await pollGlassesWalkthroughForwardJobs();

    const claim = queries.find(([sql]) => sql.includes("SELECT * FROM public.job_queue"));
    expect(claim![0]).toContain("job_type = 'glasses_walkthrough_forward'");
    expect(claim![0]).not.toContain("NOT IN"); // only-this-type, not exclude-these-types
    expect(claim![1]).toEqual([1]); // GLASSES_WALKTHROUGH_FORWARD_CONCURRENCY — one forward at a time
  });

  it("pollGlassesWalkthroughForwardJobs skips a tick that lands while a forward is still in flight", async () => {
    // GUARD on the reentrancy guard. This poller is on the same interval as every other one, and a single
    // forward routinely outlives many ticks — it relays a walk's clips (gigabytes) through ranged R2 reads
    // and multipart PUTs. Without the guard each tick would open its own claim transaction, and because
    // the claim marks rows 'processing' rather than locking them for the run, the concurrency-of-1 that
    // keeps several multi-GB uploads from running at once would be a comment rather than a fact.
    let releaseClaim!: () => void;
    let announceClaimEntered!: () => void;
    const claimHeld = new Promise<void>((resolve) => {
      releaseClaim = resolve;
    });
    // Awaited before the second tick fires, so this pins the guard rather than the scheduler: without it
    // the second call could win purely by getting there first, and the case would pass on a poller that
    // has no guard at all.
    const claimEntered = new Promise<void>((resolve) => {
      announceClaimEntered = resolve;
    });
    const { queries } = installPool(async (sql: string) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
      if (sql.includes("SELECT * FROM public.job_queue")) {
        announceClaimEntered();
        await claimHeld; // hold the first tick inside its claim transaction
        return { rows: [] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    const inFlight = pollGlassesWalkthroughForwardJobs();
    await claimEntered;
    // The second tick must return without touching the DB at all — not queue behind the first.
    await pollGlassesWalkthroughForwardJobs();
    expect(queries.filter(([sql]) => sql.includes("SELECT * FROM public.job_queue"))).toHaveLength(1);

    releaseClaim();
    await inFlight;

    // …and the guard is released afterwards, so the NEXT interval tick claims normally.
    await pollGlassesWalkthroughForwardJobs();
    expect(queries.filter(([sql]) => sql.includes("SELECT * FROM public.job_queue"))).toHaveLength(2);
  });
});
