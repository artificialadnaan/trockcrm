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
    });

    // Checkpointed the remote walkthrough id back into THIS job row via jsonb_set, keyed on walkId.
    const checkpoint = db.calls.find((c) => c.sql.includes("jsonb_set"));
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
});
