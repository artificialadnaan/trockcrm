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
import { migrationSql } from "../../../tests/helpers/migration-sql.js";
import { tenantSchemaSql } from "../../../tests/helpers/tenant-schema-from-drizzle.js";
import { AppError } from "../../middleware/error-handler.js";
import {
  GLASSES_WALKTHROUGH_FORWARD_JOB,
  GLASSES_WALKTHROUGH_VERIFY_CONCURRENCY,
  type GlassesWalkthroughArtifactStore,
  type IngestGlassesWalkthroughInput,
  deriveGlassesWalkthroughClientUploadId,
  ingestGlassesWalkthrough,
  requestGlassesWalkthroughArtifactUploadUrl,
} from "./glasses-walkthrough-service.js";

const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const DEAL = U("11111");
const OTHER_DEAL = U("11112");
const USER = U("22222");
const WALK = U("33333");

/** Rows are found by the DEAL-SCOPED id the service stores, never by the key the client sent — a lookup on
 *  the raw key matches nothing at all. See `deriveGlassesWalkthroughClientUploadId` for why the two differ. */
const storedId = (idempotencyKey: string, dealId: string = DEAL) =>
  deriveGlassesWalkthroughClientUploadId(dealId, idempotencyKey);

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
  // Migration 0213's index, read FROM DISK rather than retyped here. It is the arbiter the enqueue's `ON
  // CONFLICT DO NOTHING` resolves against — without it the overlapping-completion test below writes two
  // forward jobs, which is precisely the production defect. A hand-copied CREATE INDEX would let this suite
  // keep passing against an index that no longer matches the one that ships (a widened predicate, a dropped
  // column), i.e. prove the fix against a fixture instead of against the migration.
  //
  // CONCURRENTLY is the one thing stripped: it exists to avoid locking out a busy production job_queue, and
  // PGlite is a single connection with no concurrent writers to protect — it cannot run it, and running it
  // would test the migration runner's autocommit behaviour rather than the constraint.
  await pg.exec(migrationSql("0213_job_queue_glasses_walkthrough_forward_live_uniq").replace(" CONCURRENTLY", ""));
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
    // Stored DEAL-SCOPED, not as the client sent it — and demonstrably scoped: the same key under another
    // deal is a different stored id, which is the whole reason the cross-deal case below can work at all.
    expect(rows[0]!.clientUploadId).toBe(storedId("artifact-1"));
    expect(rows[0]!.clientUploadId).not.toBe("artifact-1");
    expect(storedId("artifact-1", OTHER_DEAL)).not.toBe(storedId("artifact-1"));
    // The raw key is not lost, just moved off the column that has to be unique.
    expect(rows[0]!.systemFilename).toBe("glasses-walk-artifact-1.mp4");
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

    const [row] = await tenantDb.select().from(files).where(eq(files.clientUploadId, storedId("photo-1")));
    expect(row.category).toBe("photo");
  });

  it("is idempotent PER ARTIFACT: retrying the same idempotencyKey returns the existing row, not a second one", async () => {
    const input = baseInput();
    const first = await ingestGlassesWalkthrough(tenantDb, input, { artifactStore: healthyStore() });
    const second = await ingestGlassesWalkthrough(tenantDb, input, { artifactStore: healthyStore() });

    expect(first.files[0]!.fileId).toBe(second.files[0]!.fileId);
    expect(second.files[0]!.created).toBe(false);

    const rows = await tenantDb.select().from(files).where(eq(files.clientUploadId, storedId("artifact-1")));
    expect(rows).toHaveLength(1); // NOT two — this is the exact defect the task calls out
  });

  it("files the SAME walkId and artifact keys against a SECOND deal instead of colliding on them", async () => {
    // Mobile derives every artifact key from (walkId, kind[, index]) and NOTHING else
    // (walkArtifactIdempotencyKey, mobile/src/walkthrough/upload-core.ts), while `files.client_upload_id`
    // is unique across the whole TENANT. So the two flows that re-file one physical walk under a new deal
    // re-send byte-identical keys: a mis-tagged walk corrected to the right deal, and a recovered orphan
    // walk whose dealId a human supplies at recovery time (toRecoveredQueuedWalk — nothing on disk says
    // which deal it belongs to, so the FIRST attempt can be the wrong one).
    //
    // Stored raw, deal B's insert conflicts with deal A's row, and the completion is then refused forever:
    // correcting a mis-filed walk becomes impossible, and the evidence stays on the wrong job.
    const first = await ingestGlassesWalkthrough(tenantDb, baseInput({ dealId: DEAL }), {
      artifactStore: healthyStore(),
    });
    const second = await ingestGlassesWalkthrough(tenantDb, baseInput({ dealId: OTHER_DEAL }), {
      artifactStore: healthyStore(),
    });

    expect(second.files[0]!.created).toBe(true);
    expect(second.files[0]!.fileId).not.toBe(first.files[0]!.fileId);
    // The key the CLIENT sent is what comes back. Deal scoping is a STORAGE detail: mobile matches the
    // response against its own queue entries by the key it generated, so leaking the stored form here
    // would strand every artifact as unacknowledged and re-upload the whole walk on the next drain.
    expect(second.files[0]!.idempotencyKey).toBe("artifact-1");

    const rows = await tenantDb.select().from(files);
    expect(rows).toHaveLength(2);
    expect(rows.map((r: { dealId: string }) => r.dealId).sort()).toEqual([DEAL, OTHER_DEAL].sort());
    // Two DISTINCT stored ids — the per-artifact retry dedupe is still a unique-index property, not a
    // property that was dropped to make the above pass.
    expect(new Set(rows.map((r: { clientUploadId: string }) => r.clientUploadId)).size).toBe(2);
  });

  it("GUARD: still refuses a stored id that already belongs to a DIFFERENT deal rather than relaying its row", async () => {
    // Deal-scoping makes this unreachable through the ingress itself, which is exactly why the check has
    // to be tested against a row planted by hand: a stored id that is already some other deal's can now
    // only come from a digest collision or a future producer emitting the same shape. The failure it
    // prevents is silent and expensive either way — the response would hand this walk's forward job
    // another deal's fileId/r2Key, and the forward job has no way to notice it is shipping the wrong
    // evidence to TROCK Scope.
    await tenantDb.insert(files).values({
      category: "other",
      displayName: "someone-elses.mp4",
      systemFilename: "someone-elses.mp4",
      originalFilename: "someone-elses.mp4",
      mimeType: "video/mp4",
      fileSizeBytes: 1024,
      fileExtension: ".mp4",
      r2Key: "dallas/deals/other/collision.mp4",
      r2Bucket: "trock-crm-files",
      dealId: OTHER_DEAL,
      uploadedBy: USER,
      clientUploadId: storedId("artifact-1"), // the id DEAL's artifact-1 will derive
    });

    await expect(
      ingestGlassesWalkthrough(tenantDb, baseInput({ dealId: DEAL }), { artifactStore: healthyStore() })
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

  it("scopes the per-walk dedupe to the DEAL: one walkId completed against two deals forwards BOTH", async () => {
    // walkId is generated on the phone, and nothing makes it unique across deals — the same physical walk
    // can legitimately be completed against two deals (a mis-tagged walk corrected and re-sent; two deals
    // sharing one site visit), and a client that reuses or collides on a walkId is not exotic.
    //
    // Deduping on walkId ALONE collapses those into one forward job. The first deal's job is enqueued, the
    // second deal's completion finds it "already queued", and the second deal NEVER gets its scope — the
    // walk files into its project folder and then silently never reaches TROCK Scope. That is the worst
    // shape of failure available here: a success response, a full project folder, and no scope, with
    // nothing anywhere recording that a forward was skipped.
    const first = await ingestGlassesWalkthrough(tenantDb, baseInput({ dealId: DEAL }), {
      artifactStore: healthyStore(),
    });
    // The SAME artifact keys, not distinct ones — that is what mobile actually re-sends when a walk is
    // re-filed, and the artifact-level and walk-level scoping have to hold together or the request fails
    // before the enqueue this test is about is ever reached.
    const second = await ingestGlassesWalkthrough(tenantDb, baseInput({ dealId: OTHER_DEAL }), {
      artifactStore: healthyStore(),
    });

    expect(first.forwarding.status).toBe("queued");
    expect(second.forwarding.status).toBe("queued"); // NOT already_queued
    expect(second.forwarding.jobId).not.toBe(first.forwarding.jobId);

    const jobs = await tenantDb.select().from(jobQueue).where(eq(jobQueue.jobType, GLASSES_WALKTHROUGH_FORWARD_JOB));
    expect(jobs).toHaveLength(2);
    expect(jobs.map((j: { payload: { dealId: string } }) => j.payload.dealId).sort()).toEqual([DEAL, OTHER_DEAL].sort());
  });

  it("REGRESSION: two OVERLAPPING completions of one (walkId, dealId) still enqueue exactly ONE forward job", async () => {
    // The sequential retry above is the easy half. This is the half that costs money: mobile's first
    // completion response times out in flight, the drain retries, and the two requests OVERLAP — so both
    // run their "is a forward already scheduled?" lookup before either has inserted. A read that takes no
    // lock and an index that is not unique serialise nothing, so both saw nothing and both enqueued: two
    // forwards, two remote walkthroughs, two transcriptions, two Anthropic scope extractions, all billed,
    // for one walk. Nothing anywhere records that it happened.
    //
    // Interleaved rather than truly parallel — PGlite is a single connection, so this lane can only
    // demonstrate the ARBITER (the partial unique index refusing the second insert), never the WAIT (real
    // Postgres blocking the loser's speculative insertion until the winner commits). That is enough,
    // because the arbiter is the part that has to exist: without it the wait has nothing to enforce.
    const input = baseInput();
    const [first, second] = await Promise.all([
      ingestGlassesWalkthrough(tenantDb, input, { artifactStore: healthyStore() }),
      ingestGlassesWalkthrough(tenantDb, input, { artifactStore: healthyStore() }),
    ]);

    const jobs = await tenantDb.select().from(jobQueue).where(eq(jobQueue.jobType, GLASSES_WALKTHROUGH_FORWARD_JOB));
    expect(jobs).toHaveLength(1);
    // Both callers are answered with the SAME job. The loser must not be handed a NaN/undefined jobId
    // either: mobile logs it, and "queued job undefined" is indistinguishable from "never queued".
    expect(first.forwarding.jobId).toBe(jobs[0]!.id);
    expect(second.forwarding.jobId).toBe(jobs[0]!.id);
    expect([first.forwarding.status, second.forwarding.status].sort()).toEqual(["already_queued", "queued"]);
  });

  it("GUARD: overlapping completions of one walkId against TWO deals still enqueue BOTH forwards", async () => {
    // The half a too-broad guard breaks. Serialising on the walkId alone — or on a unique index that
    // forgot the dealId — turns the second deal's forward into a silent no-op: a 201, a full project
    // folder, and no scope, which is strictly worse than the duplicate this fix exists to prevent.
    const [first, second] = await Promise.all([
      ingestGlassesWalkthrough(tenantDb, baseInput({ dealId: DEAL }), { artifactStore: healthyStore() }),
      ingestGlassesWalkthrough(tenantDb, baseInput({ dealId: OTHER_DEAL }), { artifactStore: healthyStore() }),
    ]);

    expect(first.forwarding.status).toBe("queued");
    expect(second.forwarding.status).toBe("queued");
    const jobs = await tenantDb.select().from(jobQueue).where(eq(jobQueue.jobType, GLASSES_WALKTHROUGH_FORWARD_JOB));
    expect(jobs).toHaveLength(2);
  });

  it("GUARD: the per-walk dedupe still holds WITHIN one deal (the dealId predicate did not disable it)", async () => {
    // The obvious wrong way to fix the above is to widen the lookup until it stops matching anything —
    // which would re-open the duplicate-forward defect the dedupe exists for, at real money per forward.
    const input = baseInput({ dealId: DEAL });
    const first = await ingestGlassesWalkthrough(tenantDb, input, { artifactStore: healthyStore() });
    const second = await ingestGlassesWalkthrough(tenantDb, input, { artifactStore: healthyStore() });
    expect(second.forwarding).toEqual({ status: "already_queued", jobId: first.forwarding.jobId });
  });

  it("does not inherit ANOTHER deal's TROCK Scope checkpoint onto this deal's forward job", async () => {
    // The checkpoint-inheritance read runs through the same lookup. Unscoped, a dead row from deal A hands
    // deal B a `scopeWalkthroughId` naming A's remote walkthrough — so B's clips would be uploaded into
    // A's walkthrough and B's scope rows would come back attached to the wrong deal. Silent, and a
    // cross-tenant-shaped data mix inside one office.
    const first = await ingestGlassesWalkthrough(tenantDb, baseInput({ dealId: DEAL }), {
      artifactStore: healthyStore(),
    });
    await killJobWithPayload(
      first.forwarding.jobId,
      sql`jsonb_set(${jobQueue.payload}, '{scopeWalkthroughId}', '"scope-wt-DEAL-A"'::jsonb, true)`
    );

    const second = await ingestGlassesWalkthrough(tenantDb, baseInput({ dealId: OTHER_DEAL }), {
      artifactStore: healthyStore(),
    });
    const [replacement] = await tenantDb.select().from(jobQueue).where(eq(jobQueue.id, second.forwarding.jobId));
    expect(replacement.payload.scopeWalkthroughId).toBeUndefined();
    expect(replacement.payload.scopeCreatePendingRef).toBeUndefined();
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

  it("GUARD: pairs each forward-job artifact with its OWN metadata, resolved by idempotency key not by position", async () => {
    // The payload used to index back into `input.artifacts` by array position, which is only correct while
    // fileResults happens to be built in input order. Nothing enforced that — it was an invariant held by
    // one `for` loop, and the batched write below rewrites exactly that loop. Get it wrong and every
    // artifact is forwarded under a NEIGHBOUR's mimeType and filename: TROCK Scope transcodes a jpeg as
    // audio, and the mismatch is invisible from this side.
    //
    // Every field below is distinct per artifact, so any position/key confusion misaligns visibly.
    const input = baseInput({
      artifacts: [
        {
          idempotencyKey: "zzz-last-alphabetically",
          kind: "video",
          originalFilename: "clip.mp4",
          mimeType: "video/mp4",
          fileSizeBytes: 4096,
          capturedAtMs: 1_700_000_000_000,
        },
        {
          idempotencyKey: "aaa-first-alphabetically",
          kind: "photo",
          originalFilename: "frame.jpg",
          mimeType: "image/jpeg",
          fileSizeBytes: 1024,
          capturedAtMs: 1_700_000_005_000,
        },
        {
          idempotencyKey: "mmm-middle",
          kind: "audio",
          originalFilename: "narration.m4a",
          mimeType: "audio/mp4",
          fileSizeBytes: 2048,
          capturedAtMs: 1_700_000_009_000,
        },
      ],
    });
    await ingestGlassesWalkthrough(tenantDb, input, { artifactStore: healthyStore({ head: async () => ({}) }) });

    const [job] = await tenantDb.select().from(jobQueue).where(eq(jobQueue.jobType, GLASSES_WALKTHROUGH_FORWARD_JOB));
    const byKey = new Map(
      (job.payload.artifacts as { idempotencyKey: string }[]).map((a) => [a.idempotencyKey, a])
    );
    expect(byKey.size).toBe(3);
    for (const artifact of input.artifacts) {
      expect(byKey.get(artifact.idempotencyKey)).toMatchObject({
        kind: artifact.kind,
        mimeType: artifact.mimeType,
        originalFilename: artifact.originalFilename,
        fileSizeBytes: artifact.fileSizeBytes,
        capturedAtMs: artifact.capturedAtMs,
      });
    }
  });

  it("GUARD: reports `created` per artifact when a retry re-sends a walk that only PARTLY landed", async () => {
    // The mobile queue can complete a walk, lose the response, add nothing, and retry — but it can also
    // retry a walk whose earlier attempt filed only some artifacts. `created` is per-artifact and drives
    // what the caller reports; a batched write that derives it from "did the whole statement insert
    // anything" collapses that distinction. Two already-filed and one new is the mixed case.
    const firstTwo = baseInput({ artifacts: photoArtifacts(2) });
    await ingestGlassesWalkthrough(tenantDb, firstTwo, { artifactStore: healthyStore({ head: async () => ({}) }) });

    const allThree = baseInput({ artifacts: photoArtifacts(3) });
    const result = await ingestGlassesWalkthrough(tenantDb, allThree, {
      artifactStore: healthyStore({ head: async () => ({}) }),
    });

    expect(result.files.map((f) => [f.idempotencyKey, f.created])).toEqual([
      ["artifact-1", false],
      ["artifact-2", false],
      ["artifact-3", true],
    ]);
    const rows = await tenantDb.select().from(files).where(eq(files.dealId, DEAL));
    expect(rows).toHaveLength(3); // three rows total, not five
  });

  it("GUARD: refuses an object FAR larger than the size the client declared, so a mis-declared upload is never filed or forwarded", async () => {
    // The presigned PUT cannot enforce the declared size at the R2 boundary (see
    // glasses-walkthrough-store.ts for why signing Content-Length would break every mobile upload), so the
    // completion-time HEAD is the enforcement point. A 1 KiB declaration backed by a 2 GiB object must
    // never become a files row or a forward job.
    await expect(
      ingestGlassesWalkthrough(tenantDb, baseInput(), {
        artifactStore: healthyStore({
          head: async () => ({ contentType: "video/mp4", contentLength: 2 * 1024 * 1024 * 1024 }),
        }),
      })
    ).rejects.toMatchObject({ statusCode: 400 });

    expect(await tenantDb.select().from(files)).toHaveLength(0);
    expect(await tenantDb.select().from(jobQueue)).toHaveLength(0);
  });

  it("tags every artifact of a walk with the same walkId so the project folder can group them", async () => {
    await ingestGlassesWalkthrough(tenantDb, baseInput(), { artifactStore: healthyStore() });
    const [row] = await tenantDb.select().from(files).where(eq(files.clientUploadId, storedId("artifact-1")));
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

    const [row] = await tenantDb.select().from(files).where(eq(files.clientUploadId, storedId("photo-1")));
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

    const [row] = await tenantDb.select().from(files).where(eq(files.clientUploadId, storedId("photo-2")));
    expect(new Date(row.takenAt).toISOString()).toBe("2026-07-29T14:00:00.000Z");
  });
});

// ── A filed artifact's bytes are not re-presignable ────────────────────────────────────────────────
//
// The R2 key is a pure function of (officeSlug, dealId, walkId, idempotencyKey) — that determinism is what
// makes a dropped upload retryable at the same destination. It also means the presign route can be asked
// for a fresh PUT URL for a key whose bytes are ALREADY filed, and a PUT to it replaces those bytes behind
// an immutable `files` row: the row's size, its mimeType, the TROCK Scope scope derived from it and every
// audit read of it still describe content that is no longer there. Whether the artifact is filed is a
// `files` question, so this belongs in the real-SQL lane and not in the pure-logic suite.

describe("requestGlassesWalkthroughArtifactUploadUrl — against already-filed bytes", () => {
  const uploadUrlInput = (overrides: Partial<Record<string, unknown>> = {}) => ({
    dealId: DEAL,
    walkId: WALK,
    idempotencyKey: "artifact-1",
    kind: "video" as const,
    mimeType: "video/mp4",
    fileSizeBytes: 1024,
    ...overrides,
  });

  it("REGRESSION: refuses a presign for an artifact that is already filed, instead of handing out a writable URL for its key", async () => {
    await ingestGlassesWalkthrough(tenantDb, baseInput(), { artifactStore: healthyStore() });

    await expect(
      requestGlassesWalkthroughArtifactUploadUrl({
        tenantDb,
        officeSlug: "dallas",
        input: uploadUrlInput(),
        artifactStore: healthyStore(),
      })
    ).rejects.toMatchObject({ statusCode: 409, code: "GLASSES_WALKTHROUGH_ARTIFACT_ALREADY_FILED" });
  });

  it("REGRESSION: refuses even when object storage is unconfigured, so the dev/CI mock-URL branch is not a way around it", async () => {
    // The unconfigured branch returns a `mock://` URL nobody can PUT to, which makes it tempting to let it
    // skip the check. It must not: this is a rule about the RECORD, and a rule that holds only when an
    // environment variable is set is one that silently stops holding in the environment where someone is
    // most likely to be reproducing a walk by hand.
    await ingestGlassesWalkthrough(tenantDb, baseInput(), { artifactStore: healthyStore() });

    await expect(
      requestGlassesWalkthroughArtifactUploadUrl({
        tenantDb,
        officeSlug: "dallas",
        input: uploadUrlInput(),
        artifactStore: healthyStore({ isConfigured: () => false }),
      })
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("still presigns an artifact that was presigned but never successfully PUT — the normal dropped-upload recovery", async () => {
    // The ONE path this must not break. A mobile PUT that dies mid-body leaves no `files` row (the walk was
    // never completed), and the drain's whole recovery strategy is to ask for the same key again. Keying
    // the refusal on the object's presence in R2 rather than on the filed record would have broken exactly
    // this: bytes can be in the bucket for an artifact no completion has ever accepted.
    const result = await requestGlassesWalkthroughArtifactUploadUrl({
      tenantDb,
      officeSlug: "dallas",
      input: uploadUrlInput(),
      artifactStore: healthyStore(),
    });
    expect(result.uploadUrl).toBe("https://example.com/put");
  });

  it("still presigns the SAME walk and artifact key under a DIFFERENT deal", async () => {
    // Mobile's key is a function of (walkId, kind[, index]) and nothing else, so re-filing one physical
    // walk against the correct deal re-sends byte-identical keys. Those are different R2 keys and a
    // different `files` row; a refusal keyed on the raw key rather than the deal-scoped stored id would
    // make correcting a mis-tagged walk impossible — the same defect 0212 exists to repair.
    await ingestGlassesWalkthrough(tenantDb, baseInput({ dealId: DEAL }), { artifactStore: healthyStore() });

    const result = await requestGlassesWalkthroughArtifactUploadUrl({
      tenantDb,
      officeSlug: "dallas",
      input: uploadUrlInput({ dealId: OTHER_DEAL }),
      artifactStore: healthyStore(),
    });
    expect(result.r2Key).toContain(`/deals/${OTHER_DEAL}/`);
  });

  it("still presigns a SECOND artifact of a walk whose first artifact is already filed", async () => {
    // The refusal is per ARTIFACT, not per walk. A walk whose video landed and whose audio did not is the
    // ordinary partial-upload state; refusing the whole walk would strand every remaining artifact.
    await ingestGlassesWalkthrough(tenantDb, baseInput(), { artifactStore: healthyStore() });

    const result = await requestGlassesWalkthroughArtifactUploadUrl({
      tenantDb,
      officeSlug: "dallas",
      input: uploadUrlInput({ idempotencyKey: "artifact-2" }),
      artifactStore: healthyStore(),
    });
    expect(result.r2Key).toContain("artifact-2");
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
    // MORE artifacts than the concurrency limit, deliberately. With 6 artifacts and a limit of 8 the
    // ceiling is unobservable — the artifact count caps the fan-out, so an implementation that dispatched
    // ALL of them at once (unbounded `Promise.all`, the thing this limit exists to prevent) passes
    // identically. The bound only becomes testable once there is more work than slots.
    const input = baseInput({ artifacts: photoArtifacts(GLASSES_WALKTHROUGH_VERIFY_CONCURRENCY + 6) });

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
    // ...and the CEILING, which is the half that protects the other side. Unbounded fan-out on a
    // 200-artifact walk is 200 simultaneous R2 connections from one request; the limit is what keeps this
    // endpoint from becoming its own thundering herd. Asserting only the floor lets that regress silently.
    expect(maxInFlight).toBeLessThanOrEqual(GLASSES_WALKTHROUGH_VERIFY_CONCURRENCY);
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

  it("stops DISPATCHING once the deadline fires, not just waiting", async () => {
    // The deadline used to end the wait without ending the dispatch. Each of the 8 workers was still
    // parked in its `while` loop, so every HEAD that settled after the timeout picked up the next
    // index and issued another request — into a store that had just proven it was not answering. For
    // a 200-artifact walk that is ~192 further requests fired AFTER the caller already had its 503,
    // and because a 503 is retryable the client's next attempt stacks another round on top: the
    // deadline was multiplying load during precisely the slowdown it exists to contain.
    let issued = 0;
    const store = healthyStore({
      head: async () => {
        issued += 1;
        await new Promise((resolve) => setTimeout(resolve, 40));
        return { contentType: "image/jpeg", contentLength: 1024 };
      },
    });

    await expect(
      ingestGlassesWalkthrough(tenantDb, baseInput({ artifacts: photoArtifacts(60) }), {
        artifactStore: store,
        objectVerificationTimeoutMs: 60,
      })
    ).rejects.toMatchObject({ statusCode: 503 });

    const atDeadline = issued;
    // Several more 40ms rounds' worth of time. Only the requests already in flight when the deadline
    // fired may still settle — at most one per worker, hence the concurrency allowance.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(issued).toBeLessThanOrEqual(atDeadline + GLASSES_WALKTHROUGH_VERIFY_CONCURRENCY);
  });
});
