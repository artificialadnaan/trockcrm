// REAL-SQL (PGlite) proof for `ingestGlassesWalkthrough`: the `files` row writes and the `job_queue`
// enqueue. Same rationale as walkthrough-ingress-service.runtime.test.ts (the return path's own runtime
// suite) for why this needs real SQL rather than a mocked db — `files` has ten NOT NULL columns Drizzle's
// insert type does not fully enforce, and the partial unique index on `client_upload_id` (the mechanism
// this suite's idempotency tests are ABOUT) only exists in real SQL, not in the type system.
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { files, glassesWalkthroughs, jobQueue, photoAuditLog } from "@trock-crm/shared/schema";
import { migrationSql } from "../../../tests/helpers/migration-sql.js";
import { tenantSchemaSql } from "../../../tests/helpers/tenant-schema-from-drizzle.js";
import { AppError } from "../../middleware/error-handler.js";
import { recordUploadedFileSideEffects } from "../files/upload-workflow.js";
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
  // `photo_audit_log` is here because a filed STILL is an ordinary photo as far as the rest of the app is
  // concerned: the ingress writes the same "uploaded" audit row the field-photo path writes, and an
  // island table (no FKs — see tenantSchemaSql's docblock) is enough to prove it.
  await pg.exec(tenantSchemaSql("public", [files, jobQueue, photoAuditLog, glassesWalkthroughs]));
  // `tenantSchemaSql` deliberately omits indexes/unique constraints (see its own docblock) — but
  // `ingestGlassesWalkthrough`'s idempotency relies on the REAL partial unique index migration 0170
  // creates (`files_client_upload_id_key`), so it has to be added by hand here for the
  // `onConflictDoNothing` path to mean anything against this schema.
  await pg.exec(
    "CREATE UNIQUE INDEX files_client_upload_id_key ON files (client_upload_id) WHERE client_upload_id IS NOT NULL"
  );
  // Same reason, one table over: `tenantSchemaSql` omits indexes, and migration 0214's
  // `glasses_walkthroughs_deal_walk_uidx` is what makes the walkthrough-row write idempotent across a
  // re-ingest. Without it the `onConflictDoNothing` below arbitrates against nothing and a retried
  // completion silently writes a second row.
  //
  // Hand-written here (rather than executed from disk like 0213's) only because 0214 is a per-schema
  // DO-loop and a TENANT_SCHEMA block naming `office_dallas`, neither of which addresses the `public`
  // schema this island suite builds. The file that actually ships is executed, against both of its blocks,
  // in server/tests/migrations/0214-glasses-walkthroughs.runtime.test.ts — so the risk this hand copy
  // normally carries (a suite passing against an index the migration no longer creates) is covered there.
  await pg.exec(
    "CREATE UNIQUE INDEX glasses_walkthroughs_deal_walk_uidx ON glasses_walkthroughs (deal_id, walk_id)"
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
  await pg.exec("DELETE FROM photo_audit_log");
  await pg.exec("DELETE FROM glasses_walkthroughs");
});

/** A healthy store that agrees with whatever the payload declares — every happy-path test runs THROUGH
 *  the R2 verification (isConfigured: true) rather than hiding behind a "not configured" skip, mirroring
 *  the return path's own default-healthy-store convention. */
