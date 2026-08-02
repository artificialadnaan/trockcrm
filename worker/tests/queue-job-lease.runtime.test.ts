import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";

// The claim lease is three hand-written statements against job_queue — the claim's stamp, the renewal, and
// the expiry sweep — and none of them means anything on its own: the whole property is the ARITHMETIC
// between them, over a timestamp Postgres computes. The unit suite drives a fake db and would pass just as
// happily on a renewal that matched no row, a sweep whose predicate was inverted, or two statements
// disagreeing about which column is the clock. So this runs the real pollers against a real Postgres and
// asserts on the rows they actually leave behind, including the one the finding is about: a forward
// abandoned by a dead worker, which the dedicated poller can never see again because it selects only
// 'pending'.

let pg: PGlite | null = null;

// One PGlite instance behind both the pooled `query` and every checked-out client, because that is what
// the queue's own statements assume: the claim's BEGIN/COMMIT, the lease renewals and the outcome writes
// are separate checkouts in production and must be separate statements here too, against one database.
vi.mock("../src/db.js", () => ({
  pool: {
    query: (sql: string, params?: unknown[]) => pg!.query(sql, params as never[]),
    connect: async () => ({
      query: (sql: string, params?: unknown[]) => pg!.query(sql, params as never[]),
      release: () => {},
    }),
  },
}));

const {
  pollJobs,
  pollGlassesWalkthroughForwardJobs,
  recoverStaleJobs,
  registerJobHandler,
  __resetQueueStateForTest,
  __setJobLeaseRenewIntervalForTest,
} = await import("../src/queue.js");

const FORWARD_JOB = "glasses_walkthrough_forward";

async function seed(): Promise<PGlite> {
  const db = new PGlite();
  pg = db;
  await db.exec(`
    CREATE TABLE public.job_queue (
      id bigserial PRIMARY KEY, job_type text NOT NULL, payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      office_id uuid, status text NOT NULL, last_error text,
      attempts integer NOT NULL DEFAULT 0, max_attempts integer NOT NULL DEFAULT 10,
      run_after timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(),
      started_processing_at timestamptz, completed_at timestamptz
    );
  `);
  return db;
}

/** Insert one row in a named state. `leaseAgeSql` is an interval expression, so a test can describe a row
 *  as "claimed ten minutes ago and never heard from since" rather than compute a timestamp in JS and
 *  introduce a second clock. */
async function insertJob(
  db: PGlite,
  status: string,
  opts: { leaseAgeSql?: string; attempts?: number } = {},
): Promise<number> {
  const started = opts.leaseAgeSql ? `now() - interval '${opts.leaseAgeSql}'` : "NULL";
  const result = (await db.query(
    `INSERT INTO public.job_queue (job_type, status, attempts, started_processing_at)
     VALUES ($1, $2, $3, ${started}) RETURNING id`,
    [FORWARD_JOB, status, opts.attempts ?? 0],
  )) as any;
  return Number(result.rows[0].id);
}

async function readJob(db: PGlite, id: number): Promise<{ status: string; attempts: number; leaseMs: number | null }> {
  const result = (await db.query(
    `SELECT status, attempts, started_processing_at FROM public.job_queue WHERE id = $1`,
    [id],
  )) as any;
  const row = result.rows[0];
  const stamp = row.started_processing_at;
  return {
    status: String(row.status),
    attempts: Number(row.attempts),
    leaseMs: stamp == null ? null : new Date(stamp).getTime(),
  };
}

/** Poll a condition rather than sleeping a fixed span: the assertions below are about a renewal HAPPENING,
 *  and a fixed sleep would trade a real signal for a runner-speed gamble in both directions. */
