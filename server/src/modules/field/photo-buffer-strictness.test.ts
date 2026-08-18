// What `loadPhotoBuffer`'s strictness modes actually cover, and — below — which mode each renderer takes.
//
// Its own file because the two edges have to be faked — R2 and the transcoder — and pdf-layout.test.ts
// deliberately exercises the real renderer with no mocks at all.
//
// The two gaps this pins down, one from each review round:
//
//   1. Strictness guarded the object READ only. The transcode catch below it degraded unconditionally, and
//      untranscodedFallback returns null for every non-JPEG/PNG original — so a HEIC whose decode fell over
//      (heic-convert is WASM, concurrency 1, shared process-wide with the field scorecard and AI-report
//      renders) produced a placeholder tile and a SUCCESSFUL render. For the weekly report that document is
//      content-addressed and, once sent, frozen: the hole in it is permanent.
//   2. Closing (1) with a single boolean took the AI report with it. Its vision pass SKIPS a photo whose
//      decode is refused and prints it anyway, so a strict transcode in Phase D failed the whole run — after
//      the model had been paid for the assessment — on a photograph the same job had already decided to
//      tolerate, and every retry died on it again. The two halves are chosen separately now, and the tests
//      at the bottom hold each renderer to its own answer.

import { describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  /** What the transcoder does. Set per test. */
  transcode: null as null | (() => Promise<Buffer>),
  /** What the object read does. Null means "hand back `object`". */
  read: null as null | (() => Promise<{ buffer: Buffer; contentType: string | undefined }>),
  object: Buffer.from("original-bytes"),
}));

vi.mock("../../lib/r2-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/r2-client.js")>();
  return {
    ...actual,
    isR2Configured: () => true,
    getObjectBuffer: async () =>
      harness.read ? harness.read() : { buffer: harness.object, contentType: undefined },
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

const { loadPhotoBuffer, renderFieldPhotoReportPdf } = await import("./pdf-layout.js");

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
  it("THROWS only for the caller that asked for the transcode half", async () => {
    // HEIC/HEIF/WebP/TIFF: PDFKit cannot embed them, so untranscodedFallback returns null and the only
    // other outcome is the "Image unavailable" tile. In a document that gets frozen, that tile must not be
    // produced by a failure the next attempt might not repeat — but a caller that only asked for storage
    // strictness (the AI report) must be left with the tile it has always drawn.
    harness.transcode = async () => {
      throw new Error("heic-convert: out of memory");
    };
    await expect(loadPhotoBuffer(photo("image/heic"), undefined, "storage-and-transcode")).rejects.toThrow(
      /out of memory/,
    );
    await expect(loadPhotoBuffer(photo("image/heic"), undefined, "storage-only")).resolves.toBeNull();
  });

  it("still degrades to the placeholder when strictness is OFF", async () => {
    // The human scorecard path keeps its long-standing behaviour: a report is better than no report.
    harness.transcode = async () => {
      throw new Error("heic-convert: out of memory");
    };
    await expect(loadPhotoBuffer(photo("image/heic"), undefined, "degrade")).resolves.toBeNull();
    // …and that is the DEFAULT, so a caller that says nothing cannot accidentally acquire a failure mode.
    await expect(loadPhotoBuffer(photo("image/heic"), undefined)).resolves.toBeNull();
  });

  it("hands back the untranscoded original in EVERY mode when there is one", async () => {
    // A native JPEG sharp refuses — most often one whose decoded raster is over its pixel limit — still
    // embeds. That is a real photograph, not a degraded tile, so strictness has nothing to object to and
    // must not turn a recoverable render into a failed one.
    harness.object = Buffer.alloc(4096, 7);
    harness.transcode = async () => {
      throw new Error("sharp: Input buffer has corrupt header");
    };
    for (const mode of ["degrade", "storage-only", "storage-and-transcode"] as const) {
      await expect(loadPhotoBuffer(photo("image/jpeg"), undefined, mode), mode).resolves.toBe(harness.object);
    }
    harness.object = Buffer.from("original-bytes");
  });

  it("propagates an ABORT in every mode rather than degrading", async () => {
    // The caller gave up on the whole render. Carrying on to draw a placeholder spends the rest of the
    // budget producing a document nobody is waiting for.
    harness.transcode = async () => {
      throw new Error("render aborted");
    };
    const aborted = AbortSignal.abort();
    for (const mode of ["degrade", "storage-only", "storage-and-transcode"] as const) {
      await expect(loadPhotoBuffer(photo("image/heic"), aborted, mode), mode).rejects.toThrow();
    }
  });
});

describe("loadPhotoBuffer, when the object read fails", () => {
  it("THROWS for BOTH strict callers on a transient failure", async () => {
    // An R2 timeout or auth blip is a property of the storage layer, not of the photograph: the next
    // attempt very likely succeeds, and neither a client's frozen record nor a page of AI findings should
    // be published with a hole where a readable photograph was.
    harness.read = async () => {
      throw new Error("R2: socket hang up");
    };
    try {
      await expect(loadPhotoBuffer(photo("image/jpeg"), undefined, "storage-only")).rejects.toThrow(/hang up/);
      await expect(loadPhotoBuffer(photo("image/jpeg"), undefined, "storage-and-transcode")).rejects.toThrow(
        /hang up/,
      );
      await expect(loadPhotoBuffer(photo("image/jpeg"), undefined, "degrade")).resolves.toBeNull();
    } finally {
      harness.read = null;
    }
  });
});

/**
 * A one-photo findings report — the AI report's layout — rendered for real.
 *
 * Through the actual renderer rather than through loadPhotoBuffer, because the defect was at the CALL SITE:
 * the loader behaved exactly as asked and the wrong thing was asked of it. pdf-layout.test.ts's only
 * findings case uses `r2Key: null`, which never reaches either strict branch at all.
 */
function renderOneFindingsPhoto() {
  return renderFieldPhotoReportPdf({
    cover: {
      creatorName: "Steve Sanchez",
      companyName: "T-Rock Construction",
      reportDateLabel: "August 13, 2026",
      projectName: "4123 Cedar Springs",
      reportTitle: "Condition Assessment",
      photoCount: 1,
    },
    executiveSummary: "One photograph, and the decoder is having a bad day.",
    photoLayout: "findings",
    sections: [{ title: "Findings", photos: [{ ...photo("image/heic"), reportIndex: 1 }] }],
  });
}

describe("the AI report's findings pages", () => {
  it("still print a photo whose decode is refused, exactly as the vision pass decided they should", async () => {
    // THE regression this guards. `prepareImages` skips a photo the decoder refuses and carries on — "one
    // of them must not cost the user a report over the other 59 photographs" — and then hands Phase D
    // `run.photoIds`, every selected photo included. A strict transcode here therefore threw out of the
    // render, marked a paid assessment failed, and sent the retry to die on the same photograph.
    harness.transcode = async () => {
      throw new Error("heic-convert: unsupported feature");
    };
    const pdf = await renderOneFindingsPhoto();
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("but FAIL when the storage read is the thing that broke", async () => {
    // The half that does earn its place on this layout: a findings page carries text written ABOUT the
    // photograph, so a placeholder under it in a document then marked succeeded is worse than a retry.
    harness.transcode = async () => Buffer.from("never reached");
    harness.read = async () => {
      throw new Error("R2: socket hang up");
    };
    try {
      await expect(renderOneFindingsPhoto()).rejects.toThrow(/hang up/);
    } finally {
      harness.read = null;
    }
  });
});
