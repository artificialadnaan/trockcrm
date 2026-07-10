import { describe, expect, it, vi } from "vitest";
import { loadScorecardEvidenceImage } from "../../../src/modules/field/scorecards-service.js";

// The PDF-safe evidence fallback (reviewer finding #1): prefer the ingest thumbnail, but when it's
// missing/unreadable fetch the ORIGINAL under a generous cap and downscale it — so a large valid
// JPEG/HEIC/HEIF/WebP original is preserved as evidence instead of degrading to "Image unavailable".
// Deps are injected so the decision tree is exercised without touching R2 or sharp.

const THUMB = Buffer.from("thumbnail-jpeg");
const TRANSCODED = Buffer.from("transcoded-jpeg");

function deps(over: Partial<Parameters<typeof loadScorecardEvidenceImage>[1]> = {}) {
  return {
    r2Configured: () => true,
    thumbnailable: () => true,
    fetchObject: vi.fn(async () => THUMB),
    transcode: vi.fn(async () => TRANSCODED),
    ...over,
  };
}

describe("loadScorecardEvidenceImage", () => {
  it("returns null (placeholder) when R2 is not configured — no fetch/transcode attempted", async () => {
    const d = deps({ r2Configured: () => false });
    const out = await loadScorecardEvidenceImage(
      { r2Key: "orig.jpg", thumbnailR2Key: "thumbs/orig.jpg", mimeType: "image/jpeg" },
      d,
    );
    expect(out).toBeNull();
    expect(d.fetchObject).not.toHaveBeenCalled();
    expect(d.transcode).not.toHaveBeenCalled();
  });

  it("prefers the ingest thumbnail under a tight byte cap and does NOT transcode", async () => {
    const d = deps();
    const out = await loadScorecardEvidenceImage(
      { r2Key: "orig.jpg", thumbnailR2Key: "thumbs/orig.jpg", mimeType: "image/jpeg" },
      d,
    );
    expect(out).toBe(THUMB);
    expect(d.fetchObject).toHaveBeenCalledTimes(1);
    const [key, maxBytes] = d.fetchObject.mock.calls[0];
    expect(key).toBe("thumbs/orig.jpg");
    expect(maxBytes).toBe(750_000); // thumbnail cap, not the original cap
    expect(d.transcode).not.toHaveBeenCalled();
  });

  it("falls back to transcoding the ORIGINAL when there is no thumbnail (the core fix)", async () => {
    // A large valid original (bigger than the old 750 KB cap) must survive: fetched under the generous
    // original cap, then downscaled to a small JPEG.
    const bigOriginal = Buffer.alloc(5_000_000, 1);
    const fetchObject = vi.fn(async () => bigOriginal);
    const d = deps({ fetchObject });
    const out = await loadScorecardEvidenceImage(
      { r2Key: "orig.jpg", thumbnailR2Key: null, mimeType: "image/jpeg" },
      d,
    );
    expect(out).toBe(TRANSCODED);
    expect(fetchObject).toHaveBeenCalledTimes(1);
    const [key, maxBytes] = fetchObject.mock.calls[0];
    expect(key).toBe("orig.jpg");
    expect(maxBytes).toBe(40 * 1024 * 1024); // generous original cap, not 750 KB
    expect(d.transcode).toHaveBeenCalledWith(bigOriginal);
  });

  it("falls back to the original when the thumbnail fetch throws (missing/oversized object)", async () => {
    const fetchObject = vi
      .fn()
      .mockRejectedValueOnce(new Error("NoSuchKey")) // thumbnail
      .mockResolvedValueOnce(Buffer.from("original-bytes")); // original
    const d = deps({ fetchObject });
    const out = await loadScorecardEvidenceImage(
      { r2Key: "orig.heic", thumbnailR2Key: "thumbs/orig.jpg", mimeType: "image/heic" },
      d,
    );
    expect(out).toBe(TRANSCODED);
    expect(fetchObject).toHaveBeenCalledTimes(2);
    expect(fetchObject.mock.calls[1][0]).toBe("orig.heic");
  });

  it("does not silently drop HEIC/HEIF/WebP — transcodes when decodable", async () => {
    for (const mimeType of ["image/heic", "image/heif", "image/webp"]) {
      const d = deps();
      const out = await loadScorecardEvidenceImage(
        { r2Key: `orig.${mimeType.split("/")[1]}`, thumbnailR2Key: null, mimeType },
        d,
      );
      expect(out).toBe(TRANSCODED);
      expect(d.transcode).toHaveBeenCalledTimes(1);
    }
  });

  it("degrades to placeholder (null) when the original genuinely can't be decoded (transcode throws)", async () => {
    const d = deps({ transcode: vi.fn().mockRejectedValue(new Error("unsupported image format")) });
    const out = await loadScorecardEvidenceImage(
      { r2Key: "orig.heic", thumbnailR2Key: null, mimeType: "image/heic" },
      d,
    );
    expect(out).toBeNull();
  });

  it("skips fetching a non-rasterizable original (unknown mime, no thumbnail)", async () => {
    const d = deps({ thumbnailable: () => false });
    const out = await loadScorecardEvidenceImage(
      { r2Key: "orig.bin", thumbnailR2Key: null, mimeType: null },
      d,
    );
    expect(out).toBeNull();
    expect(d.fetchObject).not.toHaveBeenCalled();
    expect(d.transcode).not.toHaveBeenCalled();
  });
});
