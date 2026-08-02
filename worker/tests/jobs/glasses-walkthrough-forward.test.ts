import { beforeEach, describe, expect, it, vi } from "vitest";
import { GLASSES_WALKTHROUGH_FORWARD_JOB, handleGlassesWalkthroughForward } from "../../src/jobs/glasses-walkthrough-forward.js";

function makeDb() {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params });
    return { rows: [] };
  });
  return { query, calls };
}

/**
 * A job_queue fake that actually APPLIES the handler's payload writes to a stored payload, so a test can
 * redeliver the row exactly as the queue would on the next attempt (`storedPayload()`), rather than
 * hand-writing what it assumes the row now looks like. That fidelity is the whole point for the
 * create/checkpoint crash window: the bug is precisely that the payload the queue redelivers does not
 * record that a create already went out.
 *
 * `failOn` blows one statement up mid-flight, which is how a crash inside that window is reproduced
 * without actually killing the test process.
 */
function makeJobQueueDb(initialPayload: Record<string, unknown>, opts: { failOn?: RegExp } = {}) {
  let stored: Record<string, unknown> = { ...initialPayload };
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params });
    if (opts.failOn?.test(sql)) throw new Error("Connection terminated unexpectedly");
    if (/\{scopeWalkthroughId\}/.test(sql)) {
      const { scopeCreatePendingRef: _dropped, ...rest } = stored;
      stored = { ...rest, scopeWalkthroughId: params![0] };
    } else if (/\{scopeCreatePendingRef\}/.test(sql)) {
      stored = { ...stored, scopeCreatePendingRef: params![0] };
    } else if (/payload - 'scopeCreatePendingRef'/.test(sql)) {
      const { scopeCreatePendingRef: _dropped, ...rest } = stored;
      stored = rest;
    }
    return { rows: [] };
  });
  return { query, calls, storedPayload: () => stored };
}

/** Shapes a Node/undici network rejection: `fetch` rejects with `TypeError: fetch failed` and hangs the
 *  real reason off `cause`, which is where the "never reached the server" vs "may have been processed"
 *  distinction actually lives. */
function networkError(code: string): TypeError {
  const err = new TypeError("fetch failed");
  (err as any).cause = Object.assign(new Error(`connect ${code}`), { code });
  return err;
}

const SCOPE_BASE_URL = "https://scope.example.com";
const CREATE_URL = `${SCOPE_BASE_URL}/api/walkthroughs`;

function makePayload(overrides: Record<string, unknown> = {}) {
  return {
    walkId: "walk-1",
    dealId: "deal-1",
    projectId: null,
    title: "North wing walkthrough",
    siteLabel: "Building A",
    capturedAt: "2026-07-30T15:04:00.000Z",
    capturedByUserId: "user-1",
    officeSlug: "dallas",
    artifacts: [
      {
        fileId: "file-1",
        idempotencyKey: "artifact-1",
        kind: "video",
        r2Key: "dallas/deals/deal-1/glasses-walkthroughs/walk-1/artifact-1.mp4",
        mimeType: "video/mp4",
        originalFilename: "clip-001.mp4",
        fileSizeBytes: 1024,
        capturedAtMs: 0,
      },
    ],
    ...overrides,
  };
}

/** A fetch fake that answers TROCK Scope's four-call clip-upload sequence plus the walkthrough create,
 *  and the raw R2 part PUT. Routes on method + URL shape so tests can override just what they care about. */
