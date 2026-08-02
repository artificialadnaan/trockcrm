// Pure-logic coverage for the glasses-walkthrough ingress: validation, media-type resolution and R2 key
// derivation. Nothing here touches the database — see glasses-walkthrough-service.runtime.test.ts for
// the `files` row / idempotency / job-enqueue behavior, which needs real SQL (files has NOT NULL
// columns Drizzle's insert types don't fully enforce, per the same reasoning the return-path's runtime
// suite documents).
import { describe, expect, it } from "vitest";
import { AppError } from "../../middleware/error-handler.js";
import {
  deriveGlassesWalkthroughArtifactR2Key,
  GLASSES_WALKTHROUGH_ACCEPTED_MEDIA,
  looksLikeUuid,
  MAX_GLASSES_WALKTHROUGH_ARTIFACT_BYTES,
  MAX_GLASSES_WALKTHROUGH_ARTIFACTS_PER_WALK,
  MAX_GLASSES_WALKTHROUGH_IDEMPOTENCY_KEY_CHARS,
  validateGlassesWalkthroughArtifactUploadUrlInput,
  validateGlassesWalkthroughCompleteInput,
} from "./glasses-walkthrough-service.js";

const DEAL = "11111111-1111-4111-8111-111111111111";
const WALK = "22222222-2222-4222-8222-222222222222";

function baseArtifact(overrides: Record<string, unknown> = {}) {
  return {
    idempotencyKey: "artifact-1",
    kind: "photo",
    originalFilename: "frame-001.jpg",
    mimeType: "image/jpeg",
    fileSizeBytes: 204800,
    capturedAtMs: 1500,
    ...overrides,
  };
}

function baseCompleteInput(overrides: Record<string, unknown> = {}) {
  return {
    dealId: DEAL,
    walkId: WALK,
    title: "North wing walkthrough",
    siteLabel: "Building A",
    projectId: null,
    capturedAt: "2026-07-30T15:04:00.000Z",
    userId: "user-1",
    officeSlug: "dallas",
    officeId: "office-1",
    artifacts: [baseArtifact()],
    ...overrides,
  };
}

describe("deriveGlassesWalkthroughArtifactR2Key", () => {
  it("is deterministic for the same inputs (a retried upload-url call targets the same object)", () => {
    const a = deriveGlassesWalkthroughArtifactR2Key("dallas", DEAL, WALK, "artifact-1", "mp4");
    const b = deriveGlassesWalkthroughArtifactR2Key("dallas", DEAL, WALK, "artifact-1", "mp4");
    expect(a).toBe(b);
  });

  it("differs when the idempotency key differs, so two artifacts never collide on one key", () => {
    const a = deriveGlassesWalkthroughArtifactR2Key("dallas", DEAL, WALK, "artifact-1", "mp4");
    const b = deriveGlassesWalkthroughArtifactR2Key("dallas", DEAL, WALK, "artifact-2", "mp4");
    expect(a).not.toBe(b);
  });

  it("percent-encodes the walk id and idempotency key into the key path", () => {
    const key = deriveGlassesWalkthroughArtifactR2Key("dallas", DEAL, "walk/weird id", "artifact#1", "jpg");
    expect(key).toBe(`dallas/deals/${DEAL}/glasses-walkthroughs/walk%2Fweird%20id/artifact%231.jpg`);
  });

  it("scopes the key under the deal id, not just the office", () => {
    const key = deriveGlassesWalkthroughArtifactR2Key("dallas", DEAL, WALK, "artifact-1", "jpg");
    expect(key).toContain(`/deals/${DEAL}/`);
  });
});

