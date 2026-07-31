// REAL-SQL (PGlite) proof for `ingestGlassesWalkthrough`: the `files` row writes and the `job_queue`
// enqueue. Same rationale as walkthrough-ingress-service.runtime.test.ts (the return path's own runtime
// suite) for why this needs real SQL rather than a mocked db — `files` has ten NOT NULL columns Drizzle's
// insert type does not fully enforce, and the partial unique index on `client_upload_id` (the mechanism
// this suite's idempotency tests are ABOUT) only exists in real SQL, not in the type system.
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { and, eq } from "drizzle-orm";
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
});