async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for the expected row state`);
}

describe("job_queue claim lease (real SQL)", () => {
  beforeEach(() => {
    __resetQueueStateForTest();
  });

  afterEach(async () => {
    __setJobLeaseRenewIntervalForTest(60_000);
    await pg?.close();
    pg = null;
  });

  it("a forward abandoned by a dead worker is reclaimed by a later poll tick and actually re-run", async () => {
    // THE case. The row is 'processing' with a lease nobody has renewed — a worker that died mid-forward.
    // The dedicated poller selects 'pending' only, so on its own it can never see this row again, and the
    // startup sweep already ran (the worker restarted). Before the periodic sweep existed this walk simply
    // stopped being work: no dead letter, no alert, no retry, and a site visit that cannot be repeated.
    const db = await seed();
    const jobId = await insertJob(db, "processing", { leaseAgeSql: "10 minutes", attempts: 1 });
    let runs = 0;
    registerJobHandler(FORWARD_JOB, async () => {
      runs += 1;
    });

    await pollGlassesWalkthroughForwardJobs();
    expect(runs).toBe(0);
    expect((await readJob(db, jobId)).status).toBe("processing");

    // The main poller carries the sweep (it cannot claim this type — its own predicate excludes it), so a
    // tick that claims nothing still puts the abandoned row back.
    await pollJobs();
    expect((await readJob(db, jobId)).status).toBe("pending");

    await pollGlassesWalkthroughForwardJobs();
    expect(runs).toBe(1);
    expect((await readJob(db, jobId)).status).toBe("completed");
  });

  it("requeues an EXPIRED lease and leaves a renewed one alone", async () => {
    // The whole safety of a periodic sweep is this distinction. A forward legitimately runs for many
    // minutes — multi-GB uploads over an estimator's network — so a sweep that reads age alone hands a live
    // walk to a second worker, which is the duplicate transcription/extraction everything else in this seam
    // exists to prevent. Age is only safe to read because a live owner keeps re-stamping the column.
    const db = await seed();
    const abandoned = await insertJob(db, "processing", { leaseAgeSql: "10 minutes" });
    const live = await insertJob(db, "processing", { leaseAgeSql: "30 seconds" });
    const pending = await insertJob(db, "pending", { leaseAgeSql: "10 minutes" });

    await recoverStaleJobs();

    expect((await readJob(db, abandoned)).status).toBe("pending");
    // Renewed within the last renewal interval ⇒ its owner is alive ⇒ untouched, however long it has been
    // running.
    expect((await readJob(db, live)).status).toBe("processing");
    // And a row that was never claimed is not something the sweep has any business rewriting.
    expect((await readJob(db, pending)).status).toBe("pending");
  });

  it("keeps re-stamping a claimed row for as long as its handler is working", async () => {
    const db = await seed();
    const jobId = await insertJob(db, "pending");
    __setJobLeaseRenewIntervalForTest(20);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    registerJobHandler(FORWARD_JOB, async () => {
      await held; // a forward still moving bytes
    });

    const inFlight = pollGlassesWalkthroughForwardJobs();
    await waitUntil(async () => (await readJob(db, jobId)).status === "processing");
    const claimedAt = (await readJob(db, jobId)).leaseMs!;

    // The stamp MOVES while the handler holds the row, which is the only thing that distinguishes this row
    // from the abandoned one in the case above — they are otherwise identical rows in identical states.
    await waitUntil(async () => (await readJob(db, jobId)).leaseMs! > claimedAt);

    release();
    await inFlight;
    expect((await readJob(db, jobId)).status).toBe("completed");
  });

  it("a renewal cannot refresh a lease another claim has already moved on", async () => {
    // The zombie case, in real SQL. If the sweep requeues a row whose handler is merely wedged rather than
    // dead, and another worker claims it, the first handler is still holding a renewal timer. Unbound, its
    // renewals would keep the NEW owner's lease permanently fresh from the outside — so a row could be made
    // unreclaimable forever by the very process that lost it. The attempts guard is what makes the renewal
    // address one claim rather than one row.
    const db = await seed();
    const jobId = await insertJob(db, "pending");
    __setJobLeaseRenewIntervalForTest(20);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    registerJobHandler(FORWARD_JOB, async () => {
      await held;
    });

    const inFlight = pollGlassesWalkthroughForwardJobs();
    await waitUntil(async () => (await readJob(db, jobId)).status === "processing");

    // Stand in for "the sweep requeued this row and another worker re-claimed it": attempts moves past the
    // value the in-flight handler claimed, and the lease belongs to that other claim now.
    await db.query(
      `UPDATE public.job_queue SET attempts = attempts + 3, started_processing_at = now() - interval '1 hour'
       WHERE id = $1`,
      [jobId],
    );
    const stolenAt = (await readJob(db, jobId)).leaseMs!;

    // Several renewal intervals pass with the original handler still running…
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect((await readJob(db, jobId)).leaseMs).toBe(stolenAt);

    release();
    await inFlight;
    // …and its terminal write is attempt-bound too, so it cannot report an outcome for a claim it lost.
    expect((await readJob(db, jobId)).status).toBe("processing");
  });
});