function healthyStore(overrides: Partial<GlassesWalkthroughArtifactStore> = {}): GlassesWalkthroughArtifactStore {
  return {
    isConfigured: () => true,
    head: async () => ({ contentType: "video/mp4", contentLength: 1024 }),
    // Echoes the expiry it was asked for, as the real store does — see the unit suite's `fakeStore` for
    // why a hardcoded 1800 here is a store that ignores its port, not a harmless stub.
    presignUpload: async (_r2Key, _mimeType, _fileSizeBytes, expiresInSeconds) => ({
      uploadUrl: "https://example.com/put",
      expiresIn: expiresInSeconds,
    }),
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
    // Null by default: the client stating no job type is the shape every walk filed to date has, so
    // that is what the unmodified fixture must exercise.
    jobType: null,
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

// ── A walk's stills are ordinary photos to everything downstream ───────────────────────────────────
//
// Filing a `files` row with `category: 'photo'` is only half of what the rest of this codebase means by
// "a photo arrived". The other half is the durable `file.uploaded` domain event, which is the ONLY thing
// that starts the photo pipeline: the worker's handler (worker/src/jobs/index.ts) runs `extractExif` —
// which reads the object's own EXIF and backfills `taken_at` / `geo_lat` / `geo_lng` — and, on a
// Procore-linked deal, enqueues `procore_photo_sync` so the still lands in the project's photo album.
// Neither is reachable any other way. Without the event a glasses still is a row that LOOKS right in the
// table and is invisible to every process that acts when a photo arrives.
//
// These live in the real-SQL lane because the property under test is "which rows did the batched
// `ON CONFLICT DO NOTHING ... RETURNING` actually create" — a fact only the unique index produces.

/** The office the completion route always supplies (`officeId: office.id`); only the older fixtures above
 *  leave it null. `job_queue.office_id` is what the worker resolves the tenant schema from, so an event
 *  emitted without it reaches the handler and can do nothing there. */
const OFFICE = U("44444");

/** A walk of `count` stills and nothing else. `head` returns neither contentType nor contentLength, so
 *  neither mismatch check fires — these tests are about what is emitted, not about verification. */
const stillsWalk = (count: number, overrides: Partial<IngestGlassesWalkthroughInput> = {}) =>
  baseInput({ officeId: OFFICE, artifacts: photoArtifacts(count), ...overrides });
const blindStore = () => healthyStore({ head: async () => ({}) });

const domainEvents = () =>
  tenantDb.select().from(jobQueue).where(eq(jobQueue.jobType, "domain_event"));

// The CRM's own record that this walk EXISTS (migration 0214), which is what the deal page's AI-walk panel
// reads. Distinct from everything else this module writes: the `files` rows say the artifacts are in the
// project folder, and the `job_queue` row says a forward is scheduled — neither answers "which glasses
// walks does this deal have, and which TROCK Scope walkthrough did each become".
describe("ingestGlassesWalkthrough — the glasses_walkthroughs read model", () => {
  it("stores the job type the client stated, and puts it on the forward job's payload", async () => {
    // Two writes, one fact. The read-model column is what a reader of the CRM sees; the payload copy is
    // what actually reaches TROCK Scope. They are written in different statements, so a change that
    // updates one and not the other looks correct on the deal page and grades against the wrong catalog.
    await ingestGlassesWalkthrough(tenantDb, baseInput({ jobType: "roofing_envelope" }), {
      artifactStore: healthyStore(),
    });

    const rows = await tenantDb.select().from(glassesWalkthroughs);
    expect(rows[0]!.jobType).toBe("roofing_envelope");

    const jobs = await tenantDb.select().from(jobQueue);
    expect((jobs[0]!.payload as Record<string, unknown>).jobType).toBe("roofing_envelope");
  });

  it("leaves the job type NULL when nobody stated one", async () => {
    // The shape of every walk filed to date. NULL has to reach the forward job so it can omit the field
    // and let TROCK Scope apply its own default, which is what makes this change a no-op on ingest.
    await ingestGlassesWalkthrough(tenantDb, baseInput(), { artifactStore: healthyStore() });

    const rows = await tenantDb.select().from(glassesWalkthroughs);
    expect(rows[0]!.jobType).toBeNull();

    const jobs = await tenantDb.select().from(jobQueue);
    expect((jobs[0]!.payload as Record<string, unknown>).jobType ?? null).toBeNull();
  });

  it("writes ONE row carrying the deal, the walk, the capture time and the capturing user", async () => {
    await ingestGlassesWalkthrough(tenantDb, baseInput(), { artifactStore: healthyStore() });

    const rows = await tenantDb.select().from(glassesWalkthroughs);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.dealId).toBe(DEAL);
    expect(rows[0]!.walkId).toBe(WALK);
    expect(rows[0]!.capturedByUserId).toBe(USER);
    // The WALK's own capture time, not this request's clock — those differ by however long the upload took,
    // which over jobsite cellular is routinely hours.
    expect(rows[0]!.capturedAt.toISOString()).toBe("2026-07-30T15:04:00.000Z");
    // NULL, and it must be: this module never calls TROCK Scope (that independence is the whole basis of
    // the crew's copy surviving an outage), so at this point the remote walkthrough genuinely does not
    // exist. NULL is exactly what the panel renders as "processing"; the forward job stamps it later.
    expect(rows[0]!.scopeWalkthroughId).toBeNull();
  });

  it("REGRESSION: retrying the WHOLE completion does not write a second row", async () => {
    // Mobile retries a completion whose response timed out in flight, and a recovered walk is re-filed from
    // an on-disk directory scan. A second row per retry is a duplicate walk on the deal page and a
    // duplicate TROCK Scope request per poll, for one site visit.
    const input = baseInput();
    await ingestGlassesWalkthrough(tenantDb, input, { artifactStore: healthyStore() });
    await ingestGlassesWalkthrough(tenantDb, input, { artifactStore: healthyStore() });
    await ingestGlassesWalkthrough(tenantDb, input, { artifactStore: healthyStore() });

    expect(await tenantDb.select().from(glassesWalkthroughs)).toHaveLength(1);
  });

  it("REGRESSION: two OVERLAPPING completions of one walk still leave exactly ONE row", async () => {
    // The sequential retry above is the easy half. Two completions in flight at once both reach the insert,
    // and it is the unique index — not a prior read — that decides. Interleaved rather than parallel for
    // the reason the forward-job version of this test gives: PGlite is a single connection, so this lane
    // demonstrates the ARBITER, which is the part that has to exist.
    const input = baseInput();
    await Promise.all([
      ingestGlassesWalkthrough(tenantDb, input, { artifactStore: healthyStore() }),
      ingestGlassesWalkthrough(tenantDb, input, { artifactStore: healthyStore() }),
    ]);

    expect(await tenantDb.select().from(glassesWalkthroughs)).toHaveLength(1);
  });

  it("REGRESSION: writes the row on a retry whose forward is ALREADY LIVE, which returns early", async () => {
    // The placement of this write is load-bearing. The live-forward branch RETURNS EARLY, and a completion
    // retry for a walk whose forward is already queued is the most common second call this endpoint gets —
    // so a write placed after that return would exist only for walks whose FIRST completion reached it. A
    // walk whose first attempt died after its `files` write, or one enqueued before 0214 shipped (there is
    // such a row in production), would then be filed, forwarded, scoped, and invisible on the deal page
    // forever.
    //
    // Modelled by removing the row the first completion wrote, leaving the live forward job exactly as
    // those two cases leave it: a scheduled forward with no read-model row behind it.
    const input = baseInput();
    const first = await ingestGlassesWalkthrough(tenantDb, input, { artifactStore: healthyStore() });
    await pg.exec("DELETE FROM glasses_walkthroughs");

    const second = await ingestGlassesWalkthrough(tenantDb, input, { artifactStore: healthyStore() });
    expect(second.forwarding).toEqual({ status: "already_queued", jobId: first.forwarding.jobId });

    const rows = await tenantDb.select().from(glassesWalkthroughs);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.walkId).toBe(WALK);
  });

  it("GUARD: the same walkId filed against a SECOND deal gets its OWN row", async () => {
    // walkId is minted on the phone and identifies a physical walk, not a piece of work. Re-filing one walk
    // against a second deal is a supported correction; scoped to walk_id alone, the second deal would be
    // refused and its panel would stay empty forever.
    await ingestGlassesWalkthrough(tenantDb, baseInput({ dealId: DEAL }), { artifactStore: healthyStore() });
    await ingestGlassesWalkthrough(tenantDb, baseInput({ dealId: OTHER_DEAL }), {
      artifactStore: healthyStore(),
    });

    const rows = await tenantDb.select().from(glassesWalkthroughs);
    expect(rows).toHaveLength(2);
    expect(rows.map((r: { dealId: string }) => r.dealId).sort()).toEqual([DEAL, OTHER_DEAL].sort());
  });

  it("GUARD: keeps the FIRST completion's capture facts when a retry reports different ones", async () => {
    // DO NOTHING, not DO UPDATE. Every column here is a fact about the WALK, and a later retry — plausibly
    // from a different session on a recovered walk, where nothing on disk records who captured it — has no
    // better information than the completion that was actually there.
    await ingestGlassesWalkthrough(tenantDb, baseInput(), { artifactStore: healthyStore() });
    await ingestGlassesWalkthrough(
      tenantDb,
      baseInput({ capturedAt: "2026-08-01T09:00:00.000Z", userId: U("22223") }),
      { artifactStore: healthyStore() }
    );

    const rows = await tenantDb.select().from(glassesWalkthroughs);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.capturedAt.toISOString()).toBe("2026-07-30T15:04:00.000Z");
    expect(rows[0]!.capturedByUserId).toBe(USER);
  });
});

