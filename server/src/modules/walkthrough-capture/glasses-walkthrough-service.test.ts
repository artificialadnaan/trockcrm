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
  GLASSES_WALKTHROUGH_PRESIGN_EXPIRY_SECONDS,
  looksLikeUuid,
  MAX_GLASSES_WALKTHROUGH_ARTIFACT_BYTES,
  MAX_GLASSES_WALKTHROUGH_ARTIFACTS_PER_WALK,
  MAX_GLASSES_WALKTHROUGH_IDEMPOTENCY_KEY_CHARS,
  requestGlassesWalkthroughArtifactUploadUrl,
  validateGlassesWalkthroughArtifactUploadUrlInput,
  validateGlassesWalkthroughCompleteInput,
  type GlassesWalkthroughArtifactStore,
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

  it("percent-encodes the office slug and deal id too, so no component can inject a path segment", () => {
    // walkId/idempotencyKey were encoded from the start; officeSlug/dealId were not. Both are
    // server-supplied today (`req.officeSlug`, `req.params.id`) so this is defence in depth rather than a
    // live escape — but a key derivation where SOME components are escaped and others are not is a trap
    // for the next caller, who has no way to tell which half they are in. Encode all four or none.
    const key = deriveGlassesWalkthroughArtifactR2Key("dallas/evil", "deal id/../..", WALK, "artifact-1", "jpg");
    expect(key).toBe(`dallas%2Fevil/deals/deal%20id%2F..%2F../glasses-walkthroughs/${WALK}/artifact-1.jpg`);
  });

  it("GUARD: leaves the real-world office slug and UUID deal id byte-identical (encoding orphans no stored object)", () => {
    // encodeURIComponent is the identity function over [A-Za-z0-9-_.!~*'()], which covers every slug and
    // every UUID this path has ever produced. That is what makes adding the encoding safe to land on an
    // already-deployed key space — the keys it derives do not move.
    const key = deriveGlassesWalkthroughArtifactR2Key("dallas", DEAL, WALK, "artifact-1", "jpg");
    expect(key).toBe(`dallas/deals/${DEAL}/glasses-walkthroughs/${WALK}/artifact-1.jpg`);
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

  it("rejects a capturedAtMs past the maximum representable Date, which would otherwise poison takenAt", () => {
    // 8.64e15 is the ECMAScript maximum time value; `new Date` of anything beyond it is an Invalid Date,
    // and `files.takenAt` is written straight from this number. An Invalid Date does not throw here — it
    // fails at the INSERT (or, worse on a driver that coerces, lands a null/garbage taken_at), and
    // taken_at is what every chronological read in the app orders on via COALESCE(taken_at, created_at):
    // the field gallery, photo-timeline-filters.ts, files/feed-service.ts. A finite-and-non-negative
    // check alone does not catch it — 1e300 is perfectly finite.
    const artifacts = [baseArtifact({ capturedAtMs: 8_640_000_000_000_001 })];
    expect(() => validateGlassesWalkthroughCompleteInput(baseCompleteInput({ artifacts }))).toThrow(AppError);
  });

  it("accepts a capturedAtMs exactly AT the maximum representable Date (the boundary is inclusive)", () => {
    const artifacts = [baseArtifact({ capturedAtMs: 8_640_000_000_000_000 })];
    const result = validateGlassesWalkthroughCompleteInput(baseCompleteInput({ artifacts }));
    expect(Number.isNaN(new Date(result.artifacts[0]!.capturedAtMs!).getTime())).toBe(false);
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

describe("requestGlassesWalkthroughArtifactUploadUrl", () => {
  function fakeStore(overrides: Partial<GlassesWalkthroughArtifactStore> = {}): GlassesWalkthroughArtifactStore {
    return {
      isConfigured: () => true,
      head: async () => ({}),
      // ECHOES the expiry it was asked for, the way the real store does (generateUploadUrl now returns the
      // value it actually signed). A fake that answers with a fixed 1800 is not a simplification, it is a
      // store that ignores its own port — which the service is now entitled to reject.
      presignUpload: async (_r2Key, _mimeType, _fileSizeBytes, expiresInSeconds) => ({
        uploadUrl: "https://r2.example.com/put",
        expiresIn: expiresInSeconds,
      }),
      ...overrides,
    };
  }

  /**
   * A tenant db that answers "nothing is filed" — enough for the pure-logic cases here, which are about
   * media resolution and key derivation. The already-filed REFUSAL is a `files` question and lives in
   * glasses-walkthrough-service.runtime.test.ts against real SQL, per this file's header.
   *
   * `throwingDb` is the sharper of the two: the media guard must reject BEFORE any database work, so a 400
   * on an unsupported/miscased mimeType is proved by the db never being consulted at all. Stated as a
   * stub-that-explodes rather than a spy assertion because the failure it prevents is silent — a
   * validation error that first burns a pooled round trip is indistinguishable from one that does not,
   * until the endpoint is under load from a client sending a bad Content-Type on every retry.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const emptyDb = { select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }) } as any;
  const throwingDb = {
    select: () => {
      throw new Error("the media guard must reject before any database work");
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  function uploadUrlInput(overrides: Record<string, unknown> = {}) {
    return {
      dealId: DEAL,
      walkId: WALK,
      idempotencyKey: "artifact-1",
      kind: "video" as const,
      mimeType: "video/mp4",
      fileSizeBytes: 1024,
      ...overrides,
    };
  }

  it("presigns against the server-derived key, never a caller-supplied one", async () => {
    const seen: string[] = [];
    const result = await requestGlassesWalkthroughArtifactUploadUrl({
      tenantDb: emptyDb,
      officeSlug: "dallas",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      input: uploadUrlInput() as any,
      artifactStore: fakeStore({
        presignUpload: async (r2Key, _mimeType, _fileSizeBytes, expiresInSeconds) => {
          seen.push(r2Key);
          return { uploadUrl: "https://r2.example.com/put", expiresIn: expiresInSeconds };
        },
      }),
    });
    expect(result.r2Key).toBe(deriveGlassesWalkthroughArtifactR2Key("dallas", DEAL, WALK, "artifact-1", "mp4"));
    expect(seen).toEqual([result.r2Key]);
  });

  it("400s on an unsupported mimeType instead of crashing on the undefined media lookup", async () => {
    // This function is EXPORTED and re-reads GLASSES_WALKTHROUGH_ACCEPTED_MEDIA itself rather than
    // trusting the validated input it is handed — exactly as prepareGlassesWalkthroughArtifacts does. But
    // unlike that function it did not guard the lookup, so an unaccepted mimeType reached
    // `media.extension` on `undefined`: a TypeError, which the error handler surfaces as a 500. A caller
    // that sent a bad media type deserves the same 400 the validator would have given it, not an alert.
    await expect(
      requestGlassesWalkthroughArtifactUploadUrl({
        tenantDb: throwingDb,
        officeSlug: "dallas",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        input: uploadUrlInput({ mimeType: "application/pdf", kind: "video" }) as any,
        artifactStore: fakeStore(),
      })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("400s rather than crashing when the mimeType is cased differently than the allowlist's own keys", async () => {
    // The allowlist is keyed by LOWERCASE mime type and the validator lowercases before handing over, but
    // a direct caller need not have — and an unguarded lookup turns that ordinary mistake into a 500.
    await expect(
      requestGlassesWalkthroughArtifactUploadUrl({
        tenantDb: throwingDb,
        officeSlug: "dallas",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        input: uploadUrlInput({ mimeType: "VIDEO/MP4" }) as any,
        artifactStore: fakeStore(),
      })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  // ── The lifetime of the capability this endpoint mints ──────────────────────────────────────────
  //
  // The already-filed refusal above is a check at MINT time, and a mint-time check cannot bind a
  // capability that outlives the mint. Presign artifact A, let the walk complete and freeze, then PUT to
  // the URL you were legitimately given beforehand: the bytes behind an immutable `files` row are
  // replaced, and nothing revokes a signature that is already in the client's hands. These pin the one
  // dimension the server still controls — how long that outliving lasts.

  /** Captures what the service ASKS the store for, and echoes it back the way `generateUploadUrl` does.
   *  Rest-typed so the same fake compiles against the port both before and after it grew the argument. */
  function recordingStore(seen: unknown[][]): GlassesWalkthroughArtifactStore {
    return {
      isConfigured: () => true,
      head: async () => ({}),
      presignUpload: (async (...args: unknown[]) => {
        seen.push(args);
        return { uploadUrl: "https://r2.example.com/put", expiresIn: (args[3] as number | undefined) ?? 1800 };
      }) as GlassesWalkthroughArtifactStore["presignUpload"],
    };
  }

  it("REGRESSION: mints a capability measured in minutes, not the shared 30-minute upload default", async () => {
    // 1800s is `PRESIGNED_URL_EXPIRY_SECONDS`, sized for a browser picking a file out of a dialog. Here it
    // is the exact width of the window in which filed bytes can still be swapped, and this client does not
    // need it: `putArtifactBytes` (mobile/src/walkthrough/upload.ts) awaits the presign and PUTs on the very
    // next line, never persisting the URL. The window has to cover a handoff, not a browsing session.
    const seen: unknown[][] = [];
    const result = await requestGlassesWalkthroughArtifactUploadUrl({
      tenantDb: emptyDb,
      officeSlug: "dallas",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      input: uploadUrlInput() as any,
      artifactStore: recordingStore(seen),
    });
    expect(seen[0]![3]).toBe(300);
    expect(result.expiresIn).toBe(300);
  });

  it("REGRESSION: reports the same short lifetime on the dev/CI mock branch", async () => {
    // The unconfigured branch used to hardcode 1800 next to a real branch that no longer says 1800. Nobody
    // can PUT to a `mock://` URL, so this is not a security hole — it is the reproduction environment
    // quietly disagreeing with production about the contract, which is where a wrong belief about the
    // window gets formed and then carried into a real incident.
    const result = await requestGlassesWalkthroughArtifactUploadUrl({
      tenantDb: emptyDb,
      officeSlug: "dallas",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      input: uploadUrlInput() as any,
      artifactStore: { ...recordingStore([]), isConfigured: () => false },
    });
    expect(result.expiresIn).toBe(300);
  });

  it("REGRESSION: refuses to hand back a URL the store minted for LONGER than it was asked for", async () => {
    // The ceiling is only worth the paper it is written on if the port is obeyed. A store wired to the
    // shared `generateUploadUrl` and silently dropping the argument — the exact shape of this seam's
    // existing `fileSizeBytes`/`_maxSizeBytes` mismatch, which IS dropped on purpose — would report a
    // bounded number here and hand the client a 30-minute signature. There is no way to shorten a URL
    // after it is signed, so the only correct move is to refuse to pass it on.
    await expect(
      requestGlassesWalkthroughArtifactUploadUrl({
        tenantDb: emptyDb,
        officeSlug: "dallas",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        input: uploadUrlInput() as any,
        artifactStore: {
          isConfigured: () => true,
          head: async () => ({}),
          presignUpload: async () => ({ uploadUrl: "https://r2.example.com/put", expiresIn: 1800 }),
        },
      })
    ).rejects.toBeInstanceOf(AppError);
  });

  it("GUARD: the glasses ceiling stays strictly under the shared upload default", async () => {
    // Not a tautology against the number above: it pins the RELATIONSHIP to a constant this module does not
    // own. `PRESIGNED_URL_EXPIRY_SECONDS` is tuned for browser upload dialogs by people with no reason to
    // think about walk artifacts, and the one edit that silently reopens this window to its full width is
    // someone raising that default and this module inheriting it. Green both before and after the fix.
    const { PRESIGNED_URL_EXPIRY_SECONDS } = await import("../files/file-constants.js");
    expect(GLASSES_WALKTHROUGH_PRESIGN_EXPIRY_SECONDS).toBeLessThan(PRESIGNED_URL_EXPIRY_SECONDS);
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
