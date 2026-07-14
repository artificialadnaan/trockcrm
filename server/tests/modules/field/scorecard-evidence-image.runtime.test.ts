import { describe, expect, it, vi } from "vitest";
import {
  isEvidenceTranscodable,
  loadScorecardEvidenceImage,
  prioritizeAndCapEvidencePhotos,
  resolveScorecardEvidenceImage,
} from "../../../src/modules/field/scorecard-evidence-image.js";

// The PDF-safe evidence fallback (reviewer finding #1): prefer the ingest thumbnail, but when it's
// missing/unreadable fetch the ORIGINAL under a generous cap and downscale it — so a large valid
// JPEG/WebP/PNG original is preserved as evidence instead of degrading to "Image unavailable". Deps are
// injected so the decision tree is exercised without touching R2 or sharp.

const THUMB = Buffer.from("thumbnail-jpeg");
const TRANSCODED = Buffer.from("transcoded-jpeg");

function deps(over: Partial<Parameters<typeof loadScorecardEvidenceImage>[1]> = {}) {
  return {
    r2Configured: () => true,
    transcodable: () => true,
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

  it("prefers the ingest thumbnail under a tight byte cap and normalizes it to a decodable JPEG", async () => {
    const d = deps();
    const out = await loadScorecardEvidenceImage(
      { r2Key: "orig.jpg", thumbnailR2Key: "thumbs/orig.jpg", mimeType: "image/jpeg" },
      d,
    );
    expect(out).toBe(TRANSCODED);
    expect(d.fetchObject).toHaveBeenCalledTimes(1);
    const [key, maxBytes] = d.fetchObject.mock.calls[0];
    expect(key).toBe("thumbs/orig.jpg");
    expect(maxBytes).toBe(750_000); // thumbnail cap, not the original cap
    expect(d.transcode).toHaveBeenCalledOnce();
    expect(d.transcode).toHaveBeenCalledWith(THUMB);
  });

  it("falls back to transcoding the ORIGINAL under the generous cap when there is no thumbnail (the core fix)", async () => {
    // The fix is the CAP: a large valid original must be fetched under the 40 MB original cap, not the
    // 750 KB thumbnail cap that previously rejected it. Assert the cap value + reference (not a real 5 MB
    // buffer, whose deep-equality compare is needlessly slow).
    const original = Buffer.from("large-valid-original-bytes");
    const fetchObject = vi.fn(async () => original);
    const d = deps({ fetchObject });
    const out = await loadScorecardEvidenceImage(
      { r2Key: "orig.jpg", thumbnailR2Key: null, mimeType: "image/jpeg" },
      d,
    );
    expect(out).toBe(TRANSCODED);
    expect(fetchObject).toHaveBeenCalledTimes(1);
    const [key, maxBytes] = fetchObject.mock.calls[0];
    expect(key).toBe("orig.jpg");
    expect(maxBytes).toBe(40 * 1024 * 1024); // generous original cap, not the 750 KB thumbnail cap
    expect(d.transcode.mock.calls[0][0]).toBe(original); // reference equality — fast
  });

  it("falls back to the original when the thumbnail fetch throws (missing/oversized object)", async () => {
    const fetchObject = vi
      .fn()
      .mockRejectedValueOnce(new Error("NoSuchKey")) // thumbnail
      .mockResolvedValueOnce(Buffer.from("original-bytes")); // original
    const d = deps({ fetchObject });
    const out = await loadScorecardEvidenceImage(
      { r2Key: "orig.webp", thumbnailR2Key: "thumbs/orig.jpg", mimeType: "image/webp" },
      d,
    );
    expect(out).toBe(TRANSCODED);
    expect(fetchObject).toHaveBeenCalledTimes(2);
    expect(fetchObject.mock.calls[1][0]).toBe("orig.webp");
  });

  it("falls back to the original when a non-empty thumbnail cannot be decoded", async () => {
    const corruptThumbnail = Buffer.from("not-really-a-jpeg");
    const original = Buffer.from("valid-original");
    const fetchObject = vi.fn()
      .mockResolvedValueOnce(corruptThumbnail)
      .mockResolvedValueOnce(original);
    const transcode = vi.fn()
      .mockRejectedValueOnce(new Error("unsupported image format"))
      .mockResolvedValueOnce(TRANSCODED);
    const d = deps({ fetchObject, transcode });

    const out = await loadScorecardEvidenceImage(
      { r2Key: "orig.jpg", thumbnailR2Key: "thumbs/orig.jpg", mimeType: "image/jpeg" },
      d,
    );

    expect(out).toBe(TRANSCODED);
    expect(fetchObject.mock.calls.map(([key]) => key)).toEqual(["thumbs/orig.jpg", "orig.jpg"]);
    expect(transcode).toHaveBeenNthCalledWith(1, corruptThumbnail);
    expect(transcode).toHaveBeenNthCalledWith(2, original, "image/jpeg");
  });

  it("transcodes decodable originals (WebP/PNG) when they lack a thumbnail", async () => {
    for (const mimeType of ["image/webp", "image/png"]) {
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
      { r2Key: "orig.webp", thumbnailR2Key: null, mimeType: "image/webp" },
      d,
    );
    expect(out).toBeNull();
  });

  it("distinguishes retryable storage failures from permanent missing/invalid source evidence", async () => {
    const transient = await resolveScorecardEvidenceImage(
      { r2Key: "orig.jpg", thumbnailR2Key: null, mimeType: "image/jpeg" },
      deps({ fetchObject: vi.fn().mockRejectedValue(new Error("R2 timeout")) }),
    );
    expect(transient).toEqual({
      image: null,
      failure: { reason: "storage_unavailable", retryable: true },
    });

    const missingError = Object.assign(new Error("NoSuchKey"), {
      name: "NoSuchKey",
      $metadata: { httpStatusCode: 404 },
    });
    const missing = await resolveScorecardEvidenceImage(
      { r2Key: "missing.jpg", thumbnailR2Key: null, mimeType: "image/jpeg" },
      deps({ fetchObject: vi.fn().mockRejectedValue(missingError) }),
    );
    expect(missing).toEqual({
      image: null,
      failure: { reason: "source_missing", retryable: false },
    });

    const invalid = await resolveScorecardEvidenceImage(
      { r2Key: "invalid.jpg", thumbnailR2Key: null, mimeType: "image/jpeg" },
      deps({ transcode: vi.fn().mockRejectedValue(new Error("bad image")) }),
    );
    expect(invalid).toEqual({
      image: null,
      failure: { reason: "invalid_image", retryable: false },
    });
  });

  it("skips fetching a non-decodable original (unknown mime, no thumbnail)", async () => {
    // Uses the REAL transcodable predicate (not injected) — unknown mime is not fetched.
    const fetchObject = vi.fn(async () => Buffer.from("x"));
    const transcode = vi.fn(async () => TRANSCODED);
    const out = await loadScorecardEvidenceImage(
      { r2Key: "orig.bin", thumbnailR2Key: null, mimeType: null },
      { r2Configured: () => true, fetchObject, transcode },
    );
    expect(out).toBeNull();
    expect(fetchObject).not.toHaveBeenCalled();
    expect(transcode).not.toHaveBeenCalled();
  });

  it("fetches HEIC/HEIF originals for the bounded compatibility decoder", async () => {
    const fetchObject = vi.fn(async () => Buffer.from("heic-bytes"));
    const transcode = vi.fn(async () => TRANSCODED);
    const out = await loadScorecardEvidenceImage(
      { r2Key: "orig.heic", thumbnailR2Key: null, mimeType: "image/heic" },
      { r2Configured: () => true, fetchObject, transcode },
    );
    expect(out).toBe(TRANSCODED);
    expect(fetchObject).toHaveBeenCalledOnce();
    expect(transcode).toHaveBeenCalledWith(
      Buffer.from("heic-bytes"),
      "image/heic",
      { heicDecodePermit: expect.any(Symbol) },
    );
  });

  it("serializes HEIC original fetches process-wide so queued decodes do not retain 40 MB buffers", async () => {
    const releases: Array<() => void> = [];
    let activeFetches = 0;
    let maxActiveFetches = 0;
    const fetchObject = vi.fn(async () => {
      activeFetches += 1;
      maxActiveFetches = Math.max(maxActiveFetches, activeFetches);
      await new Promise<void>((resolve) => releases.push(resolve));
      activeFetches -= 1;
      return Buffer.from("heic-bytes");
    });
    const transcode = vi.fn(async () => TRANSCODED);
    const source = { r2Key: "orig.heic", thumbnailR2Key: null, mimeType: "image/heic" };

    const resolutions = Array.from({ length: 3 }, () =>
      resolveScorecardEvidenceImage(source, { r2Configured: () => true, fetchObject, transcode }),
    );

    await vi.waitFor(() => expect(fetchObject).toHaveBeenCalledTimes(1));
    releases.shift()?.();
    await vi.waitFor(() => expect(fetchObject).toHaveBeenCalledTimes(2));
    releases.shift()?.();
    await vi.waitFor(() => expect(fetchObject).toHaveBeenCalledTimes(3));
    releases.shift()?.();

    await expect(Promise.all(resolutions)).resolves.toEqual([
      { image: TRANSCODED, failure: null },
      { image: TRANSCODED, failure: null },
      { image: TRANSCODED, failure: null },
    ]);
    expect(maxActiveFetches).toBe(1);
  });
});