describe("ingestGlassesWalkthrough — the stills enter the photo pipeline", () => {
  it("REGRESSION: enqueues a file.uploaded domain event for each still it files", async () => {
    // Without this the walk's photos never get EXIF backfill and never reach the deal's Procore photo
    // album, while every photo the crew shoots through the ordinary field camera does — the same bytes,
    // the same deal, the same `category: 'photo'` row, two different amounts of system behaviour.
    const result = await ingestGlassesWalkthrough(tenantDb, stillsWalk(2), { artifactStore: blindStore() });

    const events = await domainEvents();
    expect(events).toHaveLength(2);
    expect(events.map((e: { payload: { fileId: string } }) => e.payload.fileId).sort()).toEqual(
      result.files.map((f) => f.fileId).sort()
    );
    // The handler dispatches on `eventName` and then gates its entire body on `category === 'photo'`;
    // `officeId` on the ROW is how the worker resolves which tenant schema the file lives in. An event
    // missing any of the three is dequeued, logged and discarded.
    expect(events[0]!.payload.eventName).toBe("file.uploaded");
    expect(events[0]!.payload.category).toBe("photo");
    expect(events[0]!.officeId).toBe(OFFICE);
    expect(events[0]!.status).toBe("pending");
  });

  it("REGRESSION: emits the event body field-for-field identical to the shared producer's", async () => {
    // The batching constraint (see the service) rules out calling `recordUploadedFileSideEffects` per row,
    // so this module builds the payload itself — which means the two can DRIFT, and a payload missing a
    // key the worker later starts reading fails silently on exactly one producer. Rather than restate the
    // expected shape here (a copy drifts in lockstep with the copy it is checking), run the REAL shared
    // producer over the very row this module just filed and compare what each one enqueued.
    const result = await ingestGlassesWalkthrough(tenantDb, stillsWalk(1), { artifactStore: blindStore() });
    const [emitted] = await domainEvents();

    const [row] = await tenantDb.select().from(files).where(eq(files.id, result.files[0]!.fileId));
    await recordUploadedFileSideEffects(tenantDb, { file: row, userId: USER, officeId: OFFICE });
    const reference = (await domainEvents()).find((e: { id: number }) => e.id !== emitted.id);

    expect(emitted.payload).toEqual(reference.payload);
  });

  it("REGRESSION: writes the 'uploaded' photo_audit_log row the ordinary photo path writes", async () => {
    // The photo audit trail is a per-photo chain of custody the admin audit screen reads
    // (files/audit-log-service.ts). A still with no `uploaded` row is a photo that appears in the audit
    // view with no beginning — indistinguishable from one inserted directly into the database.
    const result = await ingestGlassesWalkthrough(tenantDb, stillsWalk(2), { artifactStore: blindStore() });

    const audit = await tenantDb.select().from(photoAuditLog);
    expect(audit).toHaveLength(2);
    expect(audit.map((a: { photoId: string }) => a.photoId).sort()).toEqual(result.files.map((f) => f.fileId).sort());
    expect(audit[0]!.eventType).toBe("uploaded");
    expect(audit[0]!.userId).toBe(USER);
  });

  it("GUARD: emits NOTHING for the walk's video and audio", async () => {
    // Deliberate, not an oversight. Those rows are `category: 'other'`, and the handler's entire body sits
    // inside `if (payload.category === 'photo')` — so an event for a clip is a durable queue row whose
    // successful outcome is a log line. They are not second-class either: the clips already have a
    // dedicated durable consumer in `glasses_walkthrough_forward`, which is what this whole module exists
    // to schedule. And the shape of the work a `file.uploaded` consumer does with a file is "fetch the
    // object and read it" (extractExif downloads it; the Procore push downloads it again) — inviting that
    // for objects up to MAX_GLASSES_WALKTHROUGH_ARTIFACT_BYTES (2 GiB) buys a consumer nothing today and
    // costs the worker a multi-gigabyte pull the day someone widens the gate. If a non-photo consumer is
    // ever registered, dropping the category filter is a one-line change.
    const input = baseInput({
      officeId: OFFICE,
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
      ],
    });
    await ingestGlassesWalkthrough(tenantDb, input, { artifactStore: blindStore() });

    expect(await domainEvents()).toHaveLength(0);
    expect(await tenantDb.select().from(photoAuditLog)).toHaveLength(0);
    // ...and the clips are still forwarded, which is the consumer they DO have.
    const forwards = await tenantDb.select().from(jobQueue).where(eq(jobQueue.jobType, GLASSES_WALKTHROUGH_FORWARD_JOB));
    expect(forwards).toHaveLength(1);
  });

  it("REGRESSION: a partial retry emits for the still it CREATED and for none of the ones it skipped", async () => {
    // Completion is retryable by design and the mobile queue re-sends the whole walk, so the emit set has
    // to be the rows the INSERT actually created — not the rows named in the request. Driving it off the
    // request would re-emit for every previously-filed still on every retry: a re-run of EXIF over bytes
    // that have not changed, and a second push of the same photo into the deal's Procore album.
    //
    // This also pins WHERE the emit sits. The second call finds a live forward job and returns from the
    // dedupe branch below WITHOUT reaching the enqueue; an emit written after that branch would file this
    // still and tell nobody. `artifacts_added` rather than `already_queued` because this is a WIDENING
    // retry — 2 stills then 3 — so the branch amends the forward job's artifact list on the way out.
    await ingestGlassesWalkthrough(tenantDb, stillsWalk(2), { artifactStore: blindStore() });
    expect(await domainEvents()).toHaveLength(2);

    const second = await ingestGlassesWalkthrough(tenantDb, stillsWalk(3), { artifactStore: blindStore() });
    expect(second.forwarding.status).toBe("artifacts_added"); // the early return this emit must precede

    const events = await domainEvents();
    expect(events).toHaveLength(3); // NOT 5 — the two already-filed stills emit nothing a second time
    const created = second.files.find((f) => f.created)!;
    expect(events.filter((e: { payload: { fileId: string } }) => e.payload.fileId === created.fileId)).toHaveLength(1);
    expect(await tenantDb.select().from(photoAuditLog)).toHaveLength(3);
  });

  it("REGRESSION: a full retry of an already-filed walk leaves the event count where it was", async () => {
    // Red before the fix on the FIRST half (there were no events to count) and load-bearing on the second:
    // re-filing a walk that is already wholly filed must not multiply the downstream work by however many
    // retries a flaky cellular link produced. Two identical completions, two events, not four.
    await ingestGlassesWalkthrough(tenantDb, stillsWalk(2), { artifactStore: blindStore() });
    await ingestGlassesWalkthrough(tenantDb, stillsWalk(2), { artifactStore: blindStore() });

    expect(await domainEvents()).toHaveLength(2);
    expect(await tenantDb.select().from(photoAuditLog)).toHaveLength(2);
  });

  it("GUARD: the write phase costs the same number of statements for a 40-still walk as for a 2-still walk", async () => {
    // The reason the `files` write is one multi-row insert rather than a loop: `tenantMiddleware` has
    // pinned a pooled connection and opened a transaction before this handler runs, so every statement is
    // pool-slot occupancy. Emitting the events by calling `recordUploadedFileSideEffects` per still would
    // have put TWO round trips per photo straight back in — 400 of them at the 200-artifact ceiling, for
    // the one artifact class a walk carries in bulk. Counting STATEMENTS rather than asserting a
    // particular number keeps this true as the write phase gains or loses steps.
    const statementsFor = async (stills: number): Promise<number> => {
      await pg.exec("DELETE FROM files");
      await pg.exec("DELETE FROM job_queue");
      await pg.exec("DELETE FROM photo_audit_log");
      const issued: string[] = [];
      const original = pg.query.bind(pg);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (pg as any).query = (text: string, ...rest: unknown[]) => {
        issued.push(text);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (original as any)(text, ...rest);
      };
      try {
        await ingestGlassesWalkthrough(tenantDb, stillsWalk(stills), { artifactStore: blindStore() });
      } finally {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (pg as any).query = original;
      }
      return issued.length;
    };

    // Six statements either way, today: the `files` insert, the re-select, the audit insert, the event
    // insert, the forward-state lookup and the forward enqueue. Nonzero on both sides is itself part of
    // the assertion — a counter that silently stopped intercepting would otherwise report 0 === 0.
    const wide = await statementsFor(40);
    const narrow = await statementsFor(2);
    expect(narrow).toBeGreaterThan(0);
    expect(wide).toBe(narrow);
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

// ── A completion retry that ADDS artifacts to a walk already being forwarded ───────────────────────
//
// The `files` half of a widening retry always worked: the third still gets its row and its `file.uploaded`
// event on the retry that first names it. The FORWARD half did not. The early return for an existing live
// job left `payload.artifacts` frozen at whatever the first completion carried, so TROCK Scope transcribed
// and extracted a scope from a walk that was short by however much arrived late — while the response, the
// project folder and the queue all reported a complete walk. Nothing anywhere could notice.
//
// The retry is ordinary, not exotic: mobile completes with what it has PUT, and a walk re-enqueued from its
// on-disk directory during recovery carries stills the first manifest never listed.
//
// The three job states below are three different answers, and the difference is not stylistic — it is
// whether the worker can still OBSERVE an amendment. A handler reads `payload` once, at claim time.

/** Put a live forward job into the state a claim leaves it in: `processing`, with an attempt spent. Nothing
 *  in this lane runs a worker, so this is how a row a worker is actively uploading from is expressed. */
async function claimJobForTest(jobId: number): Promise<void> {
  await tenantDb
    .update(jobQueue)
    .set({ status: "processing", attempts: 1, startedProcessingAt: new Date() })
    .where(eq(jobQueue.id, jobId));
}

const keysOf = (job: { payload: { artifacts: { idempotencyKey: string }[] } }) =>
  job.payload.artifacts.map((a) => a.idempotencyKey);

/** The list recorded BESIDE the one a claimed handler is delivering — see
 *  `recordPendingArtifactsOnRunningForwardJob`. Absent on every row that has nothing to reconcile. */
const pendingKeysOf = (job: { payload: { pendingArtifacts?: { idempotencyKey: string }[] } }) =>
  (job.payload.pendingArtifacts ?? []).map((a) => a.idempotencyKey);

const readJob = async (jobId: number) =>
  (await tenantDb.select().from(jobQueue).where(eq(jobQueue.id, jobId)))[0];

describe("ingestGlassesWalkthrough — a retry that ADDS artifacts to a live forward job", () => {
  it("REGRESSION: amends a still-PENDING forward job, so the artifact the retry added is forwarded too", async () => {
    // Two stills, then three — the shape a widening retry actually has. Before this, the third artifact got
    // a `files` row and a `file.uploaded` event and then simply never reached TROCK Scope.
    const first = await ingestGlassesWalkthrough(tenantDb, baseInput({ artifacts: photoArtifacts(2) }), {
      artifactStore: healthyStore({ head: async () => ({}) }),
    });
    const second = await ingestGlassesWalkthrough(tenantDb, baseInput({ artifacts: photoArtifacts(3) }), {
      artifactStore: healthyStore({ head: async () => ({}) }),
    });

    expect(second.forwarding).toEqual({ status: "artifacts_added", jobId: first.forwarding.jobId });
    const jobs = await tenantDb.select().from(jobQueue).where(eq(jobQueue.jobType, GLASSES_WALKTHROUGH_FORWARD_JOB));
    expect(jobs).toHaveLength(1); // amended IN PLACE — a second row would be a second billed scope extraction
    expect(keysOf(jobs[0]!)).toEqual(["artifact-1", "artifact-2", "artifact-3"]);
    // The appended entry is a real forwardable artifact, not a stub: the worker addresses R2 by `r2Key` and
    // a missing/placeholder one forwards nothing while still reporting success.
    expect(jobs[0]!.payload.artifacts[2]).toMatchObject({
      fileId: second.files[2]!.fileId,
      r2Key: second.files[2]!.r2Key,
      mimeType: "image/jpeg",
      originalFilename: "frame-3.jpg",
      fileSizeBytes: 1024,
    });
  });

  it("GUARD: an ordinary duplicate completion still short-circuits without rewriting the payload", async () => {
    // The overwhelmingly common retry adds nothing. It must stay a pure read — an amend on every duplicate
    // would rewrite a payload a worker may be mid-checkpoint on, for no gain at all.
    const first = await ingestGlassesWalkthrough(tenantDb, baseInput({ artifacts: photoArtifacts(2) }), {
      artifactStore: healthyStore({ head: async () => ({}) }),
    });
    const before = await readJob(first.forwarding.jobId);

    const second = await ingestGlassesWalkthrough(tenantDb, baseInput({ artifacts: photoArtifacts(2) }), {
      artifactStore: healthyStore({ head: async () => ({}) }),
    });

    expect(second.forwarding).toEqual({ status: "already_queued", jobId: first.forwarding.jobId });
    expect(await readJob(first.forwarding.jobId)).toEqual(before);
  });

  it("GUARD: the amend is a UNION — an artifact only the JOB carries survives a retry that omits it", async () => {
    // A recovered walk's manifest is not guaranteed to be a superset of the one that completed first (the
    // recovery scan reads a directory, not the original queue entry). Writing THIS call's list over the
    // job's would then silently delete a clip from a walk already scheduled to forward — the same defect
    // this fix exists to remove, pointed the other way.
    await ingestGlassesWalkthrough(tenantDb, baseInput({ artifacts: photoArtifacts(2) }), {
      artifactStore: healthyStore({ head: async () => ({}) }),
    });
    const retry = await ingestGlassesWalkthrough(
      tenantDb,
      baseInput({ artifacts: photoArtifacts(3).slice(1) }), // artifact-2 and artifact-3; artifact-1 omitted
      { artifactStore: healthyStore({ head: async () => ({}) }) }
    );

    expect(retry.forwarding.status).toBe("artifacts_added");
    expect(keysOf(await readJob(retry.forwarding.jobId))).toEqual(["artifact-1", "artifact-2", "artifact-3"]);
  });

  it("REGRESSION: leaves a CLAIMED job alive and records the reconciliation beside it, instead of killing a row a handler is still using", async () => {
    // This used to dead-letter the claimed row. Marking it dead does NOT cancel the handler — it is
    // already iterating the list it read at claim time and keeps uploading — but it does remove the row
    // from 0213's live partial unique index immediately, so a concurrent completion retry can insert a
    // REPLACEMENT beside a delivery that is still running. With more than one worker replica that is two
    // handlers uploading the same walkthrough at once, which this seam cannot reconcile. It also strands
    // the handler's own completion, which is guarded `WHERE id = $1 AND status = 'processing'`.
    //
    // So the barrier is held: status untouched, claim untouched, and the complete list recorded under
    // `pendingArtifacts` for the handler to fold in when it stops (see supersedeSelfForPendingArtifacts
    // in worker/src/jobs/glasses-walkthrough-forward.ts).
    const first = await ingestGlassesWalkthrough(tenantDb, baseInput({ artifacts: photoArtifacts(2) }), {
      artifactStore: healthyStore({ head: async () => ({}) }),
    });
    await claimJobForTest(first.forwarding.jobId);

    const second = await ingestGlassesWalkthrough(tenantDb, baseInput({ artifacts: photoArtifacts(3) }), {
      artifactStore: healthyStore({ head: async () => ({}) }),
    });

    expect(second.forwarding).toEqual({
      status: "reconciliation_pending",
      jobId: first.forwarding.jobId,
    });
    const job = await readJob(first.forwarding.jobId);
    // Still claimed, still in the live unique index — nothing can be inserted alongside it.
    expect(job.status).toBe("processing");
    // The list the handler is DELIVERING is untouched; the complete one is recorded beside it, so the two
    // can never be confused for one another.
    expect(keysOf(job)).toEqual(["artifact-1", "artifact-2"]);
    expect(pendingKeysOf(job)).toEqual(["artifact-1", "artifact-2", "artifact-3"]);
  });

  it("REGRESSION: a second widening against the SAME claimed job unions with the pending set, it does not replace it", async () => {
    // The first version of this branch fixed the stale-union bug for `artifacts` and then repeated it
    // one key over. Each call derived its list from `payload.artifacts` and knew nothing about a
    // `pendingArtifacts` already written, so the assignment replaced that key wholesale: a call
    // carrying [A,C] arriving after one carrying [A,B] left the pending set as [A,C], and B was never
    // forwarded. The handler then folded in a set that had quietly lost a clip — while later
    // completion retries could still see B among the filed rows, so nothing anywhere disagreed.
    const first = await ingestGlassesWalkthrough(tenantDb, baseInput({ artifacts: photoArtifacts(2) }), {
      artifactStore: healthyStore({ head: async () => ({}) }),
    });
    await claimJobForTest(first.forwarding.jobId);

    // Two widening completions carrying DIFFERENT additions, as two mobile retries would.
    await ingestGlassesWalkthrough(
      tenantDb,
      baseInput({ artifacts: [...photoArtifacts(2), photoArtifact(3)] }),
      { artifactStore: healthyStore({ head: async () => ({}) }) },
    );
    await ingestGlassesWalkthrough(
      tenantDb,
      baseInput({ artifacts: [...photoArtifacts(2), photoArtifact(4)] }),
      { artifactStore: healthyStore({ head: async () => ({}) }) },
    );

    const job = await readJob(first.forwarding.jobId);
    expect(job.status).toBe("processing");
    // Both additions survive. Neither retry knew about the other's.
    expect(pendingKeysOf(job)).toEqual(["artifact-1", "artifact-2", "artifact-3", "artifact-4"]);
    // And the list the handler is DELIVERING is still untouched.
    expect(keysOf(job)).toEqual(["artifact-1", "artifact-2"]);
  });

  it("REGRESSION: refuses a completion that arrives AFTER the handler's reconciliation, instead of orphaning a second pending set", async () => {
    // `status = 'processing'` stays true for a window after the handler folds `pendingArtifacts` in
    // and before the queue's separate terminal write lands. A completion arriving inside it used to
    // be accepted and write a NEW pending set the handler had already stopped looking at — it
    // answered success so mobile stopped retrying, the handler dead-lettered carrying the EARLIER
    // list, and the late clips were forwarded by nobody. The dead row's `alertSent` then suppressed
    // a second alert, so even requeuing once would fold the late set, dead-letter again, and say
    // nothing.
    const first = await ingestGlassesWalkthrough(tenantDb, baseInput({ artifacts: photoArtifacts(2) }), {
      artifactStore: healthyStore({ head: async () => ({}) }),
    });
    await claimJobForTest(first.forwarding.jobId);
    // The handler has folded and closed: pendingArtifacts gone, marker set, row still 'processing'
    // because the queue's terminal write is a separate statement.
    await tenantDb
      .update(jobQueue)
      .set({
        payload: sql`(${jobQueue.payload} - 'pendingArtifacts') || '{"reconciliationClosed": true}'::jsonb`,
      })
      .where(eq(jobQueue.id, first.forwarding.jobId));

    await expect(
      ingestGlassesWalkthrough(tenantDb, baseInput({ artifacts: photoArtifacts(3) }), {
        artifactStore: healthyStore({ head: async () => ({}) }),
      }),
    ).rejects.toMatchObject({ statusCode: 503 });

    // No orphaned second pending set — the retry the 503 asks for lands on the dead row and takes
    // the replacement path with the complete list.
    const job = await readJob(first.forwarding.jobId);
    expect(job.payload.pendingArtifacts).toBeUndefined();
  });

  it("REGRESSION: inherits a dead predecessor's pendingArtifacts too, not only the list it was delivering", async () => {
    // `pendingArtifacts` is the widened list a completion recorded BESIDE a delivery that was still
    // running. The handler folds it into `artifacts` only if it reaches supersedeSelfForPending-
    // Artifacts — a handler that exhausts its attempts first never gets there, and the queue marks the
    // row dead with the two keys still separate.
    //
    // Reading only `artifacts` therefore inherited exactly what the dead attempt was carrying and
    // dropped what a later completion had already filed. And `supersededByJobId` then suppresses that
    // row's alert, so the shortfall reached nobody. This is the same defect the predecessor loader was
    // written to fix, one key over: it read the predecessor independently of its CHECKPOINT, and then
    // read only one of its two artifact lists.
    const first = await ingestGlassesWalkthrough(tenantDb, baseInput({ artifacts: photoArtifacts(2) }), {
      artifactStore: healthyStore({ head: async () => ({}) }),
    });
    // Died with a widening recorded but never folded — attempts exhausted before the handler finished.
    await tenantDb
      .update(jobQueue)
      .set({
        status: "dead",
        lastError: "attempts exhausted before reconciliation",
        // COMPLETE artifact objects, not key-only stubs. A real `pendingArtifacts` entry is a full
        // GlassesWalkthroughForwardArtifact — the worker uploads the clip from `r2Key`, `mimeType`,
        // `fileSizeBytes` and the rest — so seeding bare keys would let inheritance drop every field
        // except the one the assertion reads, and this test would stay green through it.
        payload: sql`jsonb_set(${jobQueue.payload}, '{pendingArtifacts}', ${JSON.stringify(
          [1, 2, 3].map((n) => ({
            fileId: `file-${n}`,
            idempotencyKey: `artifact-${n}`,
            kind: "photo",
            r2Key: `dallas/deals/deal-1/glasses-walkthroughs/walk-1/artifact-${n}.jpg`,
            mimeType: "image/jpeg",
            originalFilename: `frame-00${n}.jpg`,
            fileSizeBytes: 1024 * n,
            capturedAtMs: n * 1000,
          })),
        )}::jsonb, true)`,
      })
      .where(eq(jobQueue.id, first.forwarding.jobId));

    // The recovered retry carries only what its directory scan found.
    const replacement = await ingestGlassesWalkthrough(
      tenantDb,
      baseInput({ artifacts: [photoArtifact(2)] }),
      { artifactStore: healthyStore({ head: async () => ({}) }) },
    );

    expect(replacement.forwarding.status).toBe("queued");
    const inherited = await readJob(replacement.forwarding.jobId);
    expect(keysOf(inherited)).toEqual(["artifact-1", "artifact-2", "artifact-3"]);
    // Carried WHOLE, not just by key: the worker cannot upload a clip it only knows the name of.
    const artifact3 = inherited.payload.artifacts.find(
      (a: { idempotencyKey: string }) => a.idempotencyKey === "artifact-3",
    );
    expect(artifact3).toMatchObject({
      r2Key: "dallas/deals/deal-1/glasses-walkthroughs/walk-1/artifact-3.jpg",
      mimeType: "image/jpeg",
      fileSizeBytes: 3072,
    });
  });

  it("REGRESSION: a predecessor already holding [null] is survivable, not a permanent 500", async () => {
    // The type guard added last round stops a JSON-null key becoming `[null]` GOING FORWARD. Rows
    // written before it can already hold one — the old reconciliation concatenated a null key with a
    // real array and stored the result — and such a row is a perfectly valid array, so the guard passes
    // it straight through. Reading `idempotencyKey` off that `null` threw, so the completion 500'd and
    // the replacement that would have rescued the walk was never created: the bad data outlives the fix
    // that prevents it, and the walk is stuck until someone edits the row by hand.
    const first = await ingestGlassesWalkthrough(tenantDb, baseInput({ artifacts: photoArtifacts(2) }), {
      artifactStore: healthyStore({ head: async () => ({}) }),
    });
    await tenantDb
      .update(jobQueue)
      .set({
        status: "dead",
        lastError: "died with a malformed artifact list",
        // The junk sits BESIDE a real entry, which is the only seeding that can tell the two
        // survivable outcomes apart. A `[null]` on its own leaves the predecessor list empty either
        // way — whether the element alone is dropped or the whole malformed list is refused — so the
        // assertion below would read the current ingest's own artifacts back and pass under both.
        // `artifact-9` is the clip that only the dead row was carrying: if refusing the list were the
        // behaviour, it is what would be silently lost.
        payload: sql`jsonb_set(${jobQueue.payload}, '{artifacts}', ${JSON.stringify([
          null,
          {
            fileId: "file-9",
            idempotencyKey: "artifact-9",
            kind: "photo",
            r2Key: "dallas/deals/deal-1/glasses-walkthroughs/walk-1/artifact-9.jpg",
            mimeType: "image/jpeg",
            originalFilename: "frame-9.jpg",
            fileSizeBytes: 1024,
            capturedAtMs: null,
          },
        ])}::jsonb, true)`,
      })
      .where(eq(jobQueue.id, first.forwarding.jobId));

    const replacement = await ingestGlassesWalkthrough(tenantDb, baseInput({ artifacts: photoArtifacts(2) }), {
      artifactStore: healthyStore({ head: async () => ({}) }),
    });

    // The junk element is dropped, not thrown on: it carries no key, so it identifies no artifact and
    // nothing downstream could have acted on it. Refusing the whole list would turn a recoverable walk
    // into a permanently failing one.
    expect(replacement.forwarding.status).toBe("queued");
    // Element-wise, then: the junk goes and the sound entry beside it stays. Predecessor first, because
    // `mergeForwardArtifacts(deadPredecessorArtifacts, forwardArtifacts)` gives the inherited list the
    // lower ordinality — an entry a worker or a reconciling human may have edited is carried verbatim.
    expect(keysOf(await readJob(replacement.forwarding.jobId))).toEqual([
      "artifact-9",
      "artifact-1",
      "artifact-2",
    ]);
  });

  it("REGRESSION: a `failed` predecessor is superseded, not parked as though a handler were still running", async () => {
    // `job_status` is an enum containing `failed` (0001_initial.sql:17). This queue's own transitions
    // never write it, but it is schema-valid and reachable by another actor — and the catch-all here
    // used to route it to the running-job branch. Then: the poller claims only `pending`, lease
    // recovery touches only `processing`, the alert sweep selects only `dead`, and 0213's partial
    // index still counts `failed` as LIVE so no replacement can be inserted. Nothing consumed the
    // pendingArtifacts write and nothing could supersede the row — an acknowledged walk, permanently
    // unforwarded, with every mechanism that exists to notice looking somewhere else.
    const first = await ingestGlassesWalkthrough(tenantDb, baseInput({ artifacts: photoArtifacts(2) }), {
      artifactStore: healthyStore({ head: async () => ({}) }),
    });
    await tenantDb
      .update(jobQueue)
      .set({ status: "failed", lastError: "put here by something other than this queue" })
      .where(eq(jobQueue.id, first.forwarding.jobId));

    const second = await ingestGlassesWalkthrough(tenantDb, baseInput({ artifacts: photoArtifacts(3) }), {
      artifactStore: healthyStore({ head: async () => ({}) }),
    });

    expect(second.forwarding.status).toBe("superseded_for_reconciliation");
    const job = await readJob(first.forwarding.jobId);
    // Dead — which is what releases 0213's slot so the next retry can enqueue a replacement at all.
    expect(job.status).toBe("dead");
    expect(keysOf(job)).toEqual(["artifact-1", "artifact-2", "artifact-3"]);
    expect(job.payload.pendingArtifacts).toBeUndefined();
  });

  it("REGRESSION: inherits artifacts from a CHECKPOINT-LESS dead predecessor, which the checkpoint lookup cannot see", async () => {
    // A forward that died before it ever reached TROCK Scope has no checkpoint, so
    // `findGlassesWalkthroughForwardJobState` — whose job is "is there a checkpoint worth
    // inheriting" — returns null for it. The replacement was therefore built from this call's list
    // alone. A recovered manifest is a directory scan and can legitimately omit an artifact the
    // prior job carried, so a dead [1,2,3] met by a retry carrying [2,3] queued a replacement with
    // no artifact-1 at all.
    //
    // That gap predates the supersede work but was survivable while the dead row still alerted: a
    // human reading the dead letter could see artifact-1. Stamping predecessors `supersededByJobId`
    // silences that alert, so the omission became observable by nobody — no worker reads a dead row,
    // and no operator is told.
    const first = await ingestGlassesWalkthrough(tenantDb, baseInput({ artifacts: photoArtifacts(3) }), {
      artifactStore: healthyStore({ head: async () => ({}) }),
    });
    // Dead with NO checkpoint of any kind — the common predecessor.
    await tenantDb
      .update(jobQueue)
      .set({ status: "dead", lastError: "died before reaching TROCK Scope" })
      .where(eq(jobQueue.id, first.forwarding.jobId));

    // The recovered retry omits artifact-1, exactly as a directory scan legitimately can.
    const replacement = await ingestGlassesWalkthrough(
      tenantDb,
      baseInput({ artifacts: [photoArtifact(2), photoArtifact(3)] }),
      { artifactStore: healthyStore({ head: async () => ({}) }) },
    );

    expect(replacement.forwarding.status).toBe("queued");
    const job = await readJob(replacement.forwarding.jobId);
    expect(keysOf(job)).toEqual(["artifact-1", "artifact-2", "artifact-3"]);
  });

  it("REGRESSION: a dead row that has been REPLACED stops alerting, and says which job replaced it", async () => {
    // The dead-letter sweep selects every dead row whose `alertSent` is unset, without asking whether
    // anything took its place. A mobile retry reaching the dead row before the minute-based sweep
    // enqueues a successor carrying the full list and the inherited checkpoint — and the operator was
    // paged anyway, about a walk already being forwarded, with an instruction (reset this row to
    // 'pending') that 0213's live partial unique index refuses because the successor holds the slot.
    const first = await ingestGlassesWalkthrough(tenantDb, baseInput({ artifacts: photoArtifacts(2) }), {
      artifactStore: healthyStore({ head: async () => ({}) }),
    });
    await tenantDb
      .update(jobQueue)
      .set({ status: "dead", lastError: "forward failed" })
      .where(eq(jobQueue.id, first.forwarding.jobId));

    const replacement = await ingestGlassesWalkthrough(tenantDb, baseInput({ artifacts: photoArtifacts(3) }), {
      artifactStore: healthyStore({ head: async () => ({}) }),
    });
    expect(replacement.forwarding.status).toBe("queued");

    const source = await readJob(first.forwarding.jobId);
    expect(source.status).toBe("dead"); // still dead — the history is not rewritten
    expect(Number(source.payload.supersededByJobId)).toBe(replacement.forwarding.jobId);
  });

  it("GUARD: a dead row with no replacement keeps no supersede marker, so it still alerts", async () => {
    // The other side of the same predicate. A fix that stamped every dead row would silence the
    // alert this sweep exists to send.
    const first = await ingestGlassesWalkthrough(tenantDb, baseInput({ artifacts: photoArtifacts(2) }), {
      artifactStore: healthyStore({ head: async () => ({}) }),
    });
    await tenantDb
      .update(jobQueue)
      .set({ status: "dead", lastError: "forward failed" })
      .where(eq(jobQueue.id, first.forwarding.jobId));

    expect((await readJob(first.forwarding.jobId)).payload.supersededByJobId).toBeUndefined();
  });

  it("REGRESSION: a replacement cannot be inserted beside a claimed forward that grew mid-flight", async () => {
    // The consequence the branch above exists to prevent, asserted directly rather than inferred from the
    // row's status: after a widening completion against a claimed job, the pair still has exactly ONE live
    // forward. Before the fix the claimed row went dead, left the live unique index, and the very next
    // completion inserted a second live row while the first was still uploading.
    const first = await ingestGlassesWalkthrough(tenantDb, baseInput({ artifacts: photoArtifacts(2) }), {
      artifactStore: healthyStore({ head: async () => ({}) }),
    });
    await claimJobForTest(first.forwarding.jobId);
    await ingestGlassesWalkthrough(tenantDb, baseInput({ artifacts: photoArtifacts(3) }), {
      artifactStore: healthyStore({ head: async () => ({}) }),
    });

    // A further retry — the one that would have raced the running delivery.
    const third = await ingestGlassesWalkthrough(tenantDb, baseInput({ artifacts: photoArtifacts(3) }), {
      artifactStore: healthyStore({ head: async () => ({}) }),
    });
    expect(third.forwarding.jobId).toBe(first.forwarding.jobId);

    const live = await tenantDb
      .select({ id: jobQueue.id })
      .from(jobQueue)
      .where(and(eq(jobQueue.jobType, GLASSES_WALKTHROUGH_FORWARD_JOB), sql`${jobQueue.status} <> 'dead'`));
    expect(live).toHaveLength(1);
  });

  it("REGRESSION: supersedes a COMPLETED forward, whose row is never claimed again", async () => {
    // The forward ran and succeeded — for the artifacts it carried. Nothing will ever re-read this row, so
    // an amend here is not merely racy, it is inert: the extras would sit in a payload no worker looks at.
    const first = await ingestGlassesWalkthrough(tenantDb, baseInput({ artifacts: photoArtifacts(2) }), {
      artifactStore: healthyStore({ head: async () => ({}) }),
    });
    await tenantDb
      .update(jobQueue)
      .set({ status: "completed", attempts: 1, completedAt: new Date() })
      .where(eq(jobQueue.id, first.forwarding.jobId));

    const second = await ingestGlassesWalkthrough(tenantDb, baseInput({ artifacts: photoArtifacts(3) }), {
      artifactStore: healthyStore({ head: async () => ({}) }),
    });

    expect(second.forwarding.status).toBe("superseded_for_reconciliation");
    const job = await readJob(first.forwarding.jobId);
    expect(job.status).toBe("dead");
    // `completed_at` is deliberately left standing: it is the only thing on the row that still says this
    // forward once ran, and a reconciler reading "dead" alone would re-forward blind.
    expect(job.completedAt).not.toBeNull();
    expect(keysOf(job)).toEqual(["artifact-1", "artifact-2", "artifact-3"]);
  });

  it("GUARD: a claimed job whose artifact set did NOT change is left running — a duplicate never kills a live forward", async () => {
    const first = await ingestGlassesWalkthrough(tenantDb, baseInput({ artifacts: photoArtifacts(2) }), {
      artifactStore: healthyStore({ head: async () => ({}) }),
    });
    await claimJobForTest(first.forwarding.jobId);

    const second = await ingestGlassesWalkthrough(tenantDb, baseInput({ artifacts: photoArtifacts(2) }), {
      artifactStore: healthyStore({ head: async () => ({}) }),
    });

    expect(second.forwarding).toEqual({ status: "already_queued", jobId: first.forwarding.jobId });
    expect((await readJob(first.forwarding.jobId)).status).toBe("processing"); // still uploading, untouched
  });

  it("GUARD: the retry AFTER a supersede enqueues a replacement carrying every artifact and the inherited checkpoint", async () => {
    // Why dead-lettering is a repair and not just an alarm: the superseded row leaves the live partial
    // unique index, so the next completion takes the existing dead-row path — a replacement carrying the
    // COMPLETE list plus whatever the dead row learned about TROCK Scope. Reconciliation by hand is the
    // fallback, not the only route out.
    const first = await ingestGlassesWalkthrough(tenantDb, baseInput({ artifacts: photoArtifacts(2) }), {
      artifactStore: healthyStore({ head: async () => ({}) }),
    });
    // COMPLETED, not `processing`. A claimed row is no longer superseded at all — its handler is still
    // uploading and killing it would let this very replacement be inserted alongside a live delivery.
    // Completed is the state where the supersede is safe, because nothing is using the row any more.
    await tenantDb
      .update(jobQueue)
      .set({
        status: "completed",
        attempts: 1,
        completedAt: new Date(),
        payload: sql`jsonb_set(${jobQueue.payload}, '{scopeWalkthroughId}', '"scope-wt-1"'::jsonb, true)`,
      })
      .where(eq(jobQueue.id, first.forwarding.jobId));

    const superseding = await ingestGlassesWalkthrough(tenantDb, baseInput({ artifacts: photoArtifacts(3) }), {
      artifactStore: healthyStore({ head: async () => ({}) }),
    });
    expect(superseding.forwarding.status).toBe("superseded_for_reconciliation");

    const replacementCall = await ingestGlassesWalkthrough(tenantDb, baseInput({ artifacts: photoArtifacts(3) }), {
      artifactStore: healthyStore({ head: async () => ({}) }),
    });
    expect(replacementCall.forwarding.status).toBe("queued");
    const replacement = await readJob(replacementCall.forwarding.jobId);
    expect(keysOf(replacement)).toEqual(["artifact-1", "artifact-2", "artifact-3"]);
    expect(replacement.payload.scopeWalkthroughId).toBe("scope-wt-1");
    expect(replacement.status).toBe("pending");
  });
});

// ── Object verification vs. the pinned tenant connection ───────────────────────────────────────────
//
// `tenantMiddleware` has already checked out one of the pool's 20 connections and opened a transaction on
// it before this service is ever called, so every millisecond the verification phase spends is a
// pool slot held by a request doing no database work at all.

/** One artifact by its 1-based index, so a test can build a set that is not a prefix — two retries
 *  adding DIFFERENT artifacts is the case `photoArtifacts(n)` cannot express. */
function photoArtifact(index: number) {
  return {
    idempotencyKey: `artifact-${index}`,
    kind: "photo" as const,
    originalFilename: `frame-${index}.jpg`,
    mimeType: "image/jpeg",
    fileSizeBytes: 1024,
    capturedAtMs: null,
  };
}

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

  it("REGRESSION: ABORTS the requests already in flight, not only the ones not yet sent", async () => {
    // Stopping dispatch released this caller's WAIT and nothing else. The S3 client has no request
    // timeout, so every HEAD that R2 had accepted and never answered kept its socket and its promise
    // for the life of the process — up to one per worker, per timed-out completion. And because the
    // 503 is retryable, the client's next attempt and every other walk stacked a fresh batch on top of
    // the leaked one until the pool was gone. Releasing the database transaction made that harder to
    // see rather than less real.
    const signals: AbortSignal[] = [];
    const store = healthyStore({
      head: async (_r2Key: string, signal?: AbortSignal) => {
        if (signal) signals.push(signal);
        // Never answers, which is exactly the case: R2 accepted the request and went quiet.
        await new Promise(() => {});
        return { contentType: "image/jpeg", contentLength: 1024 };
      },
    });

    await expect(
      ingestGlassesWalkthrough(tenantDb, baseInput({ artifacts: photoArtifacts(12) }), {
        artifactStore: store,
        objectVerificationTimeoutMs: 40,
      })
    ).rejects.toMatchObject({ statusCode: 503 });

    // Every request the phase issued received a signal, and every one of them is aborted — the store
    // is handed the means to release the socket rather than merely being left alone.
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });
});

describe("recording an inherited TROCK Scope id", () => {
  it("REGRESSION: a re-completed walk whose forward already FINISHED is not stuck processing", async () => {
    // A walk that predates 0214 has no read-model row. Completed again after its forward finished, the
    // row is created for the first time with a null scope id — and the live-job branch treats every
    // non-dead job as still live and returns without enqueueing anything, so nothing ever comes back to
    // fill it. The panel then reports "still processing" on a walk whose scope has been sitting in TROCK
    // Scope for weeks, and no amount of retrying changes it, because the id was already known.
    //
    // A REAL uuid, because the column is `uuid` — the payload it comes from has no such constraint,
    // which is why the stamp is also wrapped against 22P02 rather than trusted.
    const scopeId = "b91a5bfd-eca9-4dbd-bde4-06528658b2b6";
    const first = await ingestGlassesWalkthrough(tenantDb, baseInput(), {
      artifactStore: healthyStore(),
    });
    await tenantDb
      .update(jobQueue)
      .set({
        status: "completed",
        payload: sql`jsonb_set(${jobQueue.payload}, '{scopeWalkthroughId}', ${JSON.stringify(scopeId)}::jsonb, true)`,
      })
      .where(eq(jobQueue.id, first.forwarding.jobId));
    // The read model predates the migration for this walk.
    await tenantDb.delete(glassesWalkthroughs);

    await ingestGlassesWalkthrough(tenantDb, baseInput(), { artifactStore: healthyStore() });

    const [row] = await tenantDb.select().from(glassesWalkthroughs);
    expect(row!.scopeWalkthroughId).toBe(scopeId);
  });
});
