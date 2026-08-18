// What `loadPhotoBuffer`'s strict mode actually covers.
//
// Its own file because the two edges have to be faked — R2 and the transcoder — and pdf-layout.test.ts
// deliberately exercises the real renderer with no mocks at all.
//
// The gap this pins down: `strictStorage` guarded the object READ only. The transcode catch below it
// degraded unconditionally, and untranscodedFallback returns null for every non-JPEG/PNG original — so a
// HEIC whose decode fell over (heic-convert is WASM, concurrency 1, shared process-wide with the field
// scorecard and AI-report renders) produced a placeholder tile and a SUCCESSFUL render. For the weekly
// report that document is content-addressed and, once sent, frozen: the hole in it is permanent.

import { describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  /** What the transcoder does. Set per test. */
  transcode: null as null | (() => Promise<Buffer>),
  object: Buffer.from("original-bytes"),
}));

vi.mock("../../lib/r2-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/r2-client.js")>();
  return {
    ...actual,
    isR2Configured: () => true,
    getObjectBuffer: async () => ({ buffer: harness.object, contentType: undefined }),
  };
});

vi.mock("../../lib/image-thumbnail.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/image-thumbnail.js")>();
  return {
    ...actual,
    generateEvidenceJpeg: async () => {
      if (!harness.transcode) throw new Error("no transcode behaviour configured");
      return harness.transcode();
    },
  };
});

const { loadPhotoBuffer } = await import("./pdf-layout.js");

function photo(mimeType: string) {
  return {
    id: "file-1",
    displayName: "photo.heic",
    description: null,
    takenAt: null,
    createdAt: "1970-01-01T00:00:00.000Z",
    uploaderName: "",
    projectName: "",
    tags: [],
    r2Key: "office_dallas/photos/1",
    externalUrl: null,
    externalThumbnailUrl: null,
    mimeType,
  };
}

describe("loadPhotoBuffer, when the transcode fails", () => {
  it("THROWS in strict mode for an original that has no fallback", () => {
    // HEIC/HEIF/WebP/TIFF: PDFKit cannot embed them, so untranscodedFallback returns null and the only
    // other outcome is the "Image unavailable" tile. In a document that gets frozen, that tile must not be
    // produced by a failure the next attempt might not repeat.
    harness.transcode = async () => {
      throw new Error("heic-convert: out of memory");
    };
    return expect(loadPhotoBuffer(photo("image/heic"), undefined, true)).rejects.toThrow(/out of memory/);
  });

  it("still degrades to the placeholder when strictness is OFF", async () => {
    // The human scorecard path keeps its long-standing behaviour: a report is better than no report.
    harness.transcode = async () => {
      throw new Error("heic-convert: out of memory");
    };
    await expect(loadPhotoBuffer(photo("image/heic"), undefined, false)).resolves.toBeNull();
  });

  it("hands back the untranscoded original in BOTH modes when there is one", async () => {
    // A native JPEG sharp refuses — most often one whose decoded raster is over its pixel limit — still
    // embeds. That is a real photograph, not a degraded tile, so strictness has nothing to object to and
    // must not turn a recoverable render into a failed one.
    harness.object = Buffer.alloc(4096, 7);
    harness.transcode = async () => {
      throw new Error("sharp: Input buffer has corrupt header");
    };
    await expect(loadPhotoBuffer(photo("image/jpeg"), undefined, true)).resolves.toBe(harness.object);
    await expect(loadPhotoBuffer(photo("image/jpeg"), undefined, false)).resolves.toBe(harness.object);
  });

  it("propagates an ABORT in both modes rather than degrading", async () => {
    // The caller gave up on the whole render. Carrying on to draw a placeholder spends the rest of the
    // budget producing a document nobody is waiting for.
    harness.object = Buffer.from("original-bytes");
    harness.transcode = async () => {
      throw new Error("render aborted");
    };
    const aborted = AbortSignal.abort();
    await expect(loadPhotoBuffer(photo("image/heic"), aborted, false)).rejects.toThrow();
    await expect(loadPhotoBuffer(photo("image/heic"), aborted, true)).rejects.toThrow();
  });
});
