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

function payloadJson() {
  return JSON.stringify({
    walkId: "walk-1",
    dealId: "00000000-0000-0000-0000-0000000000d1",
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
  const calls: Array<{ url: string }> = [];
  const fetchImpl = vi.fn(async (url: string, init: any) => {
    calls.push({ url });
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
    await db.exec(`
      CREATE TABLE public.job_queue (
        id bigserial PRIMARY KEY, job_type text NOT NULL, payload jsonb NOT NULL, office_id uuid,
        status text NOT NULL, last_error text, attempts integer NOT NULL DEFAULT 0,
        max_attempts integer NOT NULL DEFAULT 10, created_at timestamptz NOT NULL DEFAULT now()
      );
      INSERT INTO public.job_queue (job_type, payload, status)
      VALUES ('glasses_walkthrough_forward', '${payloadJson()}'::jsonb, 'processing');
    `);
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

  async function storedPayload(db: PGlite): Promise<Record<string, any>> {
    const result = (await db.query("SELECT payload FROM public.job_queue WHERE id = 1")) as any;
    return result.rows[0].payload;
  }

  const deps = (client: any, fetchImpl: any) => ({
    db: client,
    fetchImpl: fetchImpl as any,
    baseUrl: SCOPE_BASE_URL,
    token: "not-a-real-scope-service-token-9f3c",
    downloadRange: vi.fn(async () => Buffer.from("x")),
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
    expect(afterCrash.scopeCreatePendingRef).toBe("trockcrm:glasses-walkthrough:walk-1");
    expect(afterCrash.scopeWalkthroughId).toBeUndefined();

    // Attempt 2: redelivered verbatim from the table. No second create; a dead letter a human can act on.
    const second = makeScopeFetch();
    const result = await handleGlassesWalkthroughForward(afterCrash, null, deps(makeClient(db), second.fetchImpl));
    expect(second.calls.filter((c) => c.url === CREATE_URL)).toHaveLength(0);
    expect(result).toEqual({ status: "dead", error: expect.stringContaining("trockcrm:glasses-walkthrough:walk-1") });
  });

  it("removes the pending marker from the real row when TROCK Scope answered and refused", async () => {
    const db = await seed();
    const { fetchImpl } = makeScopeFetch({ createStatus: 401, createBody: { error: "unauthorized" } });

    await expect(
      handleGlassesWalkthroughForward(await storedPayload(db), null, deps(makeClient(db), fetchImpl)),
    ).rejects.toThrow(/walkthrough create failed/);

    const payload = await storedPayload(db);
    expect("scopeCreatePendingRef" in payload).toBe(false);
    expect(payload.walkId).toBe("walk-1"); // `payload - 'key'` must not disturb anything else
  });
});