function makeScopeFetch(overrides: {
  createStatus?: number;
  createBody?: Record<string, any>;
  beginStatus?: number;
  beginBody?: Record<string, any>;
  signBody?: Record<string, any>;
  completeStatus?: number;
  completeBody?: Record<string, any>;
  putOk?: boolean;
  putEtag?: string | null;
} = {}) {
  const calls: Array<{ url: string; init: any }> = [];
  const fetchImpl = vi.fn(async (url: string, init: any) => {
    calls.push({ url, init });

    if (url.endsWith("/api/walkthroughs")) {
      return new Response(
        JSON.stringify(overrides.createBody ?? { walkthrough: { id: "scope-walkthrough-1" } }),
        { status: overrides.createStatus ?? 201 }
      );
    }
    if (/\/clips$/.test(url)) {
      return new Response(
        JSON.stringify(
          overrides.beginBody ?? {
            clipId: "clip-1",
            key: "walkthroughs/scope-walkthrough-1/clips/clip-1/original.mp4",
            uploadId: "upload-1",
            sequence: 1,
            partSize: 32 * 1024 * 1024,
            partCount: 1,
          }
        ),
        { status: overrides.beginStatus ?? 201 }
      );
    }
    if (/\/parts$/.test(url)) {
      const body = JSON.parse(init.body);
      const parts =
        overrides.signBody?.parts ??
        body.partNumbers.map((partNumber: number) => ({ partNumber, url: `https://r2.example.com/part-${partNumber}` }));
      return new Response(JSON.stringify({ parts }), { status: 200 });
    }
    if (/\/complete$/.test(url)) {
      return new Response(
        JSON.stringify(overrides.completeBody ?? { outcome: "uploaded", clipId: "clip-1", checksum: "abc", sizeBytes: 1024 }),
        { status: overrides.completeStatus ?? 200 }
      );
    }
    if (url.startsWith("https://r2.example.com/part-")) {
      const headers = new Headers();
      if (overrides.putEtag !== null) headers.set("etag", overrides.putEtag ?? '"etag-1"');
      return new Response(null, { status: overrides.putOk === false ? 500 : 200, headers });
    }
    throw new Error(`Unexpected fetch to ${url}`);
  });
  return { fetchImpl, calls };
}

