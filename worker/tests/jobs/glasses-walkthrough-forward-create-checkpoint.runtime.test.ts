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
    const db = await seed();
    await db.query(
      `INSERT INTO public.job_queue (job_type, payload, status)
       VALUES ('glasses_walkthrough_forward', $1::jsonb, 'pending')`,
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
});
