import { describe, expect, it } from "vitest";
import {
  CURRENT_SCORECARD_PDF_RENDER_VERSION,
  coalesceScorecardPdfFinalization,
  isContentAddressedScorecardPdfKey,
  classifyScorecardArtifactRecheck,
  isFutureRendererArtifactStale,
  isScorecardPdfObjectMetadataValid,
  needsScorecardPdfRegeneration,
  scorecardEvidenceFingerprint,
  type ScorecardPdfArtifactState,
} from "../../../src/modules/field/scorecard-pdf-artifact.js";

const GENERATION = new Date("2026-07-27T12:00:00.000Z");

function artifact(overrides: Partial<ScorecardPdfArtifactState> = {}): ScorecardPdfArtifactState {
  return {
    // Track the CURRENT renderer revision rather than hardcoding one — a version bump must not require
    // rewriting every unrelated assertion in this file.
    pdfR2Key: `office_dallas/deals/DFW-1/documents/scorecards/card.${"a".repeat(64)}.v${CURRENT_SCORECARD_PDF_RENDER_VERSION}.pdf`,
    pdfRenderVersion: CURRENT_SCORECARD_PDF_RENDER_VERSION,
    linkedPhotoCount: 0,
    pdfContentGeneration: GENERATION,
    currentGeneration: GENERATION,
    ...overrides,
  };
}

describe("needsScorecardPdfRegeneration", () => {
  it("regenerates when the stored R2 key is missing, with or without linked evidence", () => {
    expect(needsScorecardPdfRegeneration(artifact({ pdfR2Key: null }))).toBe(true);
    expect(needsScorecardPdfRegeneration(artifact({ pdfR2Key: null, linkedPhotoCount: 3 }))).toBe(true);
    expect(needsScorecardPdfRegeneration(artifact({ pdfR2Key: "" }))).toBe(true);
  });

  it("regenerates a legacy artifact when linked evidence must be embedded", () => {
    expect(
      needsScorecardPdfRegeneration(
        artifact({ pdfRenderVersion: CURRENT_SCORECARD_PDF_RENDER_VERSION - 1, linkedPhotoCount: 1 }),
      ),
    ).toBe(true);
  });

  // Every renderer revision has changed a photo-less card too: v2 added signature images/deficiency
  // descriptions, v3 added the corrective-action record. A legacy artifact is stale regardless of photos.
  it("regenerates a legacy artifact even without photos", () => {
    expect(
      needsScorecardPdfRegeneration(
        artifact({ pdfRenderVersion: CURRENT_SCORECARD_PDF_RENDER_VERSION - 1, linkedPhotoCount: 0 }),
      ),
    ).toBe(true);
  });

  it("keeps current and future artifacts even when evidence is linked", () => {
    expect(needsScorecardPdfRegeneration(artifact({ linkedPhotoCount: 4 }))).toBe(false);
    expect(
      needsScorecardPdfRegeneration(
        artifact({ pdfRenderVersion: CURRENT_SCORECARD_PDF_RENDER_VERSION + 1, linkedPhotoCount: 4 }),
      ),
    ).toBe(false);
  });

  it("repairs a current-version row whose key was overwritten by a legacy rolling-deploy writer", () => {
    expect(needsScorecardPdfRegeneration(artifact({ pdfR2Key: "scorecards/card.pdf" }))).toBe(true);
    expect(needsScorecardPdfRegeneration(artifact({ pdfR2Key: "scorecards/card.v1.pdf" }))).toBe(true);
    expect(needsScorecardPdfRegeneration(artifact({ pdfR2Key: "scorecards/card.v2.pdf" }))).toBe(true);
  });

  it("treats blank stored keys as missing", () => {
    expect(needsScorecardPdfRegeneration(artifact({ pdfR2Key: "   " }))).toBe(true);
  });
});

describe("isContentAddressedScorecardPdfKey", () => {
  it("accepts only the immutable digest + renderer-version key shape", () => {
    expect(isContentAddressedScorecardPdfKey(`card.${"f".repeat(64)}.v2.pdf`, 2)).toBe(true);
    expect(isContentAddressedScorecardPdfKey("card.v2.pdf", 2)).toBe(false);
    expect(isContentAddressedScorecardPdfKey(`card.${"f".repeat(63)}.v2.pdf`, 2)).toBe(false);
    expect(isContentAddressedScorecardPdfKey(`card.${"f".repeat(64)}.v3.pdf`, 2)).toBe(false);
  });
});