describe("handleGlassesWalkthroughForward", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("creates the remote walkthrough, uploads the one clip's one part, and completes it", async () => {
    const db = makeDb();
    const { fetchImpl, calls } = makeScopeFetch();
    const downloadRange = vi.fn(async () => Buffer.from("bytes"));

    await handleGlassesWalkthroughForward(makePayload(), "office-1", {
      db,
      fetchImpl: fetchImpl as any,
      baseUrl: "https://scope.example.com",
      token: "shared-token",
      downloadRange,
    });

    expect(calls[0]!.url).toBe("https://scope.example.com/api/walkthroughs");
    expect(calls[0]!.init.headers.authorization).toBe("Bearer shared-token");
    const createdBody = JSON.parse(calls[0]!.init.body);
    expect(createdBody).toEqual({
      title: "North wing walkthrough",
      siteLabel: "Building A",
      dealUuid: "deal-1",
      officeSlug: "dallas",
      capturedBy: "user-1",
      externalRef: "trockcrm:glasses-walkthrough:walk-1",
    });

    // Checkpointed the remote walkthrough id back into THIS job row via jsonb_set, keyed on walkId. Match
    // the scopeWalkthroughId statement specifically: the pre-create marker is a jsonb_set write too.
    const checkpoint = db.calls.find((c) => /\{scopeWalkthroughId\}/.test(c.sql));
    expect(checkpoint).toBeDefined();
    expect(checkpoint!.params).toEqual(["scope-walkthrough-1", GLASSES_WALKTHROUGH_FORWARD_JOB, "walk-1"]);

    // Downloaded exactly the one part's byte range from OUR OWN R2 key.
    expect(downloadRange).toHaveBeenCalledWith(
      "dallas/deals/deal-1/glasses-walkthroughs/walk-1/artifact-1.mp4",
      0,
      1023
    );

    const completeCall = calls.find((c) => c.url.endsWith("/complete"));
    expect(JSON.parse(completeCall!.init.body)).toEqual({ parts: [{ partNumber: 1, etag: '"etag-1"' }] });
  });

  it("reuses a checkpointed scopeWalkthroughId instead of creating a second remote walkthrough", async () => {
    const db = makeDb();
    const { fetchImpl, calls } = makeScopeFetch();
    const downloadRange = vi.fn(async () => Buffer.from("bytes"));

    await handleGlassesWalkthroughForward(
      makePayload({ scopeWalkthroughId: "already-created" }),
      "office-1",
      { db, fetchImpl: fetchImpl as any, baseUrl: "https://scope.example.com", token: "t", downloadRange }
    );

    expect(calls.some((c) => c.url === "https://scope.example.com/api/walkthroughs")).toBe(false);
    expect(db.calls.some((c) => c.sql.includes("jsonb_set"))).toBe(false);
    const beginCall = calls.find((c) => /\/clips$/.test(c.url));
    expect(beginCall!.url).toContain("already-created");
  });

  it("splits more than 100 parts across multiple sign-parts requests (TROCK Scope's per-request ceiling)", async () => {
    const db = makeDb();
    const { fetchImpl, calls } = makeScopeFetch({
      beginBody: {
        clipId: "clip-1",
        key: "k",
        uploadId: "u",
        sequence: 1,
        partSize: 32 * 1024 * 1024,
        partCount: 150,
      },
    });
    const downloadRange = vi.fn(async () => Buffer.from("x"));

    await handleGlassesWalkthroughForward(
      makePayload({ artifacts: [{ ...makePayload().artifacts[0], fileSizeBytes: 150 * 32 * 1024 * 1024 }] }),
      "office-1",
      { db, fetchImpl: fetchImpl as any, baseUrl: "https://scope.example.com", token: "t", downloadRange }
    );

    const signCalls = calls.filter((c) => /\/parts$/.test(c.url));
    expect(signCalls).toHaveLength(2);
    expect(JSON.parse(signCalls[0]!.init.body).partNumbers).toHaveLength(100);
    expect(JSON.parse(signCalls[1]!.init.body).partNumbers).toHaveLength(50);
    expect(downloadRange).toHaveBeenCalledTimes(150);
  });

  it("treats a 409 duplicate_bytes completion as a non-fatal terminal outcome", async () => {
    const db = makeDb();
    const { fetchImpl } = makeScopeFetch({
      completeStatus: 409,
      completeBody: { outcome: "duplicate_bytes", clipId: "clip-1", duplicateOfClipId: "clip-0" },
    });
    const downloadRange = vi.fn(async () => Buffer.from("x"));

    await expect(
      handleGlassesWalkthroughForward(makePayload(), "office-1", {
        db,
        fetchImpl: fetchImpl as any,
        baseUrl: "https://scope.example.com",
        token: "t",
        downloadRange,
      })
    ).resolves.toBeUndefined();
  });

  it("throws (so job_queue retries) on a 409 that is NOT duplicate_bytes, instead of reporting success", async () => {
    // A 409 is only a non-fatal terminal outcome when TROCK Scope reports duplicate_bytes (the idempotency
    // case). Any other 409 body must throw so the job retries — treating it as success would let the
    // artifact loop move on, complete the job, and silently never land this clip in TROCK Scope.
    const db = makeDb();
    const { fetchImpl } = makeScopeFetch({
      completeStatus: 409,
      completeBody: { outcome: "conflict", clipId: "clip-1", reason: "some other conflict" },
    });
    const downloadRange = vi.fn(async () => Buffer.from("x"));

    await expect(
      handleGlassesWalkthroughForward(makePayload(), "office-1", {
        db,
        fetchImpl: fetchImpl as any,
        baseUrl: "https://scope.example.com",
        token: "t",
        downloadRange,
      })
    ).rejects.toThrow(/complete-clip failed/);
  });

  it("throws (so job_queue retries) on a 409 with no outcome field at all", async () => {
    const db = makeDb();
    const { fetchImpl } = makeScopeFetch({
      completeStatus: 409,
      completeBody: { clipId: "clip-1" },
    });
    const downloadRange = vi.fn(async () => Buffer.from("x"));

    await expect(
      handleGlassesWalkthroughForward(makePayload(), "office-1", {
        db,
        fetchImpl: fetchImpl as any,
        baseUrl: "https://scope.example.com",
        token: "t",
        downloadRange,
      })
    ).rejects.toThrow(/complete-clip failed/);
  });

  it("throws (so job_queue retries) when the walkthrough create call fails", async () => {
    const db = makeDb();
    const { fetchImpl } = makeScopeFetch({ createStatus: 500, createBody: { error: "boom" } });

    await expect(
      handleGlassesWalkthroughForward(makePayload(), "office-1", {
        db,
        fetchImpl: fetchImpl as any,
        baseUrl: "https://scope.example.com",
        token: "t",
        downloadRange: vi.fn(async () => Buffer.from("x")),
      })
    ).rejects.toThrow(/walkthrough create failed/);
  });

  it("throws when R2 returns no ETag for an uploaded part", async () => {
    const db = makeDb();
    const { fetchImpl } = makeScopeFetch({ putEtag: null });

    await expect(
      handleGlassesWalkthroughForward(makePayload({ scopeWalkthroughId: "already-created" }), "office-1", {
        db,
        fetchImpl: fetchImpl as any,
        baseUrl: "https://scope.example.com",
        token: "t",
        downloadRange: vi.fn(async () => Buffer.from("x")),
      })
    ).rejects.toThrow(/no ETag/);
  });

  it("dead-letters immediately (does not attempt a network call) when TROCK_SCOPE_BASE_URL is unset", async () => {
    const db = makeDb();
    const fetchImpl = vi.fn();

    const result = await handleGlassesWalkthroughForward(makePayload(), "office-1", {
      db,
      fetchImpl: fetchImpl as any,
      token: "t",
      baseUrl: undefined,
    });

    expect(result).toEqual({ status: "dead", error: expect.stringContaining("TROCK_SCOPE_BASE_URL") });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("dead-letters immediately when TROCK_SCOPE_SERVICE_TOKEN is unset", async () => {
    const db = makeDb();
    const fetchImpl = vi.fn();

    const result = await handleGlassesWalkthroughForward(makePayload(), "office-1", {
      db,
      fetchImpl: fetchImpl as any,
      baseUrl: "https://scope.example.com",
      token: undefined,
    });

    expect(result).toEqual({ status: "dead", error: expect.stringContaining("TROCK_SCOPE_SERVICE_TOKEN") });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a payload missing required fields rather than sending a partial request", async () => {
    await expect(
      handleGlassesWalkthroughForward({ walkId: "w" }, "office-1", {
        db: makeDb(),
        fetchImpl: vi.fn() as any,
        baseUrl: "https://scope.example.com",
        token: "t",
      })
    ).rejects.toThrow(/payload/);
  });

  it("uploads every artifact of a multi-clip walk under the SAME remote walkthrough", async () => {
    const db = makeDb();
    const { fetchImpl, calls } = makeScopeFetch();
    const downloadRange = vi.fn(async () => Buffer.from("x"));

    const payload = makePayload({
      artifacts: [
        { fileId: "f1", idempotencyKey: "a1", kind: "video", r2Key: "k1", mimeType: "video/mp4", originalFilename: "a.mp4", fileSizeBytes: 10, capturedAtMs: 0 },
        { fileId: "f2", idempotencyKey: "a2", kind: "audio", r2Key: "k2", mimeType: "audio/mp4", originalFilename: "b.m4a", fileSizeBytes: 10, capturedAtMs: 500 },
      ],
    });

    await handleGlassesWalkthroughForward(payload, "office-1", {
      db,
      fetchImpl: fetchImpl as any,
      baseUrl: "https://scope.example.com",
      token: "t",
      downloadRange,
    });

    const createCalls = calls.filter((c) => c.url === "https://scope.example.com/api/walkthroughs");
    expect(createCalls).toHaveLength(1); // one remote walkthrough, not one per clip
    const beginCalls = calls.filter((c) => /\/clips$/.test(c.url));
    expect(beginCalls).toHaveLength(2);
  });

  // ── Retry-safety of the remote create ────────────────────────────────────────────────────────────
  //
  // TROCK Scope's POST /walkthroughs has no idempotency key and no way to look a walkthrough up by
  // anything but its own uuid, so the ONLY thing standing between a mid-forward crash and a second
  // walkthrough (with a second paid transcription + scope extraction behind it) is what this job wrote
  // into its own payload before the call went out. These cases pin that contract down from both sides:
  // an unconfirmed create must never be retried blind, and a create TROCK Scope demonstrably never
  // performed must stay retryable.
  describe("remote-create retry safety", () => {
    /** A distinctive stand-in for TROCK_SCOPE_SERVICE_TOKEN (never the real secret), so the token-safety
     *  assertion below is actually meaningful rather than matching an incidental substring. */
    const FAKE_TOKEN = "not-a-real-scope-service-token-9f3c";
    const deps = (db: any, fetchImpl: any) => ({
      db,
      fetchImpl: fetchImpl as any,
      baseUrl: SCOPE_BASE_URL,
      token: FAKE_TOKEN,
      downloadRange: vi.fn(async () => Buffer.from("x")),
    });

    it("never creates a SECOND remote walkthrough when the checkpoint write dies right after a successful create", async () => {
      // Attempt 1: the create lands remotely, then the id checkpoint fails — the exact crash window.
      const db = makeJobQueueDb(makePayload(), { failOn: /\{scopeWalkthroughId\}/ });
      const first = makeScopeFetch();
      await expect(
        handleGlassesWalkthroughForward(db.storedPayload(), "office-1", deps(db, first.fetchImpl))
      ).rejects.toThrow(/Connection terminated/);
      expect(first.calls.filter((c) => c.url === CREATE_URL)).toHaveLength(1);

      // Attempt 2: job_queue redelivers the row's payload AS THE DB NOW HOLDS IT. A walkthrough may
      // exist in TROCK Scope under an id nobody recorded, so the only safe move is to stop.
      const db2 = makeJobQueueDb(db.storedPayload());
      const second = makeScopeFetch();
      const result = await handleGlassesWalkthroughForward(
        db2.storedPayload(),
        "office-1",
        deps(db2, second.fetchImpl)
      );

      expect(second.calls.filter((c) => c.url === CREATE_URL)).toHaveLength(0);
      expect(result).toEqual({ status: "dead", error: expect.stringContaining("walk-1") });
      expect((result as any).error).toMatch(/never (learned|confirmed)/i);
      // The dead letter has to tell a human how to reconcile, not just that something went wrong.
      expect((result as any).error).toContain("scopeWalkthroughId");
      // TOKEN SAFETY: the service token must never reach last_error / the alert email.
      expect((result as any).error).not.toContain(FAKE_TOKEN);
    });

    it("records the pending-create marker BEFORE the create request goes out, never after", async () => {
      // If the marker were written after the call, the crash window would still be wide open. Failing
      // the marker write must therefore also abort the create — losing a forward attempt is recoverable,
      // an untracked remote walkthrough is not.
      const db = makeJobQueueDb(makePayload(), { failOn: /\{scopeCreatePendingRef\}/ });
      const { fetchImpl, calls } = makeScopeFetch();

      await expect(
        handleGlassesWalkthroughForward(db.storedPayload(), "office-1", deps(db, fetchImpl))
      ).rejects.toThrow(/Connection terminated/);
      expect(calls).toHaveLength(0);
    });

    it("clears the pending-create marker when TROCK Scope ANSWERED and refused, so the job stays retryable", async () => {
      // A completed non-2xx response is positive evidence no walkthrough row exists (the create route
      // inserts and then answers 201; an error response comes from the error path instead). This is
      // today's most likely failure by far — TROCK Scope has no machine-auth middleware yet and 401s
      // every one of these calls — and it must NOT burn the job on a phantom duplicate hunt.
      const db = makeJobQueueDb(makePayload());
      const refused = makeScopeFetch({ createStatus: 401, createBody: { error: "unauthorized" } });
      await expect(
        handleGlassesWalkthroughForward(db.storedPayload(), "office-1", deps(db, refused.fetchImpl))
      ).rejects.toThrow(/walkthrough create failed/);
      expect(db.storedPayload().scopeCreatePendingRef).toBeUndefined();

      // …and the next attempt proceeds normally rather than dead-lettering.
      const retry = makeScopeFetch();
      await expect(
        handleGlassesWalkthroughForward(db.storedPayload(), "office-1", deps(db, retry.fetchImpl))
      ).resolves.toBeUndefined();
      expect(retry.calls.filter((c) => c.url === CREATE_URL)).toHaveLength(1);
      expect(db.storedPayload().scopeWalkthroughId).toBe("scope-walkthrough-1");
    });

    it("clears the pending-create marker when the connection was never established (TROCK Scope not deployed)", async () => {
      // ECONNREFUSED means nothing accepted the TCP connection, so no request bytes were ever processed.
      // That is the steady state until TROCK Scope ships, and it must keep retrying on the normal
      // backoff instead of dead-lettering every walk on attempt 2.
      const db = makeJobQueueDb(makePayload());
      const fetchImpl = vi.fn(async () => {
        throw networkError("ECONNREFUSED");
      });

      await expect(
        handleGlassesWalkthroughForward(db.storedPayload(), "office-1", deps(db, fetchImpl))
      ).rejects.toThrow();
      expect(db.storedPayload().scopeCreatePendingRef).toBeUndefined();
    });

    it("KEEPS the pending-create marker when the socket died mid-flight (the request may have been processed)", async () => {
      // ECONNRESET can fire after TROCK Scope fully handled the request and lost only the response, so
      // this one is genuinely unknowable and must fall to the dead letter rather than to a blind retry.
      const db = makeJobQueueDb(makePayload());
      const fetchImpl = vi.fn(async () => {
        throw networkError("ECONNRESET");
      });

      await expect(
        handleGlassesWalkthroughForward(db.storedPayload(), "office-1", deps(db, fetchImpl))
      ).rejects.toThrow();
      expect(db.storedPayload().scopeCreatePendingRef).toBe("trockcrm:glasses-walkthrough:walk-1");

      const retry = makeScopeFetch();
      const result = await handleGlassesWalkthroughForward(
        db.storedPayload(),
        "office-1",
        deps(db, retry.fetchImpl)
      );
      expect(retry.calls.filter((c) => c.url === CREATE_URL)).toHaveLength(0);
      expect(result).toEqual({ status: "dead", error: expect.any(String) });
    });

    it("KEEPS the pending-create marker on a 2xx whose body carries no usable walkthrough id", async () => {
      // A 201 we cannot read an id out of means TROCK Scope very likely DID insert a row — the one
      // outcome where "the create threw" absolutely does not imply "nothing was created".
      const db = makeJobQueueDb(makePayload());
      const { fetchImpl } = makeScopeFetch({ createStatus: 201, createBody: { walkthrough: {} } });

      await expect(
        handleGlassesWalkthroughForward(db.storedPayload(), "office-1", deps(db, fetchImpl))
      ).rejects.toThrow(/no usable walkthrough id/);
      expect(db.storedPayload().scopeCreatePendingRef).toBe("trockcrm:glasses-walkthrough:walk-1");
    });

    it("sends a deterministic externalRef with the create so TROCK Scope can dedupe on it once it grows a key", async () => {
      const db = makeJobQueueDb(makePayload());
      const { fetchImpl, calls } = makeScopeFetch();
      await handleGlassesWalkthroughForward(db.storedPayload(), "office-1", deps(db, fetchImpl));

      const createBody = JSON.parse(calls.find((c) => c.url === CREATE_URL)!.init.body);
      expect(createBody.externalRef).toBe("trockcrm:glasses-walkthrough:walk-1");
      // Same walk ⇒ same ref on every attempt: that is what makes it usable as a dedupe key at all.
      const db2 = makeJobQueueDb(makePayload());
      const again = makeScopeFetch();
      await handleGlassesWalkthroughForward(db2.storedPayload(), "office-1", deps(db2, again.fetchImpl));
      expect(JSON.parse(again.calls.find((c) => c.url === CREATE_URL)!.init.body).externalRef).toBe(
        createBody.externalRef
      );
    });

    it("clears the pending-create marker in the same statement that checkpoints the id", async () => {
      // Two statements would leave a window where BOTH keys are set, and a reader of the payload could
      // not tell a completed create from an unresolved one.
      const db = makeJobQueueDb(makePayload());
      const { fetchImpl } = makeScopeFetch();
      await handleGlassesWalkthroughForward(db.storedPayload(), "office-1", deps(db, fetchImpl));

      expect(db.storedPayload().scopeWalkthroughId).toBe("scope-walkthrough-1");
      expect(db.storedPayload().scopeCreatePendingRef).toBeUndefined();
      const checkpoint = db.calls.find((c) => /\{scopeWalkthroughId\}/.test(c.sql));
      expect(checkpoint!.sql).toContain("- 'scopeCreatePendingRef'");
    });
  });
});
