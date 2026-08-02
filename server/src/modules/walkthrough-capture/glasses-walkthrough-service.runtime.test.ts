// REAL-SQL (PGlite) proof for `ingestGlassesWalkthrough`: the `files` row writes and the `job_queue`
// enqueue. Same rationale as walkthrough-ingress-service.runtime.test.ts (the return path's own runtime
// suite) for why this needs real SQL rather than a mocked db — `files` has ten NOT NULL columns Drizzle's
// insert type does not fully enforce, and the partial unique index on `client_upload_id` (the mechanism
// this suite's idempotency tests are ABOUT) only exists in real SQL, not in the type system.
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { files, jobQueue } from "@trock-crm/shared/schema";
import { tenantSchemaSql } from "../../../tests/helpers/tenant-schema-from-drizzle.js";
import { AppError } from "../../middleware/error-handler.js";
import {
  GLASSES_WALKTHROUGH_FORWARD_JOB,
  type GlassesWalkthroughArtifactStore,
  type IngestGlassesWalkthroughInput,
  ingestGlassesWalkthrough,
} from "./glasses-walkthrough-service.js";

const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const DEAL = U("11111");
const OTHER_DEAL = U("11112");
const USER = U("22222");
const WALK = U("33333");

let pg: PGlite;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tenantDb: any;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(tenantSchemaSql("public", [files, jobQueue]));
  // `tenantSchemaSql` deliberately omits indexes/unique constraints (see its own docblock) — but
  // `ingestGlassesWalkthrough`'s idempotency relies on the REAL partial unique index migration 0170
  // creates (`files_client_upload_id_key`), so it has to be added by hand here for the
  // `onConflictDoNothing` path to mean anything against this schema.
  await pg.exec(
    "CREATE UNIQUE INDEX files_client_upload_id_key ON files (client_upload_id) WHERE client_upload_id IS NOT NULL"
  );
  tenantDb = drizzle(pg);
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  await pg.exec("DELETE FROM files");
  await pg.exec("DELETE FROM job_queue");
});

/** A healthy store that agrees with whatever the payload declares — every happy-path test runs THROUGH
 *  the R2 verification (isConfigured: true) rather than hiding behind a "not configured" skip, mirroring
 *  the return path's own default-healthy-store convention. */
function healthyStore(overrides: Partial<GlassesWalkthroughArtifactStore> = {}): GlassesWalkthroughArtifactStore {
  return {
    isConfigured: () => true,
    head: async () => ({ contentType: "video/mp4", contentLength: 1024 }),
    presignUpload: async () => ({ uploadUrl: "https://example.com/put", expiresIn: 1800 }),
    ...overrides,
  };
}

function baseInput(overrides: Partial<IngestGlassesWalkthroughInput> = {}): IngestGlassesWalkthroughInput {
  return {
    dealId: DEAL,
    projectId: null,
    walkId: WALK,
    title: "North wing walkthrough",
    siteLabel: "Building A",
    capturedAt: "2026-07-30T15:04:00.000Z",
    userId: USER,
    officeSlug: "dallas",
    officeId: null,
    artifacts: [
      {
        idempotencyKey: "artifact-1",
        kind: "video",
        originalFilename: "clip-001.mp4",
        mimeType: "video/mp4",
        fileSizeBytes: 1024,
        capturedAtMs: 0,
      },
    ],
    ...overrides,
  };
}