describe("isScorecardPdfObjectMetadataValid", () => {
  it("accepts a non-empty PDF and rejects missing, empty, or wrong-type objects", () => {
    expect(isScorecardPdfObjectMetadataValid({ contentType: "application/pdf", contentLength: 1024 })).toBe(true);
    expect(isScorecardPdfObjectMetadataValid({ contentLength: 1024 })).toBe(true);
    expect(isScorecardPdfObjectMetadataValid(null)).toBe(false);
    expect(isScorecardPdfObjectMetadataValid({ contentType: "application/pdf", contentLength: 0 })).toBe(false);
    expect(isScorecardPdfObjectMetadataValid({ contentType: "image/jpeg", contentLength: 1024 })).toBe(false);
  });
});

describe("scorecardEvidenceFingerprint", () => {
  it("tracks active linked identities and captions deterministically across edits/delete/restore", () => {
    const active = [
      { fileId: "b", isActive: true, deletedAt: null, caption: "Back wall" },
      { fileId: "a", isActive: true, deletedAt: null, caption: "Front wall" },
    ];
    const original = scorecardEvidenceFingerprint(active);
    expect(scorecardEvidenceFingerprint([...active].reverse())).toBe(original);
    expect(scorecardEvidenceFingerprint([{ ...active[0], caption: "Edited caption" }, active[1]])).not.toBe(original);
    expect(scorecardEvidenceFingerprint([
      active[0],
      { fileId: "a", isActive: false, deletedAt: new Date(), caption: "Front wall" },
    ])).not.toBe(original);
  });
});

describe("coalesceScorecardPdfFinalization", () => {
  it("shares one in-flight render for concurrent callers and clears after completion", async () => {
    let resolve!: (value: string) => void;
    const firstRender = new Promise<string>((done) => { resolve = done; });
    let calls = 0;
    const factory = () => {
      calls += 1;
      return firstRender;
    };

    const first = coalesceScorecardPdfFinalization("office:card:v2", factory);
    const second = coalesceScorecardPdfFinalization("office:card:v2", factory);
    expect(second).toBe(first);
    expect(calls).toBe(1);
    resolve("card.v2.pdf");
    await expect(first).resolves.toBe("card.v2.pdf");

    await Promise.resolve();
    await expect(
      coalesceScorecardPdfFinalization("office:card:v2", async () => {
        calls += 1;
        return "card.v2.pdf";
      }),
    ).resolves.toBe("card.v2.pdf");
    expect(calls).toBe(2);
  });

  it("clears a rejected render so a retry can run", async () => {
    await expect(
      coalesceScorecardPdfFinalization("office:failed:v2", async () => {
        throw new Error("temporary R2 failure");
      }),
    ).rejects.toThrow("temporary R2 failure");

    await expect(
      coalesceScorecardPdfFinalization("office:failed:v2", async () => "retry.pdf"),
    ).resolves.toBe("retry.pdf");
  });
});

describe("needsScorecardPdfRegeneration — content generation", () => {
  it("is current when the rendered generation matches the live one", () => {
    expect(needsScorecardPdfRegeneration(artifact())).toBe(false);
  });

  it("regenerates when the scorecard changed after the artifact was rendered", () => {
    // The reported bug: a corrective-action response advances updated_at, but the key/version pair alone
    // could not see it, so the download kept presigning the submit-time object.
    expect(
      needsScorecardPdfRegeneration(
        artifact({ currentGeneration: new Date("2026-07-27T12:05:00.000Z") }),
      ),
    ).toBe(true);
  });

  it("regenerates when the artifact predates the generation column", () => {
    expect(needsScorecardPdfRegeneration(artifact({ pdfContentGeneration: null }))).toBe(true);
  });

  it("compares at millisecond precision so Postgres microseconds cannot force a false regeneration", () => {
    // node-postgres materializes timestamps as millisecond Dates while Postgres retains microseconds.
    // Comparing raw values would report every artifact stale forever and re-render on every download.
    expect(
      needsScorecardPdfRegeneration(
        artifact({
          pdfContentGeneration: new Date("2026-07-27T12:00:00.000Z"),
          currentGeneration: "2026-07-27T12:00:00.000Z",
        }),
      ),
    ).toBe(false);
  });

  it("still regenerates a legacy render version even when the generation matches", () => {
    expect(
      needsScorecardPdfRegeneration(
        artifact({ pdfRenderVersion: CURRENT_SCORECARD_PDF_RENDER_VERSION - 1 }),
      ),
    ).toBe(true);
  });

  it("keeps a FUTURE render version regardless of generation drift", () => {
    // A newer instance's artifact is authoritative; an older instance must not fight it into a re-render loop.
    expect(
      needsScorecardPdfRegeneration(
        artifact({
          pdfRenderVersion: CURRENT_SCORECARD_PDF_RENDER_VERSION + 1,
          currentGeneration: new Date("2026-07-27T13:00:00.000Z"),
        }),
      ),
    ).toBe(false);
  });

  it("treats an unreadable live generation as current rather than looping", () => {
    // A card whose row could not be read must not spin the download in an endless regenerate loop; the
    // caller's own 404/availability handling owns that case.
    expect(needsScorecardPdfRegeneration(artifact({ currentGeneration: null }))).toBe(false);
  });
});