describe("GLASSES_WALKTHROUGH_ACCEPTED_MEDIA", () => {
  it("matches TROCK Scope's own accepted content types (server/src/ingest/media-types.ts BY_CONTENT_TYPE)", () => {
    // A drift here is a walk that files cleanly in trockcrm and then 415s on every forward attempt.
    expect(Object.keys(GLASSES_WALKTHROUGH_ACCEPTED_MEDIA).sort()).toEqual(
      [
        "video/quicktime",
        "video/mp4",
        "video/x-m4v",
        "video/webm",
        "audio/mp4",
        "audio/x-m4a",
        "audio/mpeg",
        "audio/wav",
        "audio/x-wav",
        "audio/aac",
        "image/jpeg",
        "image/png",
        "image/heic",
      ].sort()
    );
  });

  it("assigns the same kind trock-scope's ClipKind resolution assigns", () => {
    expect(GLASSES_WALKTHROUGH_ACCEPTED_MEDIA["video/mp4"]!.kind).toBe("video");
    expect(GLASSES_WALKTHROUGH_ACCEPTED_MEDIA["audio/wav"]!.kind).toBe("audio");
    expect(GLASSES_WALKTHROUGH_ACCEPTED_MEDIA["image/jpeg"]!.kind).toBe("photo");
  });
});

describe("validateGlassesWalkthroughArtifactUploadUrlInput", () => {
  function baseUploadUrlInput(overrides: Record<string, unknown> = {}) {
    return {
      dealId: DEAL,
      walkId: WALK,
      idempotencyKey: "artifact-1",
      kind: "video",
      mimeType: "video/mp4",
      fileSizeBytes: 1024,
      ...overrides,
    };
  }

  it("accepts a well-formed input and lowercases the mimeType", () => {
    const result = validateGlassesWalkthroughArtifactUploadUrlInput(baseUploadUrlInput({ mimeType: "VIDEO/MP4" }));
    expect(result.mimeType).toBe("video/mp4");
    expect(result.kind).toBe("video");
  });

  it("rejects a missing dealId", () => {
    expect(() => validateGlassesWalkthroughArtifactUploadUrlInput(baseUploadUrlInput({ dealId: "" }))).toThrow(AppError);
  });

  it("rejects an idempotencyKey longer than the files.client_upload_id column width", () => {
    expect(() =>
      validateGlassesWalkthroughArtifactUploadUrlInput(
        baseUploadUrlInput({ idempotencyKey: "x".repeat(MAX_GLASSES_WALKTHROUGH_IDEMPOTENCY_KEY_CHARS + 1) })
      )
    ).toThrow(AppError);
  });

  it("accepts an idempotencyKey exactly at the column width", () => {
    const result = validateGlassesWalkthroughArtifactUploadUrlInput(
      baseUploadUrlInput({ idempotencyKey: "x".repeat(MAX_GLASSES_WALKTHROUGH_IDEMPOTENCY_KEY_CHARS) })
    );
    expect(result.idempotencyKey).toHaveLength(MAX_GLASSES_WALKTHROUGH_IDEMPOTENCY_KEY_CHARS);
  });

  it("rejects an unsupported mimeType", () => {
    expect(() =>
      validateGlassesWalkthroughArtifactUploadUrlInput(baseUploadUrlInput({ mimeType: "application/pdf" }))
    ).toThrow(/not an accepted glasses-walkthrough media type/);
  });

  it("rejects a kind that disagrees with the mimeType (a photo mime cannot be declared video)", () => {
    expect(() =>
      validateGlassesWalkthroughArtifactUploadUrlInput(baseUploadUrlInput({ mimeType: "image/jpeg", kind: "video" }))
    ).toThrow(/does not match mimeType/);
  });

  it("rejects a non-positive fileSizeBytes", () => {
    expect(() => validateGlassesWalkthroughArtifactUploadUrlInput(baseUploadUrlInput({ fileSizeBytes: 0 }))).toThrow(AppError);
    expect(() => validateGlassesWalkthroughArtifactUploadUrlInput(baseUploadUrlInput({ fileSizeBytes: -5 }))).toThrow(AppError);
  });

  it("rejects a fileSizeBytes over the ceiling", () => {
    expect(() =>
      validateGlassesWalkthroughArtifactUploadUrlInput(
        baseUploadUrlInput({ fileSizeBytes: MAX_GLASSES_WALKTHROUGH_ARTIFACT_BYTES + 1 })
      )
    ).toThrow(AppError);
  });
});

