import { afterEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { handleGlassesWalkthroughForward } from "../../src/jobs/glasses-walkthrough-forward.js";

// The API can no longer dead-letter a forward job a worker has CLAIMED. Marking a `processing` row dead
// does not cancel the handler — it keeps uploading the list it read at claim time — but it does remove the
// row from 0213's live partial unique index immediately, so a completion retry can insert a REPLACEMENT
// beside a delivery that is still running. With more than one worker replica that is two handlers pushing
// clips into the same remote walkthrough, which this seam cannot reconcile.
//
// Instead the API records the complete list under `payload.pendingArtifacts` and changes nothing else, and
// the handler folds it in HERE, after its own delivery has stopped. That makes this file's subject a pair
// of hand-written jsonb statements — a union with DISTINCT ON, and a checkpoint predicate — so it runs the
// real handler against a real Postgres rather than asserting on a fake db that would accept SQL Postgres
// rejects.

const SCOPE_BASE_URL = "https://scope.example.com";
const DEAL = "00000000-0000-0000-0000-0000000000d1";
const WALK = "walk-1";
const CREATED_WALKTHROUGH_ID = "8f1c0a6e-1111-4222-8333-444455556666";
const CREATE_URL = `${SCOPE_BASE_URL}/api/walkthroughs`;

function artifact(index: number) {
  return {
    fileId: `f${index}`,
    idempotencyKey: `a${index}`,
    kind: "photo",
    r2Key: `k${index}`,
    mimeType: "image/jpeg",
    originalFilename: `still-${index}.jpg`,
    fileSizeBytes: 10,
    capturedAtMs: index,
  };
}

function payloadJson(opts: { artifacts: number[]; pendingArtifacts?: number[]; uncheckpointed?: boolean }) {
  const payload: Record<string, unknown> = {
    walkId: WALK,
    dealId: DEAL,
    projectId: null,
    title: "North wing walkthrough",
    siteLabel: "Building A",
    capturedAt: "2026-07-30T15:04:00.000Z",
    capturedByUserId: "00000000-0000-0000-0000-0000000000a1",
    officeSlug: "test",
    artifacts: opts.artifacts.map(artifact),
  };
  // Pre-checkpointed by DEFAULT so the handler goes straight to clip upload — the create path has its own
  // runtime suite, and reproducing it adds ways to fail for unrelated reasons. `uncheckpointed` opts back
  // in for the one test whose subject IS a checkpoint write.
  if (!opts.uncheckpointed) payload.scopeWalkthroughId = CREATED_WALKTHROUGH_ID;
  if (opts.pendingArtifacts) payload.pendingArtifacts = opts.pendingArtifacts.map(artifact);
  return JSON.stringify(payload);
}

/** Answers TROCK Scope's clip-upload sequence and the raw R2 part PUT. */
function makeScopeFetch() {
  return vi.fn(async (url: string, init: any) => {
    if (url === CREATE_URL) {
      return new Response(JSON.stringify({ walkthrough: { id: CREATED_WALKTHROUGH_ID } }), { status: 201 });
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
    if (/\/complete$/.test(url)) return new Response(JSON.stringify({ outcome: "uploaded" }), { status: 200 });
    if (url.startsWith("https://r2.example.com/part-")) {
      return new Response(null, { status: 200, headers: new Headers({ etag: '"etag-1"' }) });
    }
    throw new Error(`Unexpected fetch to ${url}`);
  });
}

describe("glasses_walkthrough_forward pending-artifact reconciliation (real SQL)", () => {
  let pg: PGlite | null = null;
  afterEach(async () => {
    await pg?.close();
    pg = null;
  });

  async function seed(rows: Array<{ payload: string; status: string }>) {
    const db = new PGlite();
    pg = db;
    await db.exec(`
      CREATE TABLE public.job_queue (
        id bigserial PRIMARY KEY, job_type text NOT NULL, payload jsonb NOT NULL, office_id uuid,
        status text NOT NULL, last_error text, attempts integer NOT NULL DEFAULT 0,
        max_attempts integer NOT NULL DEFAULT 10, created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    for (const row of rows) {
      await db.query(
        `INSERT INTO public.job_queue (job_type, payload, status)
         VALUES ('glasses_walkthrough_forward', $1::jsonb, $2)`,
        [row.payload, row.status],
      );
    }
    return db;
  }

  const client = (db: PGlite) => ({
    query: (sql: string, params?: unknown[]) => db.query(sql, params as never[]) as any,
  });

  const deps = (db: PGlite) => ({
    db: client(db),
    fetchImpl: makeScopeFetch() as any,
    baseUrl: SCOPE_BASE_URL,
    token: "not-a-real-scope-service-token-9f3c",
    downloadRange: vi.fn(async (_k: string, start: number, end: number) => Buffer.alloc(end - start + 1, 0x61)),
  });

  async function storedPayload(db: PGlite, id = 1): Promise<Record<string, any>> {
    const result = (await db.query("SELECT payload FROM public.job_queue WHERE id = $1", [id])) as any;
    return result.rows[0].payload;
  }

  it("REGRESSION: folds pendingArtifacts into artifacts and dead-letters ITSELF, once its own delivery has stopped", async () => {
    // The walk grew while this attempt was already uploading. The extras cannot reach TROCK Scope on this
    // attempt — a handler reads its list once, at claim time — so the row is taken out of the live index
    // HERE, where doing so cannot race a delivery, carrying the complete list for the replacement to
    // inherit.
    const db = await seed([{ payload: payloadJson({ artifacts: [1, 2], pendingArtifacts: [1, 2, 3] }), status: "processing" }]);

    const result = await handleGlassesWalkthroughForward(await storedPayload(db), null, deps(db));

    expect(result).toEqual({ status: "dead", error: expect.stringContaining(WALK) });
    const payload = await storedPayload(db);
    expect(payload.artifacts.map((a: any) => a.idempotencyKey)).toEqual(["a1", "a2", "a3"]);
    // Dropped in the same statement: a reader must not be able to mistake a settled reconciliation for an
    // open one.
    expect(payload.pendingArtifacts).toBeUndefined();
    // The message is the whole content of the operator's alert — it has to name the walk and the action.
    expect(result && "error" in result ? result.error : "").toContain("'pending'");
  });

  it("REGRESSION: the union keeps existing entries verbatim and appends only what is genuinely new", async () => {
    // Existing-wins, because a worker or a reconciling human may have edited an entry and a completion
    // retry has no better information than they did. Overlapping keys must not duplicate.
    const db = await seed([{ payload: payloadJson({ artifacts: [1, 2], pendingArtifacts: [2, 3] }), status: "processing" }]);

    await handleGlassesWalkthroughForward(await storedPayload(db), null, deps(db));

    const payload = await storedPayload(db);
    expect(payload.artifacts.map((a: any) => a.idempotencyKey)).toEqual(["a1", "a2", "a3"]);
  });

  it("GUARD: an ordinary forward with nothing to reconcile completes and leaves its payload alone", async () => {
    const db = await seed([{ payload: payloadJson({ artifacts: [1, 2] }), status: "processing" }]);

    const result = await handleGlassesWalkthroughForward(await storedPayload(db), null, deps(db));

    expect(result).toBeUndefined(); // falls through to the queue's own completed transition
    const payload = await storedPayload(db);
    expect(payload.artifacts.map((a: any) => a.idempotencyKey)).toEqual(["a1", "a2"]);
    expect(payload.pendingArtifacts).toBeUndefined();
  });

  it("REGRESSION: a handler whose row was re-claimed after a lost lease reconciles NOTHING", async () => {
    // `status = 'processing'` is not this handler's identity once lease recovery exists. A handler
    // that loses lease renewals while still uploading has its row requeued and RE-CLAIMED — back to
    // `processing`, with a higher `attempts` — and the old handler then matched the new claim. It
    // could fold and CLEAR `pendingArtifacts` under the new handler, which had captured the older
    // artifact list at claim time, sees no pending marker, and completes: the added clips silently
    // never forwarded. The old handler cannot even dead-letter to say so, because the queue's
    // terminal write is guarded on its own attempt.
    //
    // Attempt 2 holds the row; the stale attempt-1 handler must not touch it.
    const db = await seed([
      { payload: payloadJson({ artifacts: [1, 2], pendingArtifacts: [1, 2, 3] }), status: "processing" },
    ]);
    await db.query("UPDATE public.job_queue SET attempts = 2 WHERE id = 1");

    const result = await handleGlassesWalkthroughForward(await storedPayload(db), null, deps(db), {
      attempt: 1,
      maxAttempts: 10,
      isFinalAttempt: false,
    });

    // No self-supersede: this handler no longer owns the claim, so it reports ordinary success and
    // leaves the reconciliation to the attempt that does.
    expect(result).toBeUndefined();
    const payload = await storedPayload(db);
    expect(payload.pendingArtifacts.map((a: any) => a.idempotencyKey)).toEqual(["a1", "a2", "a3"]);
    expect(payload.artifacts.map((a: any) => a.idempotencyKey)).toEqual(["a1", "a2"]);
  });

  it("GUARD: the handler holding the current claim still reconciles", async () => {
    // The other side of the same predicate — a fix that simply stopped reconciling would pass the
    // test above and lose the feature.
    const db = await seed([
      { payload: payloadJson({ artifacts: [1, 2], pendingArtifacts: [1, 2, 3] }), status: "processing" },
    ]);
    await db.query("UPDATE public.job_queue SET attempts = 2 WHERE id = 1");

    const result = await handleGlassesWalkthroughForward(await storedPayload(db), null, deps(db), {
      attempt: 2,
      maxAttempts: 10,
      isFinalAttempt: false,
    });

    expect(result).toEqual({ status: "dead", error: expect.stringContaining(WALK) });
    expect((await storedPayload(db)).pendingArtifacts).toBeUndefined();
  });

  it("REGRESSION: checkpoints land ONLY on this handler's claimed row, never on a replacement for the same walk", async () => {
    // The checkpoint statements match on (job_type, walkId, dealId), which is NOT unique across a row and
    // its replacement — and they carry no LIMIT, so an unscoped UPDATE writes to every matching row. A
    // handler that is still creating and checkpointing would stamp its remote walkthrough id onto a
    // replacement row that has not run yet, handing a future attempt a checkpoint it never earned and
    // sending its clips into a walkthrough it did not create. Scoping to `status = 'processing'` is what
    // makes these statements this handler's own: a replacement inserted by any path arrives `pending`.
    //
    // Deliberately NOT pre-checkpointed, unlike the fixtures above — the create path has to actually run
    // for there to be a checkpoint write to misdirect.
    const db = await seed([
      { payload: payloadJson({ artifacts: [1], uncheckpointed: true }), status: "processing" },
      { payload: payloadJson({ artifacts: [9], uncheckpointed: true }), status: "pending" },
    ]);

    await handleGlassesWalkthroughForward(await storedPayload(db, 1), null, deps(db));

    // This handler's own row settled: id recorded, intent marker gone.
    const own = await storedPayload(db, 1);
    expect(own.scopeWalkthroughId).toBe(CREATED_WALKTHROUGH_ID);
    expect(own.scopeCreatePendingRef).toBeUndefined();

    // The replacement never ran, so it must carry NEITHER marker. Before the predicate it received both in
    // turn — first the pending ref, then the id — from a handler that was never working on its behalf.
    const replacement = await storedPayload(db, 2);
    expect(replacement.scopeWalkthroughId).toBeUndefined();
    expect(replacement.scopeCreatePendingRef).toBeUndefined();
    expect(replacement.artifacts.map((a: any) => a.idempotencyKey)).toEqual(["a9"]);
  });
});