describe("isFutureRendererArtifactStale", () => {
  const GEN = new Date("2026-07-27T12:00:00.000Z");
  const futureKey = `office_dallas/deals/d/scorecards/s.${"a".repeat(64)}.v${CURRENT_SCORECARD_PDF_RENDER_VERSION + 1}.pdf`;

  it("flags a NEWER renderer's artifact whose generation has since moved", () => {
    // An old instance mid-rolling-deploy can neither supersede this artifact (its publish CAS is
    // lte(version, CURRENT)) nor honestly serve it. Serving it silently reproduces the very defect this work
    // fixes, for every download that lands on an old instance, indefinitely.
    expect(
      isFutureRendererArtifactStale(
        artifact({
          pdfR2Key: futureKey,
          pdfRenderVersion: CURRENT_SCORECARD_PDF_RENDER_VERSION + 1,
          pdfContentGeneration: GEN,
          currentGeneration: new Date("2026-07-27T12:05:00.000Z"),
        }),
      ),
    ).toBe(true);
  });

  it("does NOT flag a newer artifact that is still current — it is perfectly serviceable", () => {
    expect(
      isFutureRendererArtifactStale(
        artifact({
          pdfR2Key: futureKey,
          pdfRenderVersion: CURRENT_SCORECARD_PDF_RENDER_VERSION + 1,
          pdfContentGeneration: GEN,
          currentGeneration: GEN,
        }),
      ),
    ).toBe(false);
  });

  it("never flags an artifact at or below this renderer — those take the normal regeneration path", () => {
    for (const version of [CURRENT_SCORECARD_PDF_RENDER_VERSION, CURRENT_SCORECARD_PDF_RENDER_VERSION - 1]) {
      expect(
        isFutureRendererArtifactStale(
          artifact({
            pdfRenderVersion: version,
            pdfContentGeneration: GEN,
            currentGeneration: new Date("2026-07-27T13:00:00.000Z"),
          }),
        ),
      ).toBe(false);
    }
  });
});

describe("classifyScorecardArtifactRecheck", () => {
  const GEN = new Date("2026-07-27T12:00:00.000Z");
  const MOVED = new Date("2026-07-27T12:05:00.000Z");
  const futureKey = `office_dallas/deals/d/scorecards/s.${"a".repeat(64)}.v${CURRENT_SCORECARD_PDF_RENDER_VERSION + 1}.pdf`;

  it("REGRESSION: a stale future-renderer artifact is awaiting-newer-renderer, not current", () => {
    // The pre-presign recheck used to ask needsScorecardPdfRegeneration directly. That function answers "can
    // this instance supersede it?" — always false above CURRENT — so it reported this artifact as current no
    // matter how far the generation had drifted. The download routes' own future-renderer guard runs on the
    // EARLIER snapshot, so a response committing between the two checks slipped straight through and the route
    // presigned a PDF missing its corrective action: the exact defect this branch exists to fix, on the exact
    // surface it was reported from.
    expect(
      classifyScorecardArtifactRecheck(
        artifact({
          pdfR2Key: futureKey,
          pdfRenderVersion: CURRENT_SCORECARD_PDF_RENDER_VERSION + 1,
          pdfContentGeneration: GEN,
          currentGeneration: MOVED,
        }),
      ),
    ).toBe("awaiting-newer-renderer");
  });

  it("still serves a future-renderer artifact whose generation MATCHES", () => {
    // Deliberately narrow. A rollback must not 503 every download — only the cards that actually changed.
    expect(
      classifyScorecardArtifactRecheck(
        artifact({
          pdfR2Key: futureKey,
          pdfRenderVersion: CURRENT_SCORECARD_PDF_RENDER_VERSION + 1,
          pdfContentGeneration: GEN,
          currentGeneration: GEN,
        }),
      ),
    ).toBe("current");
  });

  it("reports a current artifact as current and a drifted one as stale", () => {
    expect(
      classifyScorecardArtifactRecheck(artifact({ pdfContentGeneration: GEN, currentGeneration: GEN })),
    ).toBe("current");
    expect(
      classifyScorecardArtifactRecheck(artifact({ pdfContentGeneration: GEN, currentGeneration: MOVED })),
    ).toBe("stale");
  });

  it("reports a legacy pre-0200 artifact (null rendered generation) as stale, so it regenerates", () => {
    expect(
      classifyScorecardArtifactRecheck(artifact({ pdfContentGeneration: null, currentGeneration: GEN })),
    ).toBe("stale");
  });
});