describe("ingestGlassesWalkthrough", () => {
  it("writes one files row per artifact, scoped to the deal", async () => {
    const result = await ingestGlassesWalkthrough(tenantDb, baseInput(), { artifactStore: healthyStore() });

    expect(result.files).toHaveLength(1);
    expect(result.files[0]!.created).toBe(true);

    const rows = await tenantDb.select().from(files).where(eq(files.dealId, DEAL));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.clientUploadId).toBe("artifact-1");
    expect(rows[0]!.mimeType).toBe("video/mp4");
    expect(rows[0]!.category).toBe("other"); // video has no dedicated FILE_CATEGORIES entry
    expect(rows[0]!.uploadedBy).toBe(USER);
  });

  it("files a photo artifact under the 'photo' category", async () => {
    const input = baseInput({
      artifacts: [
        {
          idempotencyKey: "photo-1",
          kind: "photo",
          originalFilename: "frame.jpg",
          mimeType: "image/jpeg",
          fileSizeBytes: 2048,
          capturedAtMs: null,
        },
      ],
    });
    await ingestGlassesWalkthrough(tenantDb, input, {
      artifactStore: healthyStore({ head: async () => ({ contentType: "image/jpeg", contentLength: 2048 }) }),
    });

    const [row] = await tenantDb.select().from(files).where(eq(files.clientUploadId, "photo-1"));
    expect(row.category).toBe("photo");
  });

  it("is idempotent PER ARTIFACT: retrying the same idempotencyKey returns the existing row, not a second one", async () => {
    const input = baseInput();
    const first = await ingestGlassesWalkthrough(tenantDb, input, { artifactStore: healthyStore() });
    const second = await ingestGlassesWalkthrough(tenantDb, input, { artifactStore: healthyStore() });

    expect(first.files[0]!.fileId).toBe(second.files[0]!.fileId);
    expect(second.files[0]!.created).toBe(false);

    const rows = await tenantDb.select().from(files).where(eq(files.clientUploadId, "artifact-1"));
    expect(rows).toHaveLength(1); // NOT two — this is the exact defect the task calls out
  });

  it("refuses a reused idempotencyKey pointed at a DIFFERENT deal rather than silently reassociating it", async () => {
    await ingestGlassesWalkthrough(tenantDb, baseInput({ dealId: DEAL }), { artifactStore: healthyStore() });

    await expect(
      ingestGlassesWalkthrough(tenantDb, baseInput({ dealId: OTHER_DEAL, walkId: U("44444") }), {
        artifactStore: healthyStore(),
      })
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("enqueues exactly one glasses_walkthrough_forward job carrying the walk's artifacts", async () => {
    const result = await ingestGlassesWalkthrough(tenantDb, baseInput(), { artifactStore: healthyStore() });

    expect(result.forwarding.status).toBe("queued");
    const jobs = await tenantDb.select().from(jobQueue).where(eq(jobQueue.jobType, GLASSES_WALKTHROUGH_FORWARD_JOB));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload.walkId).toBe(WALK);
    expect(jobs[0]!.payload.artifacts).toHaveLength(1);
    expect(jobs[0]!.payload.artifacts[0].r2Key).toBe(result.files[0]!.r2Key);
    expect(jobs[0]!.status).toBe("pending");
  });

  it("is idempotent PER WALK: retrying the whole completion call does not enqueue a second forward job", async () => {
    const input = baseInput();
    const first = await ingestGlassesWalkthrough(tenantDb, input, { artifactStore: healthyStore() });
    const second = await ingestGlassesWalkthrough(tenantDb, input, { artifactStore: healthyStore() });

    expect(first.forwarding.status).toBe("queued");
    expect(second.forwarding).toEqual({ status: "already_queued", jobId: first.forwarding.jobId });

    const jobs = await tenantDb.select().from(jobQueue).where(eq(jobQueue.jobType, GLASSES_WALKTHROUGH_FORWARD_JOB));
    expect(jobs).toHaveLength(1); // NOT two trock-scope walkthroughs' worth of forwarding
  });

  it("enqueues a NEW forward job once the prior one has dead-lettered (a walk is not stuck forever)", async () => {
    const first = await ingestGlassesWalkthrough(tenantDb, baseInput(), { artifactStore: healthyStore() });
    await tenantDb.update(jobQueue).set({ status: "dead" }).where(eq(jobQueue.id, first.forwarding.jobId));

    const second = await ingestGlassesWalkthrough(tenantDb, baseInput(), { artifactStore: healthyStore() });
    expect(second.forwarding.status).toBe("queued");
    expect(second.forwarding.jobId).not.toBe(first.forwarding.jobId);
  });

  it("400s when the declared artifact was never uploaded to R2 (head returns null)", async () => {
    await expect(
      ingestGlassesWalkthrough(tenantDb, baseInput(), { artifactStore: healthyStore({ head: async () => null }) })
    ).rejects.toMatchObject({ statusCode: 400 });

    const rows = await tenantDb.select().from(files);
    expect(rows).toHaveLength(0); // refused before any write, not a partial file
  });

  it("503s (retryable) when object storage cannot be reached at all — R33: a throw is not an absence", async () => {
    await expect(
      ingestGlassesWalkthrough(tenantDb, baseInput(), {
        artifactStore: healthyStore({
          head: async () => {
            throw new Error("connect ETIMEDOUT");
          },
        }),
      })
    ).rejects.toMatchObject({ statusCode: 503 });
  });

  it("400s on a Content-Length mismatch between the declared and the actual object", async () => {
    await expect(
      ingestGlassesWalkthrough(tenantDb, baseInput(), {
        artifactStore: healthyStore({ head: async () => ({ contentType: "video/mp4", contentLength: 999 }) }),
      })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("400s on a Content-Type mismatch between the declared and the actual object", async () => {
    await expect(
      ingestGlassesWalkthrough(tenantDb, baseInput(), {
        artifactStore: healthyStore({ head: async () => ({ contentType: "audio/wav", contentLength: 1024 }) }),
      })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("skips R2 verification entirely when the store reports itself unconfigured (local dev/CI posture)", async () => {
    const result = await ingestGlassesWalkthrough(tenantDb, baseInput(), {
      artifactStore: healthyStore({
        isConfigured: () => false,
        head: async () => {
          throw new Error("should never be called");
        },
      }),
    });
    expect(result.files).toHaveLength(1);
  });

  it("files EVERY artifact of a multi-artifact walk and carries all of them onto the forward job", async () => {
    const input = baseInput({
      artifacts: [
        {
          idempotencyKey: "video-1",
          kind: "video",
          originalFilename: "clip.mp4",
          mimeType: "video/mp4",
          fileSizeBytes: 4096,
          capturedAtMs: 0,
        },
        {
          idempotencyKey: "audio-1",
          kind: "audio",
          originalFilename: "narration.m4a",
          mimeType: "audio/mp4",
          fileSizeBytes: 2048,
          capturedAtMs: 500,
        },
        {
          idempotencyKey: "photo-1",
          kind: "photo",
          originalFilename: "frame.jpg",
          mimeType: "image/jpeg",
          fileSizeBytes: 1024,
          capturedAtMs: 1200,
        },
      ],
    });
    // `head` returns no contentType/contentLength at all — neither mismatch check fires (both are
    // gated on the field being present), so this test can focus on "every artifact gets filed and
    // forwarded" without also having to model a distinct HEAD response per mimeType/size pair (the
    // single-artifact tests above already cover the mismatch checks in detail).
    const result = await ingestGlassesWalkthrough(tenantDb, input, {
      artifactStore: healthyStore({ head: async () => ({}) }),
    });

    expect(result.files).toHaveLength(3);
    const rows = await tenantDb.select().from(files).where(eq(files.dealId, DEAL));
    expect(rows).toHaveLength(3);

    const jobs = await tenantDb.select().from(jobQueue).where(eq(jobQueue.jobType, GLASSES_WALKTHROUGH_FORWARD_JOB));
    expect(jobs[0]!.payload.artifacts).toHaveLength(3);
  });

  it("tags every artifact of a walk with the same walkId so the project folder can group them", async () => {
    await ingestGlassesWalkthrough(tenantDb, baseInput(), { artifactStore: healthyStore() });
    const [row] = await tenantDb.select().from(files).where(eq(files.clientUploadId, "artifact-1"));
    expect(row.tags).toContain(WALK);
  });

  it("stamps takenAt directly from capturedAtMs — an ABSOLUTE epoch-ms timestamp, not an offset added to capturedAt", async () => {
    // capturedAtMs is `Date.now()` on the phone at the moment of capture (QueuedWalkArtifact.at in
    // mobile/src/walkthrough/upload-core.ts, sent as `a.at` in upload.ts) — an absolute epoch timestamp,
    // NOT an offset from the walk's start, despite what the field name suggests.
    //
    // This test deliberately uses a REALISTIC epoch value (an actual `Date.parse(...)` result) rather than
    // something small like `100` or `5 * 60 * 1000`. A small "offset-shaped" number passes under BOTH
    // `takenAt = capturedAtMs` (correct) AND the previously-shipped `takenAt = capturedAtBaseMs +
    // capturedAtMs` (the bug: adding two absolute epoch timestamps together roughly doubles the value) —
    // at that scale the doubling is a few minutes' difference, easy to miss in a date-string assertion.
    // With a real epoch value the two implementations diverge by ~56 years (2026 -> ~4052), which is
    // exactly the class of bug that shipped to production undetected the first time this was "fixed".
    const artifactCapturedAt = "2026-07-29T14:05:00.000Z";
    const input = baseInput({
      capturedAt: "2026-07-29T14:00:00.000Z",
      artifacts: [
        {
          idempotencyKey: "photo-1",
          kind: "photo",
          originalFilename: "frame.jpg",
          mimeType: "image/jpeg",
          fileSizeBytes: 2048,
          capturedAtMs: new Date(artifactCapturedAt).getTime(), // e.g. 1785333900000 — NOT 300000
        },
      ],
    });
    await ingestGlassesWalkthrough(tenantDb, input, {
      artifactStore: healthyStore({ head: async () => ({ contentType: "image/jpeg", contentLength: 2048 }) }),
    });

    const [row] = await tenantDb.select().from(files).where(eq(files.clientUploadId, "photo-1"));
    // Under the doubling bug this would resolve to on the order of the year 4052, not 2026 — the string
    // comparison below fails loudly rather than silently passing on a near-miss.
    expect(new Date(row.takenAt).toISOString()).toBe(artifactCapturedAt);
  });

  it("stamps takenAt at the walk's capturedAt when an artifact never reports its own capturedAtMs", async () => {
    const input = baseInput({
      capturedAt: "2026-07-29T14:00:00.000Z",
      artifacts: [
        {
          idempotencyKey: "photo-2",
          kind: "photo",
          originalFilename: "frame2.jpg",
          mimeType: "image/jpeg",
          fileSizeBytes: 2048,
          capturedAtMs: null,
        },
      ],
    });
    await ingestGlassesWalkthrough(tenantDb, input, {
      artifactStore: healthyStore({ head: async () => ({ contentType: "image/jpeg", contentLength: 2048 }) }),
    });

    const [row] = await tenantDb.select().from(files).where(eq(files.clientUploadId, "photo-2"));
    expect(new Date(row.takenAt).toISOString()).toBe("2026-07-29T14:00:00.000Z");
  });
});

// ── The forward job's TROCK Scope checkpoint survives a dead row ────────────────────────────────────
//
// Every forward costs real money on the other side (a transcription plus an Anthropic scope extraction),
// so "the walk was already sent" has to be a durable fact about the WALK, not about one job_queue row.
// These exercise the hand-written jsonb SQL in `findGlassesWalkthroughForwardJobState`, which is exactly
// the kind of thing the fake-db unit suite cannot check.

/** Mark a forward job dead and rewrite its payload the way the worker's own `jsonb_set` checkpoint
 *  statements would have — the states a completion retry has to read back and respect. */
async function killJobWithPayload(jobId: number, payloadPatchSql: ReturnType<typeof sql>): Promise<void> {
  await tenantDb.update(jobQueue).set({ status: "dead", payload: payloadPatchSql }).where(eq(jobQueue.id, jobId));
}

describe("ingestGlassesWalkthrough — forward-job checkpoint inheritance across a dead row", () => {
  it("carries a dead job's scopeWalkthroughId onto the replacement, so a late completion retry cannot buy a SECOND scope extraction", async () => {
    const first = await ingestGlassesWalkthrough(tenantDb, baseInput(), { artifactStore: healthyStore() });
    // The worker created the remote walkthrough and checkpointed it, then burned all 10 attempts partway
    // through uploading clips. The remote walkthrough EXISTS.
    await killJobWithPayload(
      first.forwarding.jobId,
      sql`jsonb_set(${jobQueue.payload}, '{scopeWalkthroughId}', '"scope-wt-1"'::jsonb, true)`
    );

    const second = await ingestGlassesWalkthrough(tenantDb, baseInput(), { artifactStore: healthyStore() });
    expect(second.forwarding.status).toBe("queued");
    expect(second.forwarding.jobId).not.toBe(first.forwarding.jobId);

    const [replacement] = await tenantDb.select().from(jobQueue).where(eq(jobQueue.id, second.forwarding.jobId));
    // Without this the replacement payload is blank and the worker creates a second walkthrough — a second
    // billed transcription and a second billed classification, with nothing anywhere saying so.
    expect(replacement.payload.scopeWalkthroughId).toBe("scope-wt-1");
    expect(replacement.payload.scopeCreatePendingRef).toBeUndefined();
  });

  it("carries a dead job's UNRESOLVED pending-create marker forward, so the replacement reconciles instead of creating blind", async () => {
    const first = await ingestGlassesWalkthrough(tenantDb, baseInput(), { artifactStore: healthyStore() });
    // The worker wrote its pre-create marker, sent the create, and never learned the answer. "A create may
    // already have happened" is the whole meaning of this marker; dropping it on the floor is what makes a
    // duplicate possible.
    const pendingRef = `trockcrm:glasses-walkthrough:${WALK}`;
    await killJobWithPayload(
      first.forwarding.jobId,
      sql`jsonb_set(${jobQueue.payload}, '{scopeCreatePendingRef}', to_jsonb(${pendingRef}::text), true)`
    );

    const second = await ingestGlassesWalkthrough(tenantDb, baseInput(), { artifactStore: healthyStore() });
    const [replacement] = await tenantDb.select().from(jobQueue).where(eq(jobQueue.id, second.forwarding.jobId));
    expect(replacement.payload.scopeCreatePendingRef).toBe(pendingRef);
    // Never both: the worker reads scopeWalkthroughId first, so inventing one here would silently convert
    // "we don't know" into "we know", which is the opposite of what the marker means.
    expect(replacement.payload.scopeWalkthroughId).toBeUndefined();
  });

  it("prefers a SETTLED scopeWalkthroughId over a newer row's unresolved marker", async () => {
    const first = await ingestGlassesWalkthrough(tenantDb, baseInput(), { artifactStore: healthyStore() });
    await killJobWithPayload(
      first.forwarding.jobId,
      sql`jsonb_set(${jobQueue.payload}, '{scopeWalkthroughId}', '"scope-wt-1"'::jsonb, true)`
    );
    const second = await ingestGlassesWalkthrough(tenantDb, baseInput(), { artifactStore: healthyStore() });
    // A NEWER dead row that only knows "a create may be in flight". The older row's settled id is strictly
    // better information — it names the walkthrough to reuse instead of forcing a human reconciliation.
    await killJobWithPayload(
      second.forwarding.jobId,
      sql`(${jobQueue.payload} - 'scopeWalkthroughId') || jsonb_build_object('scopeCreatePendingRef', 'ref-2')`
    );

    const third = await ingestGlassesWalkthrough(tenantDb, baseInput(), { artifactStore: healthyStore() });
    const [replacement] = await tenantDb.select().from(jobQueue).where(eq(jobQueue.id, third.forwarding.jobId));
    expect(replacement.payload.scopeWalkthroughId).toBe("scope-wt-1");
    expect(replacement.payload.scopeCreatePendingRef).toBeUndefined();
  });

  it("GUARD: a dead job that never reached TROCK Scope produces a clean, uncheckpointed replacement", async () => {
    const first = await ingestGlassesWalkthrough(tenantDb, baseInput(), { artifactStore: healthyStore() });
    // Dead for a reason that proves nothing was created remotely (an unset TROCK_SCOPE_BASE_URL, say).
    // Inheriting a marker here would dead-letter a walk that is perfectly safe to forward from scratch.
    await tenantDb.update(jobQueue).set({ status: "dead" }).where(eq(jobQueue.id, first.forwarding.jobId));

    const second = await ingestGlassesWalkthrough(tenantDb, baseInput(), { artifactStore: healthyStore() });
    const [replacement] = await tenantDb.select().from(jobQueue).where(eq(jobQueue.id, second.forwarding.jobId));
    expect(replacement.payload.scopeWalkthroughId).toBeUndefined();
    expect(replacement.payload.scopeCreatePendingRef).toBeUndefined();
    expect(replacement.status).toBe("pending");
  });

  it("GUARD: leaves the dead row itself untouched — a human mid-reconciliation is not raced by a mobile retry", async () => {
    const first = await ingestGlassesWalkthrough(tenantDb, baseInput(), { artifactStore: healthyStore() });
    await killJobWithPayload(
      first.forwarding.jobId,
      sql`jsonb_set(${jobQueue.payload}, '{scopeWalkthroughId}', '"scope-wt-1"'::jsonb, true)`
    );

    await ingestGlassesWalkthrough(tenantDb, baseInput(), { artifactStore: healthyStore() });

    const [dead] = await tenantDb.select().from(jobQueue).where(eq(jobQueue.id, first.forwarding.jobId));
    expect(dead.status).toBe("dead"); // NOT silently revived
    expect(dead.attempts).toBe(0);
    const all = await tenantDb.select().from(jobQueue).where(eq(jobQueue.jobType, GLASSES_WALKTHROUGH_FORWARD_JOB));
    expect(all).toHaveLength(2); // a new, plainly visible row — not an edit to the one a human is reading
  });

  it("GUARD: a LIVE job still short-circuits to already_queued and is never replaced", async () => {
    const first = await ingestGlassesWalkthrough(tenantDb, baseInput(), { artifactStore: healthyStore() });
    const second = await ingestGlassesWalkthrough(tenantDb, baseInput(), { artifactStore: healthyStore() });
    expect(second.forwarding).toEqual({ status: "already_queued", jobId: first.forwarding.jobId });
  });
});

// ── Object verification vs. the pinned tenant connection ───────────────────────────────────────────
//
// `tenantMiddleware` has already checked out one of the pool's 20 connections and opened a transaction on
// it before this service is ever called, so every millisecond the verification phase spends is a
// pool slot held by a request doing no database work at all.

function photoArtifacts(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    idempotencyKey: `artifact-${index + 1}`,
    kind: "photo" as const,
    originalFilename: `frame-${index + 1}.jpg`,
    mimeType: "image/jpeg",
    fileSizeBytes: 1024,
    capturedAtMs: null,
  }));
}

describe("ingestGlassesWalkthrough — bounded object verification", () => {
  it("verifies EVERY artifact before the first files write, so a late failure leaves no half-filed walk", async () => {
    const input = baseInput({ artifacts: photoArtifacts(3) });

    await expect(
      ingestGlassesWalkthrough(tenantDb, input, {
        // The second artifact never landed in R2. Verifying artifact-by-artifact interleaved with the
        // inserts leaves artifact-1's row already written when this throws — recoverable only because the
        // request transaction happens to roll it back, which is a property of the CALLER, not of this
        // function.
        artifactStore: healthyStore({ head: async (r2Key) => (r2Key.includes("artifact-2") ? null : {}) }),
      })
    ).rejects.toMatchObject({ statusCode: 400 });

    const rows = await tenantDb.select().from(files);
    expect(rows).toHaveLength(0);
  });

  // GUARD, not a regression: a sequential loop reports the lowest-indexed failure for free, so this
  // passed before the concurrency change too. It exists to keep it true afterwards.
  it("GUARD: reports the LOWEST-indexed bad artifact, so the error a caller sees does not depend on which HEAD returned first", async () => {
    const input = baseInput({ artifacts: photoArtifacts(4) });
    // artifact-4 answers instantly, artifact-2 slowly — under concurrency the fast failure resolves first,
    // and reporting whichever landed first would make this endpoint's 400 nondeterministic.
    await expect(
      ingestGlassesWalkthrough(tenantDb, input, {
        artifactStore: healthyStore({
          head: async (r2Key) => {
            if (r2Key.includes("artifact-4")) return null;
            if (r2Key.includes("artifact-2")) {
              await new Promise((resolve) => setTimeout(resolve, 20));
              return null;
            }
            return {};
          },
        }),
      })
    ).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining("artifact-2") });
  });

  it("issues the HEADs with bounded concurrency rather than one blocking round trip at a time", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const input = baseInput({ artifacts: photoArtifacts(6) });

    await ingestGlassesWalkthrough(tenantDb, input, {
      artifactStore: healthyStore({
        head: async () => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 5));
          inFlight -= 1;
          return {};
        },
      }),
    });

    // Strictly sequential verification pins the tenant connection for artifacts × round-trip; at the 200
    // artifact ceiling that is two orders of magnitude of pool-slot occupancy for zero database work.
    expect(maxInFlight).toBeGreaterThan(1);
  });

  it("gives up the connection with a retryable 503 when object storage stops answering, instead of holding it indefinitely", async () => {
    const input = baseInput({ artifacts: photoArtifacts(2) });

    await expect(
      ingestGlassesWalkthrough(tenantDb, input, {
        // Never settles and never rejects — a black-holed HEAD, which today would pin a pooled
        // transaction until the client gave up or the process died.
        artifactStore: healthyStore({ head: () => new Promise<null>(() => {}) }),
        objectVerificationTimeoutMs: 25,
      })
    ).rejects.toMatchObject({ statusCode: 503 });

    const rows = await tenantDb.select().from(files);
    expect(rows).toHaveLength(0);
  });
});