describe("isEvidenceTranscodable", () => {
  it("accepts formats the deployed sharp can decode", () => {
    for (const mime of ["image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif", "image/avif", "image/tiff", "image/heic", "image/heif"]) {
      expect(isEvidenceTranscodable(mime)).toBe(true);
    }
  });

  it("rejects document and unknown/empty types", () => {
    for (const mime of ["application/pdf", "", null, undefined]) {
      expect(isEvidenceTranscodable(mime)).toBe(false);
    }
  });

  it("ignores content-type parameters", () => {
    expect(isEvidenceTranscodable("image/jpeg; charset=utf-8")).toBe(true);
    expect(isEvidenceTranscodable("image/heic; foo=bar")).toBe(true);
  });
});

describe("prioritizeAndCapEvidencePhotos", () => {
  const row = (sectionKey: string, id: string) => ({ sectionKey, id });

  it("returns all rows untouched when at/under the cap", () => {
    const rows = [row("quality", "a"), row("safety", "b")];
    const { keep, omitted } = prioritizeAndCapEvidencePhotos(rows, 60);
    expect(keep).toEqual(rows);
    expect(omitted).toBe(0);
  });

  it("keeps critical-deficiency evidence first so it's never starved, then fills with section photos", () => {
    const rows = [
      ...Array.from({ length: 60 }, (_, i) => row("quality", `q${i}`)),
      row("critical_deficiency", "d1"),
      row("critical_deficiency", "d2"),
    ];
    const { keep, omitted } = prioritizeAndCapEvidencePhotos(rows, 60);
    expect(keep).toHaveLength(60);
    // Both deficiency photos survive; 2 quality photos are dropped.
    expect(keep.filter((r) => r.sectionKey === "critical_deficiency")).toHaveLength(2);
    expect(omitted).toBe(2);
  });

  it("reports the omitted count and keeps at most `max`", () => {
    const rows = Array.from({ length: 100 }, (_, i) => row("quality", `q${i}`));
    const { keep, omitted } = prioritizeAndCapEvidencePhotos(rows, 60);
    expect(keep).toHaveLength(60);
    expect(omitted).toBe(40);
  });

  it("prioritizes leadership category evidence ahead of Project Summary photos", () => {
    const rows = [
      ...Array.from({ length: 60 }, (_, i) => row("project_summary", `summary-${i}`)),
      row("safety", "safety-1"),
      row("quality_control", "quality-1"),
    ];
    const { keep, omitted } = prioritizeAndCapEvidencePhotos(rows, 60, "leadership");
    expect(keep.map((item) => item.id)).toContain("safety-1");
    expect(keep.map((item) => item.id)).toContain("quality-1");
    expect(keep.filter((item) => item.sectionKey === "project_summary")).toHaveLength(58);
    expect(omitted).toBe(2);
  });
});
