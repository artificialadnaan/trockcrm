import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  GLASSES_WALKTHROUGH_FORWARD_JOB,
  deriveScopeWalkthroughExternalRef,
  handleGlassesWalkthroughForward,
} from "../../src/jobs/glasses-walkthrough-forward.js";
import { R2_RANGE_READ_TIMEOUT_MS } from "../../src/lib/r2-client.js";

/**
 * `markerRows` is what the pre-create marker UPDATE answers with. It defaults to one row because that is
 * what a real `UPDATE … RETURNING id` does when it matches this job's row, and the handler now refuses to
 * send the create unless it does. A blanket `{ rows: [] }` — what this fake used to return for every
 * statement — would model an UPDATE that silently matched NOTHING, which is the case the empty override
 * exists to exercise deliberately rather than by accident.
 */
function makeDb(opts: { markerRows?: any[] } = {}) {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params });
    if (/\{scopeCreatePendingRef\}/.test(sql)) return { rows: opts.markerRows ?? [{ id: 1 }] };
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
      return { rows: [{ id: 1 }] };
    } else if (/\{scopeCreatePendingRef\}/.test(sql)) {
      stored = { ...stored, scopeCreatePendingRef: params![0] };
      // The marker UPDATE returns the row it matched — the handler treats "no rows" as "the marker was
      // never persisted" and refuses to create at all, so answering [] here would model a lost row.
      return { rows: [{ id: 1 }] };
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

/**
 * The honest R2 stand-in: answers with EXACTLY the bytes the requested range covers, which is what a
 * satisfied ranged read returns. Every case below used a fixed one- or five-byte buffer regardless of the
 * range asked for, and that is precisely why a zero-byte forward could reach TROCK Scope unnoticed — the
 * suite's own fake was already under-delivering and no assertion sized what got PUT. Tests that mean to
 * exercise a SHORT read now say so explicitly (see "part integrity").
 */
function makeDownloadRange() {
  return vi.fn(async (_r2Key: string, start: number, endInclusive: number) =>
    Buffer.alloc(endInclusive - start + 1, 0x61)
  );
}

describe("handleGlassesWalkthroughForward", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("creates the remote walkthrough, uploads the one clip's one part, and completes it", async () => {
    const db = makeDb();
    const { fetchImpl, calls } = makeScopeFetch();
    const downloadRange = makeDownloadRange();

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
      externalRef: "trockcrm:glasses-walkthrough:walk-1:deal:deal-1",
    });

    // Checkpointed the remote walkthrough id back into THIS job row via jsonb_set, keyed on walkId. Match
    // the scopeWalkthroughId statement specifically: the pre-create marker is a jsonb_set write too.
    const checkpoint = db.calls.find((c) => /\{scopeWalkthroughId\}/.test(c.sql));
    expect(checkpoint).toBeDefined();
    // Scoped to the (walkId, dealId) PAIR: a phone-minted walkId is not unique across deals, so keying on
    // it alone would write this walkthrough's id into the other deal's job row as well.
    expect(checkpoint!.params).toEqual([
      "scope-walkthrough-1",
      GLASSES_WALKTHROUGH_FORWARD_JOB,
      "walk-1",
      "deal-1",
    ]);

    // Downloaded exactly the one part's byte range from OUR OWN R2 key, under a deadline. The source read
    // is the one leg of the round trip that cannot bound ITSELF — the fetch-based legs carry an
    // AbortSignal, the S3 client is built with no requestTimeout — so an unpassed ceiling here is not a
    // slower forward, it is a poller that stops claiming work until someone restarts the worker.
    expect(downloadRange).toHaveBeenCalledWith(
      "dallas/deals/deal-1/glasses-walkthroughs/walk-1/artifact-1.mp4",
      0,
      1023,
      R2_RANGE_READ_TIMEOUT_MS
    );

    const completeCall = calls.find((c) => c.url.endsWith("/complete"));
    expect(JSON.parse(completeCall!.init.body)).toEqual({ parts: [{ partNumber: 1, etag: '"etag-1"' }] });
  });

  it("reuses a checkpointed scopeWalkthroughId instead of creating a second remote walkthrough", async () => {
    const db = makeDb();
    const { fetchImpl, calls } = makeScopeFetch();
    const downloadRange = makeDownloadRange();

    await handleGlassesWalkthroughForward(
      makePayload({ scopeWalkthroughId: "already-created" }),
      "office-1",
      { db, fetchImpl: fetchImpl as any, baseUrl: "https://scope.example.com", token: "t", downloadRange }
    );

    expect(calls.some((c) => c.url === "https://scope.example.com/api/walkthroughs")).toBe(false);
    // No CHECKPOINT write: the id is already settled, so neither marker statement should run. Asserted on
    // the two payload keys those statements touch rather than on `jsonb_set` alone — every successful
    // forward now ends with one more jsonb_set, the pending-artifact reconciliation, and a blanket ban on
    // the operator would fail for a statement that has nothing to do with checkpointing.
    expect(db.calls.some((c) => c.sql.includes("scopeWalkthroughId"))).toBe(false);
    expect(db.calls.some((c) => c.sql.includes("scopeCreatePendingRef"))).toBe(false);
    const beginCall = calls.find((c) => /\/clips$/.test(c.url));
    expect(beginCall!.url).toContain("already-created");
  });

  it("splits more than 100 parts across multiple sign-parts requests (TROCK Scope's per-request ceiling)", async () => {
    const db = makeDb();
    // A toy partSize, not TROCK Scope's real 32MiB: the sign-parts batching this case is about depends on
    // the part COUNT alone, and now that the download fake returns the range's true byte count, 32MiB ×
    // 150 would zero-fill ~4.8GB to prove nothing extra.
    const PART_SIZE = 64;
    const { fetchImpl, calls } = makeScopeFetch({
      beginBody: {
        clipId: "clip-1",
        key: "k",
        uploadId: "u",
        sequence: 1,
        partSize: PART_SIZE,
        partCount: 150,
      },
    });
    const downloadRange = makeDownloadRange();

    await handleGlassesWalkthroughForward(
      makePayload({ artifacts: [{ ...makePayload().artifacts[0], fileSizeBytes: 150 * PART_SIZE }] }),
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
    const downloadRange = makeDownloadRange();

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
    const downloadRange = makeDownloadRange();

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
    const downloadRange = makeDownloadRange();

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
    // 500 is deliberately the AMBIGUOUS class now — see the retry-safety block below — so this
    // asserts only that the job still throws and retries, not which of the two messages it carries.
    const { fetchImpl } = makeScopeFetch({ createStatus: 500, createBody: { error: "boom" } });

    await expect(
      handleGlassesWalkthroughForward(makePayload(), "office-1", {
        db,
        fetchImpl: fetchImpl as any,
        baseUrl: "https://scope.example.com",
        token: "t",
        downloadRange: makeDownloadRange(),
      })
    ).rejects.toThrow(/walkthrough create/);
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
        downloadRange: makeDownloadRange(),
      })
    ).rejects.toThrow(/no ETag/);
  });

  // ── Upload-plan integrity ────────────────────────────────────────────────────────────────────────
  //
  // Every byte range this job reads out of R2 is computed from numbers TROCK Scope handed back, and the
  // multipart upload is declared finished by a `/complete` built from the same plan. Taking that plan on
  // faith fails SILENTLY in both directions: an absent partCount collapses the part loop to zero
  // iterations and completes a clip that never received a byte, and a non-string clipId is spliced into
  // the URL path where it becomes some other clip's problem. Neither surfaces as an error — the job
  // reports SUCCESS — so the plan is checked where it arrives.
  describe("upload-plan integrity", () => {
    it("rejects a plan with no usable part count instead of completing a clip that received no bytes", async () => {
      const db = makeDb();
      const { fetchImpl, calls } = makeScopeFetch({
        // partCount absent: `Array.from({ length: undefined })` is an EMPTY array, so the part loop runs
        // zero times and `/complete` goes out with `parts: []` — a finished, empty clip.
        beginBody: { clipId: "clip-1", uploadId: "upload-1", sequence: 1, partSize: 1024 },
      });

      await expect(
        handleGlassesWalkthroughForward(makePayload({ scopeWalkthroughId: "already-created" }), "office-1", {
          db,
          fetchImpl: fetchImpl as any,
          baseUrl: SCOPE_BASE_URL,
          token: "t",
          downloadRange: makeDownloadRange(),
        })
      ).rejects.toThrow(/unusable upload plan/);

      expect(calls.some((c) => /\/complete$/.test(c.url))).toBe(false);
    });

    it("rejects a plan whose clipId is not a string, rather than splicing it into the clip URL", async () => {
      const db = makeDb();
      const { fetchImpl, calls } = makeScopeFetch({
        beginBody: { clipId: null, uploadId: 7, sequence: 1, partSize: 1024, partCount: 1 },
      });

      await expect(
        handleGlassesWalkthroughForward(makePayload({ scopeWalkthroughId: "already-created" }), "office-1", {
          db,
          fetchImpl: fetchImpl as any,
          baseUrl: SCOPE_BASE_URL,
          token: "t",
          downloadRange: makeDownloadRange(),
        })
      ).rejects.toThrow(/unusable upload plan/);

      expect(calls.some((c) => /\/parts$/.test(c.url))).toBe(false);
    });

    it("rejects a sign-parts response that omits a requested part, rather than completing a short clip", async () => {
      // A missing signed part is invisible here: the loop simply uploads the parts it WAS given and
      // `/complete` declares the multipart finished from those. S3 assembles whatever it was handed, so
      // the clip lands truncated and the job reports success. Surfacing it at the sign call — naming the
      // part — beats an unexplained upload failure minutes and gigabytes later.
      const PART_SIZE = 64;
      const db = makeDb();
      const { fetchImpl, calls } = makeScopeFetch({
        beginBody: { clipId: "clip-1", uploadId: "u", sequence: 1, partSize: PART_SIZE, partCount: 3 },
        signBody: {
          parts: [
            { partNumber: 1, url: "https://r2.example.com/part-1" },
            { partNumber: 3, url: "https://r2.example.com/part-3" },
          ],
        },
      });

      await expect(
        handleGlassesWalkthroughForward(
          makePayload({
            scopeWalkthroughId: "already-created",
            artifacts: [{ ...makePayload().artifacts[0], fileSizeBytes: 3 * PART_SIZE }],
          }),
          "office-1",
          { db, fetchImpl: fetchImpl as any, baseUrl: SCOPE_BASE_URL, token: "t", downloadRange: makeDownloadRange() }
        )
      ).rejects.toThrow(/did not sign part 2/);

      expect(calls.some((c) => /\/complete$/.test(c.url))).toBe(false);
    });

    // ── Plan COVERAGE, as distinct from plan shape ───────────────────────────────────────────────
    //
    // The three cases above all describe a plan that is malformed. An UNDERSIZED plan is well-formed —
    // positive integers, every part signed — and it is the only one of the four that reaches `/complete`.
    // Nothing per-part can catch it: each range is clamped to the object, so each part is exactly the
    // length it claims, every length check passes, and the multipart is finalized from a PREFIX. The walk
    // reports success, the video stops partway, and TROCK Scope bills a transcription of the fragment.
    it("rejects a plan that covers only a PREFIX of the artifact, instead of finalizing it truncated", async () => {
      // The reviewer's case at toy scale: one part for an artifact that needs two (32MiB × 1 for 40MiB).
      const db = makeDb();
      const { fetchImpl, calls } = makeScopeFetch({
        beginBody: { clipId: "clip-1", uploadId: "u", sequence: 1, partSize: 1024, partCount: 1 },
      });

      await expect(
        handleGlassesWalkthroughForward(
          makePayload({
            scopeWalkthroughId: "already-created",
            artifacts: [{ ...makePayload().artifacts[0], fileSizeBytes: 1500 }],
          }),
          "office-1",
          { db, fetchImpl: fetchImpl as any, baseUrl: SCOPE_BASE_URL, token: "t", downloadRange: makeDownloadRange() }
        )
      ).rejects.toThrow(/covers only 1024 of the artifact's 1500 bytes/);

      // Nothing may move: not a signature, not a byte, and above all not the finalize. A part uploaded
      // under a plan we have already refused is a part that has to be uploaded again on the retry.
      expect(calls.some((c) => /\/parts$/.test(c.url))).toBe(false);
      expect(calls.some((c) => c.url.startsWith("https://r2.example.com/part-"))).toBe(false);
      expect(calls.some((c) => /\/complete$/.test(c.url))).toBe(false);
    });

    it("rejects a plan that is short by a SINGLE byte", async () => {
      // Pins `<` against `<=`: a plan one byte short of the object is the same silent truncation as one a
      // gigabyte short, and it is the version a "close enough" comparison lets through. Multi-part on
      // purpose — the shortfall lives in the TOTAL, so a plan can be short while every one of its parts is
      // full-length and perfectly uniform.
      const db = makeDb();
      const { fetchImpl, calls } = makeScopeFetch({
        beginBody: { clipId: "clip-1", uploadId: "u", sequence: 1, partSize: 512, partCount: 2 },
      });

      await expect(
        handleGlassesWalkthroughForward(
          makePayload({
            scopeWalkthroughId: "already-created",
            artifacts: [{ ...makePayload().artifacts[0], fileSizeBytes: 1025 }],
          }),
          "office-1",
          { db, fetchImpl: fetchImpl as any, baseUrl: SCOPE_BASE_URL, token: "t", downloadRange: makeDownloadRange() }
        )
      ).rejects.toThrow(/covers only 1024 of the artifact's 1025 bytes/);

      expect(calls.some((c) => /\/complete$/.test(c.url))).toBe(false);
    });

    // GUARD (passes with or without the coverage check) — it exists to pin the two boundaries the check
    // must NOT reject, because the cheap over-strict version of this fix ("every part is partSize" or
    // "planned === declared") rejects both, and both are what an ordinary walk looks like.
    it("accepts a plan whose final part is short, and PUTs every byte of the object", async () => {
      const db = makeDb();
      const { fetchImpl, calls } = makeScopeFetch({
        beginBody: { clipId: "clip-1", uploadId: "u", sequence: 1, partSize: 1024, partCount: 2 },
      });

      await handleGlassesWalkthroughForward(
        makePayload({
          scopeWalkthroughId: "already-created",
          artifacts: [{ ...makePayload().artifacts[0], fileSizeBytes: 1500 }],
        }),
        "office-1",
        { db, fetchImpl: fetchImpl as any, baseUrl: SCOPE_BASE_URL, token: "t", downloadRange: makeDownloadRange() }
      );

      // Sized, not counted. "Two parts were PUT" is exactly the assertion an undersized plan also
      // satisfies; only the byte totals distinguish a whole object from a prefix of one, and this suite
      // asserted the count and never the size — which is how the truncation survived review.
      const putBodies = calls
        .filter((c) => c.url.startsWith("https://r2.example.com/part-"))
        .map((c) => (c.init.body as Buffer).length);
      expect(putBodies).toEqual([1024, 476]);
      expect(putBodies.reduce((a, b) => a + b, 0)).toBe(1500);
      expect(JSON.parse(calls.find((c) => /\/complete$/.test(c.url))!.init.body).parts).toHaveLength(2);
    });

    it("accepts a plan that covers the object EXACTLY, with no short final part", async () => {
      // The other boundary: partSize × partCount === fileSizeBytes. `>=`, not `>`.
      const db = makeDb();
      const { fetchImpl, calls } = makeScopeFetch({
        beginBody: { clipId: "clip-1", uploadId: "u", sequence: 1, partSize: 512, partCount: 2 },
      });

      await handleGlassesWalkthroughForward(
        makePayload({
          scopeWalkthroughId: "already-created",
          artifacts: [{ ...makePayload().artifacts[0], fileSizeBytes: 1024 }],
        }),
        "office-1",
        { db, fetchImpl: fetchImpl as any, baseUrl: SCOPE_BASE_URL, token: "t", downloadRange: makeDownloadRange() }
      );

      const putBodies = calls
        .filter((c) => c.url.startsWith("https://r2.example.com/part-"))
        .map((c) => (c.init.body as Buffer).length);
      expect(putBodies).toEqual([512, 512]);
    });
  });

  // ── Stall protection ─────────────────────────────────────────────────────────────────────────────
  //
  // This job runs on its OWN dedicated poller with a reentrancy guard (queue.ts,
  // pollGlassesWalkthroughForwardJobs) and a concurrency of 1. A call that never answers therefore does
  // not just lose one walk — it holds that guard forever, and EVERY later walkthrough forward goes
  // unclaimed until the process is restarted. `fetch` has no default timeout, so a TROCK Scope (or R2)
  // that accepts the connection and then goes quiet is exactly that.
  describe("stall protection", () => {
    /** A server that completes the TCP handshake and then never answers. Honors `signal` the way undici
     *  does — rejecting with the signal's reason — so a missing signal reproduces the real defect: the
     *  promise never settles at all. */
    function hangingFetch(shouldHang: (url: string) => boolean, answered: (url: string, init: any) => Response) {
      const calls: Array<{ url: string; init: any }> = [];
      const fetchImpl = vi.fn((url: string, init: any) => {
        calls.push({ url, init });
        if (!shouldHang(url)) return Promise.resolve(answered(url, init));
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal as AbortSignal | undefined;
          if (!signal) return; // no timeout wired ⇒ never settles ⇒ the poller is wedged
          signal.addEventListener("abort", () => reject(signal.reason));
        });
      });
      return { fetchImpl, calls };
    }

    it("gives up on a TROCK Scope call that never answers instead of holding the poller forever", async () => {
      const db = makeJobQueueDb(makePayload());
      const { fetchImpl } = hangingFetch(
        () => true,
        () => new Response(null, { status: 200 })
      );

      await expect(
        handleGlassesWalkthroughForward(db.storedPayload(), "office-1", {
          db,
          fetchImpl: fetchImpl as any,
          baseUrl: SCOPE_BASE_URL,
          token: "t",
          downloadRange: makeDownloadRange(),
          timeouts: { requestMs: 25 },
        })
      ).rejects.toThrow(/did not answer within/);
    }, 3_000);

    it("KEEPS the pending-create marker when the create TIMES OUT — a timeout proves nothing", async () => {
      // The one thing this must not do is look like the ECONNREFUSED case. A request that timed out was
      // fully delivered as far as anyone here can tell; TROCK Scope may have inserted the row and simply
      // never got the response back. Clearing the marker on that hands the next attempt a clean slate to
      // create a duplicate walkthrough and a second billed extraction.
      const db = makeJobQueueDb(makePayload());
      const { fetchImpl } = hangingFetch(
        () => true,
        () => new Response(null, { status: 200 })
      );

      await expect(
        handleGlassesWalkthroughForward(db.storedPayload(), "office-1", {
          db,
          fetchImpl: fetchImpl as any,
          baseUrl: SCOPE_BASE_URL,
          token: "t",
          downloadRange: makeDownloadRange(),
          timeouts: { requestMs: 25 },
        })
      ).rejects.toThrow(/did not answer within/);

      expect(db.storedPayload().scopeCreatePendingRef).toBe("trockcrm:glasses-walkthrough:walk-1:deal:deal-1");
      // …and the next attempt reconciles rather than creating a second walkthrough.
      const retry = makeScopeFetch();
      const result = await handleGlassesWalkthroughForward(db.storedPayload(), "office-1", {
        db,
        fetchImpl: retry.fetchImpl as any,
        baseUrl: SCOPE_BASE_URL,
        token: "t",
        downloadRange: makeDownloadRange(),
      });
      expect(retry.calls.filter((c) => c.url === CREATE_URL)).toHaveLength(0);
      expect(result).toEqual({ status: "dead", error: expect.any(String) });
    }, 3_000);

    it("bounds the presigned part PUT too — a stalled R2 upload wedges the poller identically", async () => {
      // TROCK Scope's own calls answer normally; only the raw R2 part PUT goes quiet. That is the
      // longest-lived request of the whole forward (a 32MiB part), and the one most likely to stall.
      const db = makeDb();
      const scope = makeScopeFetch();
      const { fetchImpl } = hangingFetch(
        (url) => url.startsWith("https://r2.example.com/part-"),
        () => new Response(null, { status: 200 })
      );
      const routed = vi.fn((url: string, init: any) =>
        url.startsWith("https://r2.example.com/part-")
          ? (fetchImpl as any)(url, init)
          : (scope.fetchImpl as any)(url, init)
      );

      await expect(
        handleGlassesWalkthroughForward(makePayload({ scopeWalkthroughId: "already-created" }), "office-1", {
          db,
          fetchImpl: routed as any,
          baseUrl: SCOPE_BASE_URL,
          token: "t",
          downloadRange: makeDownloadRange(),
          timeouts: { partPutMs: 25 },
        })
      ).rejects.toThrow(/did not answer within/);
    }, 3_000);

    it("hands the SOURCE read the ceiling it was configured with, not just the default", async () => {
      // The other half of that same part. The read cannot bound itself from the caller's side — it is an
      // SDK call, not a fetch, so there is no signal to hand it — and `getObjectRangeBuffer` therefore
      // takes the deadline as an argument. A ceiling that is declared and then never passed is the exact
      // shape of a fix that reviews clean and changes nothing at runtime, so it is asserted at the seam.
      const db = makeDb();
      const { fetchImpl } = makeScopeFetch();
      const downloadRange = makeDownloadRange();

      await handleGlassesWalkthroughForward(makePayload({ scopeWalkthroughId: "already-created" }), "office-1", {
        db,
        fetchImpl: fetchImpl as any,
        baseUrl: SCOPE_BASE_URL,
        token: "t",
        downloadRange,
        timeouts: { sourceReadMs: 1_234 },
      });

      expect(downloadRange).toHaveBeenCalledWith(expect.any(String), 0, 1023, 1_234);
    });
  });

  // ── Part integrity ───────────────────────────────────────────────────────────────────────────────
  //
  // `downloadRange` is an injection seam whose production default is a network read. Nothing downstream
  // of it can tell a short answer from a correct one: a presigned R2 part PUT accepts zero bytes, answers
  // 200 and returns an ETag, and S3 multipart accepts an undersized FINAL part — so a one-part clip
  // completes as a zero-byte recording and this job reports SUCCESS. That is worse than a failure: the
  // walk looks filed, nothing retries, nothing alerts, and TROCK Scope bills a transcription that yields
  // a confidently empty scope. The byte count is the only thing that distinguishes the two, so it is
  // checked before the PUT rather than after.
  describe("part integrity", () => {
    it("refuses to upload a part it could not fully read, instead of PUTting the short bytes", async () => {
      const db = makeDb();
      const { fetchImpl, calls } = makeScopeFetch();
      // 5 bytes for the 1024-byte range the part plan asks for — the shape of a truncated R2 object.
      const downloadRange = vi.fn(async () => Buffer.from("bytes"));

      await expect(
        handleGlassesWalkthroughForward(makePayload({ scopeWalkthroughId: "already-created" }), "office-1", {
          db,
          fetchImpl: fetchImpl as any,
          baseUrl: SCOPE_BASE_URL,
          token: "t",
          downloadRange,
        })
      ).rejects.toThrow(/5 bytes/);

      expect(calls.some((c) => c.url.startsWith("https://r2.example.com/part-"))).toBe(false);
      expect(calls.some((c) => /\/complete$/.test(c.url))).toBe(false);
    });

    it("refuses a ZERO-byte part — the exact answer an unconfigured worker's R2 read used to give", async () => {
      const db = makeDb();
      const { fetchImpl, calls } = makeScopeFetch();
      const downloadRange = vi.fn(async () => Buffer.alloc(0));

      await expect(
        handleGlassesWalkthroughForward(makePayload({ scopeWalkthroughId: "already-created" }), "office-1", {
          db,
          fetchImpl: fetchImpl as any,
          baseUrl: SCOPE_BASE_URL,
          token: "t",
          downloadRange,
        })
      ).rejects.toThrow(/0 bytes/);

      expect(calls.some((c) => c.url.startsWith("https://r2.example.com/part-"))).toBe(false);
      expect(calls.some((c) => /\/complete$/.test(c.url))).toBe(false);
    });

    it("rejects a part plan that puts a part past the end of the filed object", async () => {
      // partCount 2 over a 1024-byte object whose partSize is 1024: part 2 starts exactly at EOF, so its
      // range covers nothing. An empty range that "matches" an empty read is the one way a zero-byte PUT
      // would still slip past a pure length comparison, so the plan is checked on its own terms.
      const db = makeDb();
      const { fetchImpl, calls } = makeScopeFetch({
        beginBody: { clipId: "clip-1", uploadId: "u", sequence: 1, partSize: 1024, partCount: 2 },
      });
      const downloadRange = vi.fn(async (_k: string, start: number, end: number) =>
        Buffer.alloc(Math.max(0, end - start + 1))
      );

      await expect(
        handleGlassesWalkthroughForward(makePayload({ scopeWalkthroughId: "already-created" }), "office-1", {
          db,
          fetchImpl: fetchImpl as any,
          baseUrl: SCOPE_BASE_URL,
          token: "t",
          downloadRange,
        })
      ).rejects.toThrow(/outside the 1024-byte object/);

      expect(calls.some((c) => /\/complete$/.test(c.url))).toBe(false);
    });
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
    const downloadRange = makeDownloadRange();

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

  it("resumes a walk whose SECOND clip failed, re-uploading the first as duplicate_bytes under the same walkthrough", async () => {
    // GUARD (passes before and after this round's fixes) for the property that makes a per-artifact
    // checkpoint unnecessary: the artifact loop has no memory, so a retry re-uploads every clip — and
    // that is SAFE because TROCK Scope's clips_walkthrough_checksum_key rejects a second copy of
    // identical bytes with 409 duplicate_bytes, which completeClip treats as a terminal success. The
    // failure mode this rules out is the expensive-looking one being also WRONG: a second copy of clip 1
    // landing as real scope data, or the retry aborting on clip 1's 409 and never reaching clip 2.
    const db = makeJobQueueDb(
      makePayload({
        artifacts: [
          { fileId: "f1", idempotencyKey: "a1", kind: "video", r2Key: "k1", mimeType: "video/mp4", originalFilename: "a.mp4", fileSizeBytes: 10, capturedAtMs: 0 },
          { fileId: "f2", idempotencyKey: "a2", kind: "photo", r2Key: "k2", mimeType: "image/jpeg", originalFilename: "b.jpg", fileSizeBytes: 10, capturedAtMs: 500 },
        ],
      })
    );

    /** TROCK Scope with a memory: one clip id per begin call, and per-clip `/complete` outcomes that
     *  change between deliveries the way the real service's checksum constraint makes them. */
    function makeResumableScope(completeStatuses: Record<string, { status: number; body: any }>) {
      const calls: Array<{ url: string; init: any }> = [];
      let clipSeq = 0;
      const fetchImpl = vi.fn(async (url: string, init: any) => {
        calls.push({ url, init });
        if (url === CREATE_URL) {
          return new Response(JSON.stringify({ walkthrough: { id: "scope-walkthrough-1" } }), { status: 201 });
        }
        if (/\/clips$/.test(url)) {
          clipSeq += 1;
          return new Response(
            JSON.stringify({ clipId: `clip-${clipSeq}`, uploadId: `u-${clipSeq}`, sequence: clipSeq, partSize: 1024, partCount: 1 }),
            { status: 201 }
          );
        }
        if (/\/parts$/.test(url)) {
          const partNumbers = JSON.parse(init.body).partNumbers as number[];
          return new Response(
            JSON.stringify({ parts: partNumbers.map((n) => ({ partNumber: n, url: `https://r2.example.com/part-${n}` })) }),
            { status: 200 }
          );
        }
        if (/\/complete$/.test(url)) {
          const clipId = url.split("/clips/")[1]!.replace("/complete", "");
          const outcome = completeStatuses[clipId] ?? { status: 200, body: { outcome: "uploaded" } };
          return new Response(JSON.stringify(outcome.body), { status: outcome.status });
        }
        if (url.startsWith("https://r2.example.com/part-")) {
          return new Response(null, { status: 200, headers: new Headers({ etag: '"etag-1"' }) });
        }
        throw new Error(`Unexpected fetch to ${url}`);
      });
      return { fetchImpl, calls };
    }

    const forwardDeps = (fetchImpl: any) => ({
      db,
      fetchImpl: fetchImpl as any,
      baseUrl: SCOPE_BASE_URL,
      token: "t",
      downloadRange: makeDownloadRange(),
    });

    // Delivery 1: clip 1 lands; clip 2's /complete fails, so the job throws and job_queue retries it.
    const first = makeResumableScope({ "clip-2": { status: 500, body: { error: "boom" } } });
    await expect(
      handleGlassesWalkthroughForward(db.storedPayload(), "office-1", forwardDeps(first.fetchImpl))
    ).rejects.toThrow(/complete-clip failed/);
    expect(first.calls.filter((c) => c.url === CREATE_URL)).toHaveLength(1);
    expect(db.storedPayload().scopeWalkthroughId).toBe("scope-walkthrough-1");

    // Delivery 2: the SAME payload as job_queue now holds it. Clip 1's bytes already landed, so its
    // re-upload comes back 409 duplicate_bytes — which must not stop the loop reaching clip 2.
    const second = makeResumableScope({ "clip-1": { status: 409, body: { outcome: "duplicate_bytes", duplicateOfClipId: "clip-0" } } });
    await expect(
      handleGlassesWalkthroughForward(db.storedPayload(), "office-1", forwardDeps(second.fetchImpl))
    ).resolves.toBeUndefined();

    // No second walkthrough, and BOTH clips finished under the one that already existed.
    expect(second.calls.filter((c) => c.url === CREATE_URL)).toHaveLength(0);
    const completes = second.calls.filter((c) => /\/complete$/.test(c.url));
    expect(completes).toHaveLength(2);
    expect(completes.every((c) => c.url.includes("/walkthroughs/scope-walkthrough-1/"))).toBe(true);
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
      downloadRange: makeDownloadRange(),
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

    it("refuses to create when the marker UPDATE matched NO row — a write that lands nowhere is not a marker", async () => {
      // The write can succeed and still change nothing: a payload whose walkId no longer matches (a
      // hand-edited row during a reconciliation, a row deleted by a cleanup) leaves the UPDATE matching
      // zero rows and returning no error at all. Without checking, the create then goes out with NOTHING
      // recorded anywhere — the precise state the whole two-phase marker exists to make impossible, and
      // silently so. Losing this attempt is recoverable; an untracked remote walkthrough is not.
      const db = makeDb({ markerRows: [] });
      const { fetchImpl, calls } = makeScopeFetch();

      await expect(
        handleGlassesWalkthroughForward(makePayload(), "office-1", deps(db, fetchImpl))
      ).rejects.toThrow(/matched no job_queue row/);
      expect(calls).toHaveLength(0);
    });

    it("clears the pending-create marker when TROCK Scope ANSWERED and refused, so the job stays retryable", async () => {
      // A completed 4xx is positive evidence no walkthrough row exists: the create route inserts and
      // THEN answers 201, so a 4xx came off its validation/auth path before any insert. This is
      // today's most likely failure by far — TROCK Scope has no machine-auth middleware yet and 401s
      // every one of these calls — and it must NOT burn the job on a phantom duplicate hunt.
      const db = makeJobQueueDb(makePayload());
      const refused = makeScopeFetch({ createStatus: 401, createBody: { error: "unauthorized" } });
      await expect(
        handleGlassesWalkthroughForward(db.storedPayload(), "office-1", deps(db, refused.fetchImpl))
      ).rejects.toThrow(/refused before it created anything/);
      expect(db.storedPayload().scopeCreatePendingRef).toBeUndefined();

      // …and the next attempt proceeds normally rather than dead-lettering.
      const retry = makeScopeFetch();
      await expect(
        handleGlassesWalkthroughForward(db.storedPayload(), "office-1", deps(db, retry.fetchImpl))
      ).resolves.toBeUndefined();
      expect(retry.calls.filter((c) => c.url === CREATE_URL)).toHaveLength(1);
      expect(db.storedPayload().scopeWalkthroughId).toBe("scope-walkthrough-1");
    });

    it("KEEPS the marker when a GATEWAY answers 5xx, which proves nothing either way", async () => {
      // The line between the two classes. A 4xx is TROCK Scope's own error path answering before it
      // inserted. A 5xx is frequently not TROCK Scope answering at all — it is a proxy inventing a
      // status because the app behind it went quiet, which happens just as readily AFTER a committed
      // INSERT (response lost, gateway timed out mid-reply) as before one. Clearing on that hands the
      // next attempt a clean slate to create a duplicate walkthrough and a second billed extraction.
      const db = makeJobQueueDb(makePayload());
      const gateway = makeScopeFetch({ createStatus: 502, createBody: { error: "bad gateway" } });
      await expect(
        handleGlassesWalkthroughForward(db.storedPayload(), "office-1", deps(db, gateway.fetchImpl))
      ).rejects.toThrow(/does not prove whether a walkthrough was created/);
      expect(db.storedPayload().scopeCreatePendingRef).toBe("trockcrm:glasses-walkthrough:walk-1:deal:deal-1");
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
      expect(db.storedPayload().scopeCreatePendingRef).toBe("trockcrm:glasses-walkthrough:walk-1:deal:deal-1");

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
      expect(db.storedPayload().scopeCreatePendingRef).toBe("trockcrm:glasses-walkthrough:walk-1:deal:deal-1");
    });

    it("sends a deterministic externalRef with the create, identical on every attempt of the same delivery", async () => {
      const db = makeJobQueueDb(makePayload());
      const { fetchImpl, calls } = makeScopeFetch();
      await handleGlassesWalkthroughForward(db.storedPayload(), "office-1", deps(db, fetchImpl));

      const createBody = JSON.parse(calls.find((c) => c.url === CREATE_URL)!.init.body);
      expect(createBody.externalRef).toBe("trockcrm:glasses-walkthrough:walk-1:deal:deal-1");
      // Same walk on the same deal ⇒ same ref on every attempt. TROCK Scope's unique index on this column
      // makes a repeat create return the EXISTING walkthrough, so a ref that drifted between attempts would
      // buy a second walkthrough and a second billed extraction.
      const db2 = makeJobQueueDb(makePayload());
      const again = makeScopeFetch();
      await handleGlassesWalkthroughForward(db2.storedPayload(), "office-1", deps(db2, again.fetchImpl));
      expect(JSON.parse(again.calls.find((c) => c.url === CREATE_URL)!.init.body).externalRef).toBe(
        createBody.externalRef
      );
    });

    it("scopes the externalRef to the DEAL, so one physical walk re-filed against a second deal is two remote walkthroughs", async () => {
      // The correction/reuse flow re-files ONE walk against a SECOND deal, and walkId is minted on the
      // phone — so a ref derived from walkId alone is the same string on both deliveries. TROCK Scope now
      // persists externalRef under a UNIQUE constraint and answers a repeat create with the EXISTING
      // walkthrough (201 + deduplicated), which turns that shared string into deal B's clips uploading into
      // deal A's walkthrough — a walkthrough whose dealUuid still names A. trockcrm files B correctly and
      // the extracted scope comes back attached to the wrong project, silently.
      const dbA = makeJobQueueDb(makePayload());
      const a = makeScopeFetch();
      await handleGlassesWalkthroughForward(dbA.storedPayload(), "office-1", deps(dbA, a.fetchImpl));

      const dbB = makeJobQueueDb(makePayload({ dealId: "deal-2" }));
      const b = makeScopeFetch();
      await handleGlassesWalkthroughForward(dbB.storedPayload(), "office-1", deps(dbB, b.fetchImpl));

      const refA = JSON.parse(a.calls.find((c) => c.url === CREATE_URL)!.init.body).externalRef;
      const refB = JSON.parse(b.calls.find((c) => c.url === CREATE_URL)!.init.body).externalRef;
      expect(refA).not.toBe(refB);
      expect(refA).toContain("deal-1");
      expect(refB).toContain("deal-2");
      // Both creates still name their own deal, which is what makes the two remote walkthroughs correct
      // rather than merely distinct.
      expect(JSON.parse(a.calls.find((c) => c.url === CREATE_URL)!.init.body).dealUuid).toBe("deal-1");
      expect(JSON.parse(b.calls.find((c) => c.url === CREATE_URL)!.init.body).dealUuid).toBe("deal-2");
    });

    it("GUARD: no two (walk, deal) pairs can produce one ref, even when a component spells the separator", async () => {
      // Deal-scoping is only worth anything if the two components are recoverable from the joined string.
      // The pair below joins to the identical raw text, and a raw join would therefore give both deliveries
      // one ref — the exact cross-deal aliasing the scoping exists to end, but reachable from a payload
      // field rather than from a coincidence. Unreachable today (dealId is written to a uuid column before
      // it can reach this payload, so it can never contain the separator), which is what makes this a guard
      // rather than a live bug — and exactly why it is asserted here instead of assumed from a column type
      // in another service.
      expect(deriveScopeWalkthroughExternalRef("walk-1:deal:deal-2", "deal-1")).not.toBe(
        deriveScopeWalkthroughExternalRef("walk-1", "deal-2:deal:deal-1")
      );
      // …and the readable shape is untouched for every id either side actually mints (encodeURIComponent is
      // the identity over UUIDs), because this string's other job is to be typed into TROCK Scope by hand.
      expect(
        deriveScopeWalkthroughExternalRef("walk-1", "00000000-0000-0000-0000-0000000000d1")
      ).toBe("trockcrm:glasses-walkthrough:walk-1:deal:00000000-0000-0000-0000-0000000000d1");
    });

    it("GUARD: dead-letters on the ref the earlier attempt actually SENT, never a freshly derived one", async () => {
      // The marker is not just a flag — its value is the one string a human can search TROCK Scope by, and
      // the dead letter is where they read it. A payload written before the ref's shape changed must still
      // dead-letter naming the ref that really went out on the wire, so re-deriving here (rather than
      // echoing what the row stored) would print a ref no remote walkthrough has ever carried and send the
      // reconciler looking for something that does not exist.
      const db = makeJobQueueDb(makePayload({ scopeCreatePendingRef: "trockcrm:glasses-walkthrough:walk-1" }));
      const { fetchImpl, calls } = makeScopeFetch();

      const result = await handleGlassesWalkthroughForward(db.storedPayload(), "office-1", deps(db, fetchImpl));

      expect(calls).toHaveLength(0);
      expect(result).toEqual({ status: "dead", error: expect.stringContaining("trockcrm:glasses-walkthrough:walk-1") });
      expect((result as any).error).not.toContain(":deal:");
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