describe("validateGlassesWalkthroughCompleteInput", () => {
  it("accepts a well-formed single-artifact payload", () => {
    const result = validateGlassesWalkthroughCompleteInput(baseCompleteInput());
    expect(result.walkId).toBe(WALK);
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]!.kind).toBe("photo");
  });

  it("rejects a missing title", () => {
    expect(() => validateGlassesWalkthroughCompleteInput(baseCompleteInput({ title: "" }))).toThrow(AppError);
  });

  it("accepts a null siteLabel and projectId", () => {
    const result = validateGlassesWalkthroughCompleteInput(baseCompleteInput({ siteLabel: null, projectId: null }));
    expect(result.siteLabel).toBeNull();
    expect(result.projectId).toBeNull();
  });

  it("rejects a non-ISO capturedAt", () => {
    expect(() => validateGlassesWalkthroughCompleteInput(baseCompleteInput({ capturedAt: "not-a-date" }))).toThrow(
      /capturedAt must be an ISO-8601 timestamp/
    );
  });

  it("rejects an empty artifacts array", () => {
    expect(() => validateGlassesWalkthroughCompleteInput(baseCompleteInput({ artifacts: [] }))).toThrow(
      /artifacts must be a non-empty array/
    );
  });

  it("rejects more artifacts than the per-walk ceiling", () => {
    const artifacts = Array.from({ length: MAX_GLASSES_WALKTHROUGH_ARTIFACTS_PER_WALK + 1 }, (_, index) =>
      baseArtifact({ idempotencyKey: `artifact-${index}` })
    );
    expect(() => validateGlassesWalkthroughCompleteInput(baseCompleteInput({ artifacts }))).toThrow(
      /at most .* entries/
    );
  });

  it("rejects a duplicate idempotencyKey WITHIN one request — this is the exact defect the key exists to prevent", () => {
    const artifacts = [baseArtifact({ idempotencyKey: "same" }), baseArtifact({ idempotencyKey: "same" })];
    expect(() => validateGlassesWalkthroughCompleteInput(baseCompleteInput({ artifacts }))).toThrow(
      /is duplicated in this request/
    );
  });

  it("rejects an artifact whose mimeType and declared kind disagree", () => {
    const artifacts = [baseArtifact({ mimeType: "audio/wav", kind: "photo" })];
    expect(() => validateGlassesWalkthroughCompleteInput(baseCompleteInput({ artifacts }))).toThrow(
      /does not match mimeType/
    );
  });

  it("rejects a negative capturedAtMs", () => {
    const artifacts = [baseArtifact({ capturedAtMs: -1 })];
    expect(() => validateGlassesWalkthroughCompleteInput(baseCompleteInput({ artifacts }))).toThrow(
      /capturedAtMs must be a non-negative number/
    );
  });

  it("defaults a missing capturedAtMs to null rather than 0 (0 — the Unix epoch — is a real, meaningful timestamp)", () => {
    const artifacts = [baseArtifact({ capturedAtMs: undefined })];
    const result = validateGlassesWalkthroughCompleteInput(baseCompleteInput({ artifacts }));
    expect(result.artifacts[0]!.capturedAtMs).toBeNull();
  });

  it("lowercases every artifact's mimeType", () => {
    const artifacts = [baseArtifact({ mimeType: "IMAGE/JPEG" })];
    const result = validateGlassesWalkthroughCompleteInput(baseCompleteInput({ artifacts }));
    expect(result.artifacts[0]!.mimeType).toBe("image/jpeg");
  });
});

describe("looksLikeUuid", () => {
  it("accepts a canonical UUID", () => {
    expect(looksLikeUuid(WALK)).toBe(true);
  });

  it("rejects a non-UUID idempotency key", () => {
    expect(looksLikeUuid("artifact-1")).toBe(false);
  });
});
