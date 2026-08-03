import { afterEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { handleGlassesWalkthroughForward } from "../../src/jobs/glasses-walkthrough-forward.js";

// The create/checkpoint marker is three hand-written jsonb statements against job_queue.payload, one of
// which composes two operators in a single SET (`jsonb_set(...) - 'key'`). The unit suite exercises the
// handler's DECISIONS through a fake db and would happily pass on SQL Postgres rejects outright — so this
// runs the real handler against a real Postgres and asserts on the row it actually leaves behind. It also
// re-delivers the payload READ BACK FROM THE TABLE, which is the only way to prove the retry logic sees
// what the queue would really hand it.

const SCOPE_BASE_URL = "https://scope.example.com";
const CREATE_URL = `${SCOPE_BASE_URL}/api/walkthroughs`;

const DEAL_A = "00000000-0000-0000-0000-0000000000d1";
const DEAL_B = "00000000-0000-0000-0000-0000000000d2";
/** Spelled out rather than imported from the job, so a change to the derivation has to be restated here —
 *  this value is what a human reconciling by hand types into TROCK Scope, and a test that derives it the
 *  same way the code does would agree with any shape at all, including one that drops the deal again. */
const EXTERNAL_REF_DEAL_A = `trockcrm:glasses-walkthrough:walk-1:deal:${DEAL_A}`;

function payloadJson(dealId: string = DEAL_A) {
  return JSON.stringify({
    walkId: "walk-1",
    dealId,
    projectId: null,
    title: "North wing walkthrough",
    siteLabel: "Building A",
    capturedAt: "2026-07-30T15:04:00.000Z",
    capturedByUserId: "00000000-0000-0000-0000-0000000000a1",
    officeSlug: "test",
    artifacts: [
      {
        fileId: "f0",
        idempotencyKey: "a0",
        kind: "video",
        r2Key: "k0",
        mimeType: "video/mp4",
        originalFilename: "clip-0.mp4",
        fileSizeBytes: 10,
        capturedAtMs: 0,
      },
    ],
  });
}

/** Answers the create plus TROCK Scope's clip-upload sequence and the raw R2 part PUT. */
function makeScopeFetch(overrides: { createStatus?: number; createBody?: Record<string, any> } = {}) {
  const calls: Array<{ url: string; body: any }> = [];
  const fetchImpl = vi.fn(async (url: string, init: any) => {
    calls.push({ url, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    if (url === CREATE_URL) {
      return new Response(
        JSON.stringify(overrides.createBody ?? { walkthrough: { id: "8f1c0a6e-1111-4222-8333-444455556666" } }),
        { status: overrides.createStatus ?? 201 },
      );
    }
    if (/\/clips$/.test(url)) {
      return new Response(
        JSON.stringify({ clipId: "clip-1", uploadId: "upload-1", partSize: 32 * 1024 * 1024, partCount: 1 }),
        { status: 201 },
      );
    }
    if (/\/parts$/.test(url)) {
      const partNumbers = JSON.parse(init.body).partNumbers as number[];
      return new Response(
        JSON.stringify({ parts: partNumbers.map((n) => ({ partNumber: n, url: `https://r2.example.com/part-${n}` })) }),
        { status: 200 },
      );
    }
    if (/\/complete$/.test(url)) {
      return new Response(JSON.stringify({ outcome: "uploaded" }), { status: 200 });
    }
    if (url.startsWith("https://r2.example.com/part-")) {
      return new Response(null, { status: 200, headers: new Headers({ etag: '"etag-1"' }) });
    }
    throw new Error(`Unexpected fetch to ${url}`);
  });
  return { fetchImpl, calls };
}

/**
 * `office_test.glasses_walkthroughs` — the per-office read model migration 0214 adds, which the handler now
 * stamps the TROCK Scope walkthrough id into so the CRM deal page can stop saying "processing".
 *
 * Present in this suite's seed because it is part of the schema the handler runs against: the payloads here
 * carry `officeSlug: "test"`, so the stamp addresses `office_test`. Only the columns the stamp touches, plus
 * the (deal_id, walk_id) key it matches on — the shipped DDL, FKs included, is executed in
 * server/tests/migrations/0214-glasses-walkthroughs.runtime.test.ts.
 */
async function seedTenantReadModel(db: PGlite) {
  await db.exec(`
    CREATE SCHEMA IF NOT EXISTS office_test;
    CREATE TABLE IF NOT EXISTS office_test.glasses_walkthroughs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      deal_id uuid NOT NULL,
      walk_id varchar(100) NOT NULL,
      scope_walkthrough_id uuid,
      captured_at timestamptz NOT NULL,
      captured_by_user_id uuid,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS glasses_walkthroughs_deal_walk_uidx
      ON office_test.glasses_walkthroughs (deal_id, walk_id);
  `);
}

/** The row `ingestGlassesWalkthrough` writes in the same transaction as the forward job it enqueues. */
async function seedWalkRow(db: PGlite, dealId: string, walkId = "walk-1") {
  await db.query(
    `INSERT INTO office_test.glasses_walkthroughs (deal_id, walk_id, captured_at)
     VALUES ($1, $2, '2026-07-30T15:04:00.000Z')`,
    [dealId, walkId],
  );
}

async function storedScopeId(db: PGlite, dealId: string, walkId = "walk-1"): Promise<string | null> {
  const result = (await db.query(
    `SELECT scope_walkthrough_id FROM office_test.glasses_walkthroughs WHERE deal_id = $1 AND walk_id = $2`,
    [dealId, walkId],
  )) as any;
  return result.rows[0]?.scope_walkthrough_id ?? null;
}

describe("glasses_walkthrough_forward create checkpoint (real SQL)", () => {
  let pg: PGlite | null = null;
  afterEach(async () => {
    await pg?.close();
    pg = null;
  });

  async function seed() {
    const db = new PGlite();
    pg = db;
    // DDL and seed row are separate statements so the payload can be BOUND rather than interpolated.
    // Splicing JSON into SQL text puts every quote and backslash in the fixture one edit away from either
    // a syntax error or a silently different row — and a seed that lies is worse than no seed at all in a
    // suite whose entire purpose is asserting on what really landed in the column.
    await db.exec(`
      CREATE TABLE public.job_queue (
        id bigserial PRIMARY KEY, job_type text NOT NULL, payload jsonb NOT NULL, office_id uuid,
        status text NOT NULL, last_error text, attempts integer NOT NULL DEFAULT 0,
        max_attempts integer NOT NULL DEFAULT 10, created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await seedTenantReadModel(db);
    await db.query(
      `INSERT INTO public.job_queue (job_type, payload, status)
       VALUES ('glasses_walkthrough_forward', $1::jsonb, 'processing')`,
      [payloadJson()],
    );
    return db;
  }

  /** The real client, optionally failing ONE statement so a mid-window crash can be reproduced without
   *  killing the test process. Everything else still executes against Postgres. */
  function makeClient(db: PGlite, failOn?: RegExp) {
    return {
      query: (sql: string, params?: unknown[]) => {
        if (failOn?.test(sql)) return Promise.reject(new Error("Connection terminated unexpectedly"));
        return db.query(sql, params as never[]) as any;
      },
    };
  }

  async function storedPayload(db: PGlite, id = 1): Promise<Record<string, any>> {
    const result = (await db.query("SELECT payload FROM public.job_queue WHERE id = $1", [id])) as any;
    return result.rows[0].payload;
  }

  const deps = (client: any, fetchImpl: any) => ({
    db: client,
    fetchImpl: fetchImpl as any,
    baseUrl: SCOPE_BASE_URL,
    token: "not-a-real-scope-service-token-9f3c",
    // Returns the range's true byte count. A fixed stub under-delivers against the 10-byte artifact above,
    // and the handler now (correctly) refuses to PUT a part it could not fully read.
    downloadRange: vi.fn(async (_k: string, start: number, end: number) => Buffer.alloc(end - start + 1, 0x61)),
  });

  it("leaves the id checkpointed and the pending marker gone — one statement, real jsonb", async () => {
    const db = await seed();
    const { fetchImpl } = makeScopeFetch();
    await handleGlassesWalkthroughForward(await storedPayload(db), null, deps(makeClient(db), fetchImpl));

    const payload = await storedPayload(db);
    expect(payload.scopeWalkthroughId).toBe("8f1c0a6e-1111-4222-8333-444455556666");
    expect("scopeCreatePendingRef" in payload).toBe(false);
    // The rest of the payload has to survive the jsonb_set/`-` composition untouched.
    expect(payload.walkId).toBe("walk-1");
    expect(payload.artifacts).toHaveLength(1);
  });

  it("keys every payload write on (walkId, dealId) — a walkId alone belongs to no single walk", async () => {
    // walkId is minted on the PHONE and nothing makes it unique across deals, which the ingress side
    // already had to fix (migration 0211 indexes the pair, and findGlassesWalkthroughForwardJobState
    // matches on it). These three statements are the other half of that: keyed on walkId alone, the same
    // walk completed against two deals makes each of these UPDATEs hit BOTH rows. The id checkpoint is the
    // one that costs money — deal B's payload inherits deal A's remote walkthrough id, so B's clips upload
    // into A's walkthrough and A's scope comes back carrying B's site. The marker writes are only slightly
    // kinder: B dead-letters on a create it never sent, or has its own marker cleared under it.
    const db = await seed();
    await db.query(
      `INSERT INTO public.job_queue (job_type, payload, status)
       VALUES ('glasses_walkthrough_forward', $1::jsonb, 'pending')`,
      [payloadJson(DEAL_B)],
    );

    const { fetchImpl } = makeScopeFetch();
    await handleGlassesWalkthroughForward(await storedPayload(db), null, deps(makeClient(db), fetchImpl));

    // Deal A settled…
    const dealA = await storedPayload(db, 1);
    expect(dealA.scopeWalkthroughId).toBe("8f1c0a6e-1111-4222-8333-444455556666");
    // …and deal B's row, which shares only a walkId, is untouched.
    const dealB = await storedPayload(db, 2);
    expect(dealB.dealId).toBe(DEAL_B);
    expect(dealB.scopeWalkthroughId).toBeUndefined();
    expect("scopeCreatePendingRef" in dealB).toBe(false);
  });

  it("sends a DIFFERENT externalRef for each deal the same physical walk is filed against", async () => {
    // The other half of the (walkId, dealId) scoping, on the wire rather than in the payload. TROCK Scope
    // persists externalRef under a UNIQUE constraint and answers a repeat create with the EXISTING
    // walkthrough, so two rows that legitimately describe the same walk against two deals must not agree
    // on this string — if they do, deal B's clips are uploaded into deal A's remote walkthrough (whose
    // dealUuid still names A) and the extracted scope is filed against a job it does not describe.
    // Driven off the REAL rows: both payloads are read back from job_queue exactly as the queue would
    // deliver them, so the refs are derived from what is actually stored, not from a hand-built object.
    //
    // Seeded 'processing' rather than 'pending' because THIS test runs the handler against the row: the
    // queue claims a row before invoking a handler, so a handler never executes against a pending one.
    // The checkpoint statements are scoped `AND status = 'processing'` — that predicate is what keeps a
    // handler's writes on its own row instead of on any other row sharing (walkId, dealId) — so a pending
    // fixture here would describe a state that cannot occur.
    const db = await seed();
    await db.query(
      `INSERT INTO public.job_queue (job_type, payload, status)
       VALUES ('glasses_walkthrough_forward', $1::jsonb, 'processing')`,
      [payloadJson(DEAL_B)],
    );

    const a = makeScopeFetch();
    await handleGlassesWalkthroughForward(await storedPayload(db, 1), null, deps(makeClient(db), a.fetchImpl));
    const b = makeScopeFetch();
    await handleGlassesWalkthroughForward(await storedPayload(db, 2), null, deps(makeClient(db), b.fetchImpl));

    const refA = a.calls.find((c) => c.url === CREATE_URL)!.body.externalRef;
    const refB = b.calls.find((c) => c.url === CREATE_URL)!.body.externalRef;
    expect(refA).toBe(EXTERNAL_REF_DEAL_A);
    expect(refB).toBe(`trockcrm:glasses-walkthrough:walk-1:deal:${DEAL_B}`);
    expect(refA).not.toBe(refB);
  });

  it("refuses to create when the marker UPDATE really does match no row", async () => {
    // The unit suite can only assert that the handler believes a fake's row count. This runs the actual
    // `UPDATE … RETURNING id` against Postgres with a walkId no row carries — the shape of a payload
    // delivered from somewhere other than the row it names (hand-edited mid-reconciliation, or a row a
    // cleanup removed). Postgres reports SUCCESS and zero rows, which is why RETURNING is the only thing
    // that can tell the two apart.
    const db = await seed();
    const { fetchImpl, calls } = makeScopeFetch();
    const payload = { ...(await storedPayload(db)), walkId: "walk-that-no-row-carries" };

    await expect(
      handleGlassesWalkthroughForward(payload, null, deps(makeClient(db), fetchImpl)),
    ).rejects.toThrow(/matched no job_queue row/);

    expect(calls).toHaveLength(0);
    // And the real row is untouched — no marker was written to some other walk's payload.
    expect("scopeCreatePendingRef" in (await storedPayload(db))).toBe(false);
  });

  it("survives a crash between the create and the checkpoint without creating a second walkthrough", async () => {
    const db = await seed();

    // Attempt 1: the remote create lands, then the checkpoint write dies.
    const first = makeScopeFetch();
    await expect(
      handleGlassesWalkthroughForward(
        await storedPayload(db),
        null,
        deps(makeClient(db, /\{scopeWalkthroughId\}/), first.fetchImpl),
      ),
    ).rejects.toThrow(/Connection terminated/);
    expect(first.calls.filter((c) => c.url === CREATE_URL)).toHaveLength(1);

    // The row itself now carries the evidence — this is the state a redelivery actually reads.
    const afterCrash = await storedPayload(db);
    expect(afterCrash.scopeCreatePendingRef).toBe(EXTERNAL_REF_DEAL_A);
    expect(afterCrash.scopeWalkthroughId).toBeUndefined();

    // Attempt 2: redelivered verbatim from the table. No second create; a dead letter a human can act on.
    const second = makeScopeFetch();
    const result = await handleGlassesWalkthroughForward(afterCrash, null, deps(makeClient(db), second.fetchImpl));
    expect(second.calls.filter((c) => c.url === CREATE_URL)).toHaveLength(0);
    expect(result).toEqual({ status: "dead", error: expect.stringContaining(EXTERNAL_REF_DEAL_A) });
  });

  it("removes the pending marker from the real row when TROCK Scope answered and refused", async () => {
    const db = await seed();
    const { fetchImpl } = makeScopeFetch({ createStatus: 401, createBody: { error: "unauthorized" } });

    await expect(
      handleGlassesWalkthroughForward(await storedPayload(db), null, deps(makeClient(db), fetchImpl)),
    ).rejects.toThrow(/refused before it created anything/);

    const payload = await storedPayload(db);
    expect("scopeCreatePendingRef" in payload).toBe(false);
    expect(payload.walkId).toBe("walk-1"); // `payload - 'key'` must not disturb anything else
  });

  it("KEEPS the pending marker when a gateway answers 502, which does not prove anything", async () => {
    // The distinction that matters: a 4xx is TROCK Scope's own validation/auth path answering before
    // it inserted anything. A 5xx is very often not TROCK Scope answering at all — it is a proxy
    // inventing a status because the app behind it went quiet, which happens just as readily AFTER a
    // committed INSERT (response lost, gateway timed out mid-reply) as before one. Clearing the
    // marker on that hands the next attempt a clean slate to create a duplicate walkthrough and a
    // second billed extraction.
    const db = await seed();
    const { fetchImpl } = makeScopeFetch({ createStatus: 502, createBody: { error: "bad gateway" } });

    await expect(
      handleGlassesWalkthroughForward(await storedPayload(db), null, deps(makeClient(db), fetchImpl)),
    ).rejects.toThrow(/does not prove whether a walkthrough was created/);

    const payload = await storedPayload(db);
    expect(payload.scopeCreatePendingRef).toBe(EXTERNAL_REF_DEAL_A);
  });

  it("dead-letters rather than re-creating after an ambiguous 503", async () => {
    // The marker is only worth keeping if something downstream acts on it. End to end: a 503 leaves
    // it set, and the redelivered payload must refuse to create a second time.
    const db = await seed();
    const gateway = makeScopeFetch({ createStatus: 503, createBody: { error: "unavailable" } });
    await expect(
      handleGlassesWalkthroughForward(await storedPayload(db), null, deps(makeClient(db), gateway.fetchImpl)),
    ).rejects.toThrow();

    const retry = makeScopeFetch();
    const result = await handleGlassesWalkthroughForward(
      await storedPayload(db),
      null,
      deps(makeClient(db), retry.fetchImpl),
    );
    expect(retry.calls.filter((c) => c.url === CREATE_URL)).toHaveLength(0);
    expect(result).toEqual({ status: "dead", error: expect.stringContaining(EXTERNAL_REF_DEAL_A) });
  });

  // ── The four payload writes, when the DATABASE is the thing that stops answering ──────────────────
  //
  // Every case above kills a statement with a REJECTION, which is the polite failure. The one this
  // handler cannot survive is the impolite one: an UPDATE parked behind another transaction's row lock,
  // or issued down a pooled socket that was accepted and went quiet. That promise never settles, so the
  // handler never returns — and because this job runs on a dedicated poller with a reentrancy guard and a
  // concurrency of one (queue.ts), the guard is held for the life of the PROCESS and every later
  // walkthrough forward goes unclaimed. Worse, `processJob` keeps renewing this attempt's lease while it
  // waits, so the expired-lease sweep cannot recover the row either: its heartbeat stays fresh forever.
  //
  // These four cases are one per write, because the four do NOT fail in the same direction, and the
  // direction is the whole point:
  //   • the pre-create marker must stop the create (an unrecorded create is a duplicate walkthrough),
  //   • the checkpoint must never LOOK like it succeeded (it is the only thing that prevents a duplicate),
  //   • the marker retraction is best-effort and must stay best-effort,
  //   • the pending-artifacts reconciliation must never resolve `null`, because `null` completes the job.
  //
  // A hanging fake is the whole point: with no ceiling these do not fail, they never return at all.

  /**
   * A pool-shaped adapter — `connect()` hands out a DISTINCT checkout with its own `release()` — so a case
   * can see both halves of what bounding a write has to mean: stop waiting, AND destroy the connection the
   * abandoned statement is still sitting on. A deadline raced against a bare `query` does only the first;
   * pg holds the checked-out slot until the statement settles, which for a lock-blocked UPDATE is never,
   * so the leak would simply be relabelled. Pool-level `query` is a separate surface here for the same
   * reason it is in the dead-letter suite: a statement issued on it owns a connection nobody holds a
   * handle to, and nothing can ever destroy that.
   */
  function makePool(db: PGlite, hangOn: RegExp) {
    const checkouts: Array<{ sawHungStatement: boolean; released: boolean; releasedWith: unknown }> = [];
    const poolLevelQueries: string[] = [];
    const pool = {
      query: (sql: string, params?: unknown[]) => {
        poolLevelQueries.push(sql);
        if (hangOn.test(sql)) return new Promise<never>(() => {});
        return db.query(sql, params as never[]) as any;
      },
      connect: async () => {
        const checkout = { sawHungStatement: false, released: false, releasedWith: undefined as unknown };
        checkouts.push(checkout);
        return {
          query: (sql: string, params?: unknown[]) => {
            if (hangOn.test(sql)) {
              checkout.sawHungStatement = true;
              return new Promise<never>(() => {}); // the lock-blocked / dead-socket write
            }
            return db.query(sql, params as never[]) as any;
          },
          release: (err?: unknown) => {
            checkout.released = true;
            checkout.releasedWith = err;
          },
        };
      },
    };
    return { pool, checkouts, poolLevelQueries };
  }

  /**
   * The outcome of `work`, or the literal string "never settled" if it does not answer within `ms`.
   *
   * Written this way deliberately. An unbounded write does not make these cases FAIL, it makes them never
   * return, and a bare `await` would report that as a vitest timeout — "this test was slow", where the
   * defect is "the poller is wedged until someone restarts the worker". Returning a value the assertion
   * can name keeps the red honest.
   */
  async function outcomeWithin<T>(work: Promise<T>, ms: number): Promise<T | Error | "never settled"> {
    return Promise.race([
      work.then(
        (value) => value,
        (err) => (err instanceof Error ? err : new Error(String(err))),
      ),
      new Promise<"never settled">((resolve) => setTimeout(() => resolve("never settled"), ms)),
    ]);
  }

  /** The one hung checkout, asserted to exist exactly once. */
  function hungCheckout(checkouts: Array<{ sawHungStatement: boolean; releasedWith: unknown }>) {
    const hung = checkouts.filter((c) => c.sawHungStatement);
    expect(hung).toHaveLength(1);
    return hung[0];
  }

  it("bounds the pre-create marker write and never sends the create when it stalls", async () => {
    // Fail-CLOSED, and it is the strictest of the four: the marker is written BEFORE the create precisely
    // so that a death anywhere after it is recoverable. A stalled marker write whose wait was abandoned
    // must therefore stop the create outright — proceeding would put a remote walkthrough on the wire with
    // the entire duplicate-prevention scheme disarmed, which is the exact state this marker exists to make
    // impossible. Whether the UPDATE eventually lands is unknown and does not matter: no create went out,
    // so both readings of the row are safe (a surviving marker costs one spurious dead letter a human
    // clears in a minute; a missing one costs nothing at all).
    const db = await seed();
    const { pool, checkouts } = makePool(db, /\{scopeCreatePendingRef\}/);
    const { fetchImpl, calls } = makeScopeFetch();

    const outcome = await outcomeWithin(
      handleGlassesWalkthroughForward(await storedPayload(db), null, {
        ...deps(pool, fetchImpl),
        checkpointWriteTimeoutMs: 25,
      }),
      1_000,
    );

    expect(outcome).toBeInstanceOf(Error);
    expect(calls).toHaveLength(0); // not one request reached TROCK Scope
    expect(hungCheckout(checkouts).releasedWith).toBeInstanceOf(Error); // destroyed, not returned poisoned
  });

  it("bounds the id checkpoint and reports the stall as a FAILURE, never as a settled create", async () => {
    // The one write where a timeout mistaken for success is worse than the stall it replaced. The
    // checkpoint is what a later attempt reads to reuse the walkthrough it already has; a stall that
    // resolved quietly would let this attempt carry on believing the id is durable, and the next
    // redelivery — reading a payload that records neither the id nor a resolved outcome — is exactly the
    // blind re-create (a second billed transcription and scope extraction) the whole mechanism exists to
    // prevent. So it must reject, and the marker must still be on the row afterwards so the retry
    // dead-letters into reconciliation rather than guessing.
    const db = await seed();
    const { pool, checkouts } = makePool(db, /\{scopeWalkthroughId\}/);
    const { fetchImpl, calls } = makeScopeFetch();

    const outcome = await outcomeWithin(
      handleGlassesWalkthroughForward(await storedPayload(db), null, {
        ...deps(pool, fetchImpl),
        checkpointWriteTimeoutMs: 25,
      }),
      1_000,
    );

    expect(outcome).toBeInstanceOf(Error);
    expect(calls.filter((c) => c.url === CREATE_URL)).toHaveLength(1); // the create DID go out
    const payload = await storedPayload(db);
    expect(payload.scopeWalkthroughId).toBeUndefined();
    expect(payload.scopeCreatePendingRef).toBe(EXTERNAL_REF_DEAL_A); // → the retry reconciles, never re-creates
    expect(hungCheckout(checkouts).releasedWith).toBeInstanceOf(Error);
  });

  it("bounds the best-effort marker retraction without letting it change the error the job reports", async () => {
    // The retraction is the one write that is ALLOWED to fail — the caller already swallows it, because a
    // surviving marker is the fail-closed direction (a spurious dead letter beats a duplicate). What it is
    // not allowed to do is hang: it runs on the failure path, i.e. exactly when the pool is already having
    // a bad minute, and an unbounded wait there holds the dedicated poller's guard just as permanently as
    // one on the happy path. Bounded, it goes back to being what it was always documented as — logged,
    // ignored, and invisible to the error the attempt actually reports.
    const db = await seed();
    const { pool, checkouts } = makePool(db, /payload - 'scopeCreatePendingRef'/);
    const { fetchImpl } = makeScopeFetch({ createStatus: 401, createBody: { error: "unauthorized" } });

    const outcome = await outcomeWithin(
      handleGlassesWalkthroughForward(await storedPayload(db), null, {
        ...deps(pool, fetchImpl),
        checkpointWriteTimeoutMs: 25,
      }),
      1_000,
    );

    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toMatch(/refused before it created anything/);
    expect(hungCheckout(checkouts).releasedWith).toBeInstanceOf(Error);
  });

  it("bounds the pending-artifacts reconciliation, and a stall must NOT read as 'nothing to reconcile'", async () => {
    // The sharpest direction of the four, because here the success value is `null`. This UPDATE runs after
    // every clip has been delivered, and its answer decides whether the handler returns a dead letter or
    // simply returns — and a plain return is how the queue writes `status = 'completed'`. A stall that
    // degraded to "no rows, nothing pending" would therefore complete the row, and the clips filed while
    // this forward was running would be forwarded by nobody: no dead letter, no alert, no retry, and the
    // walk comes back short with the only record of it gone. It must reject.
    const db = await seed();
    await db.query(`UPDATE public.job_queue SET payload = payload || $1::jsonb WHERE id = 1`, [
      JSON.stringify({
        scopeWalkthroughId: "8f1c0a6e-1111-4222-8333-444455556666",
        pendingArtifacts: [
          {
            fileId: "f1",
            idempotencyKey: "a1",
            kind: "photo",
            r2Key: "k1",
            mimeType: "image/jpeg",
            originalFilename: "still-1.jpg",
            fileSizeBytes: 10,
            capturedAtMs: 0,
          },
        ],
      }),
    ]);
    const { pool, checkouts } = makePool(db, /pendingArtifacts/);
    const { fetchImpl } = makeScopeFetch();

    const outcome = await outcomeWithin(
      handleGlassesWalkthroughForward(await storedPayload(db), null, {
        ...deps(pool, fetchImpl),
        checkpointWriteTimeoutMs: 25,
      }),
      1_000,
    );

    expect(outcome).toBeInstanceOf(Error); // NOT undefined, which the queue would record as 'completed'
    expect(hungCheckout(checkouts).releasedWith).toBeInstanceOf(Error);
    // The pending set is still on the row, so the retry (or a human) can still see what was missed.
    expect((await storedPayload(db)).pendingArtifacts).toHaveLength(1);
  });
  // ── The CRM read-model stamp (migration 0214) ────────────────────────────────────────────────────
  //
  // The payload checkpoint above is this JOB's private memory. `office_<slug>.glasses_walkthroughs` is the
  // same value in the place a human reads it from — the deal page's AI-walk panel, whose "processing" state
  // is exactly `scope_walkthrough_id IS NULL`. Without this write that column has no writer at all, so the
  // panel would say "processing" for every walk forever while the scope sat finished in TROCK Scope.

  it("stamps the TROCK Scope walkthrough id onto the deal's read-model row", async () => {
    const db = await seed();
    await seedWalkRow(db, DEAL_A);
    const { fetchImpl } = makeScopeFetch();

    await handleGlassesWalkthroughForward(await storedPayload(db), null, deps(makeClient(db), fetchImpl));

    expect(await storedScopeId(db, DEAL_A)).toBe("8f1c0a6e-1111-4222-8333-444455556666");
  });

  it("REGRESSION: stamps on a REDELIVERY that already carries the checkpoint, not only on the creating attempt", async () => {
    // The placement that makes a failed stamp recoverable. Inside the create block this would run exactly
    // once — on the one attempt that could not retry it — so a single failure would leave the panel reading
    // "processing" for a walk with a full scope, permanently, with nothing anywhere saying so. Outside it,
    // every attempt converges the row.
    const db = await seed();
    await seedWalkRow(db, DEAL_A);
    // A row whose create already landed and was checkpointed: the branch that skips the create entirely.
    await db.query(`UPDATE public.job_queue SET payload = payload || $1::jsonb WHERE id = 1`, [
      JSON.stringify({ scopeWalkthroughId: "8f1c0a6e-1111-4222-8333-444455556666" }),
    ]);
    const { fetchImpl, calls } = makeScopeFetch();

    await handleGlassesWalkthroughForward(await storedPayload(db), null, deps(makeClient(db), fetchImpl));

    expect(calls.some((call) => call.url === CREATE_URL)).toBe(false); // no second create was sent
    expect(await storedScopeId(db, DEAL_A)).toBe("8f1c0a6e-1111-4222-8333-444455556666");
  });

  it("stamps ONLY the row for this (deal, walk) pair", async () => {
    // walkId is minted on the phone and is not unique across deals — the same physical walk is legitimately
    // filed against two. Keyed on the walk alone, deal B's panel would show deal A's scope.
    const db = await seed();
    await seedWalkRow(db, DEAL_A);
    await seedWalkRow(db, DEAL_B);
    const { fetchImpl } = makeScopeFetch();

    await handleGlassesWalkthroughForward(await storedPayload(db), null, deps(makeClient(db), fetchImpl));

    expect(await storedScopeId(db, DEAL_A)).toBe("8f1c0a6e-1111-4222-8333-444455556666");
    expect(await storedScopeId(db, DEAL_B)).toBeNull();
  });

  it("forwards a walk that has NO read-model row, instead of stranding it", async () => {
    // A forward enqueued before 0214 shipped — production holds one such row — has nothing to stamp.
    // Refusing to forward it would strand a real walk over a read model it predates, so an UPDATE that
    // matches zero rows is not a failure here.
    const db = await seed();
    const { fetchImpl } = makeScopeFetch();

    await expect(
      handleGlassesWalkthroughForward(await storedPayload(db), null, deps(makeClient(db), fetchImpl)),
    ).resolves.toBeUndefined();
    expect((await storedPayload(db)).scopeWalkthroughId).toBe("8f1c0a6e-1111-4222-8333-444455556666");
  });

  it("REGRESSION: a failed stamp fails the ATTEMPT before any clip bytes move", async () => {
    // The stamp sits after the create block and before the clip loop precisely so failing it costs a retry
    // and nothing else: the next attempt reads the id back out of the payload, skips the create, and lands
    // on the stamp again. This also covers the deploy window — the worker does not run migrations, so a
    // worker build can briefly outrun the API that creates the table.
    const db = await seed();
    await seedWalkRow(db, DEAL_A);
    const { fetchImpl, calls } = makeScopeFetch();

    await expect(
      handleGlassesWalkthroughForward(
        await storedPayload(db),
        null,
        deps(makeClient(db, /glasses_walkthroughs/), fetchImpl),
      ),
    ).rejects.toThrow();

    // The create went out and IS checkpointed (so the retry will not buy a second scope extraction), but
    // not one clip byte was uploaded.
    expect((await storedPayload(db)).scopeWalkthroughId).toBe("8f1c0a6e-1111-4222-8333-444455556666");
    expect(calls.some((call) => /\/clips$/.test(call.url))).toBe(false);
  });
});
