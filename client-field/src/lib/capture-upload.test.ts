/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildUploadMetadata,
  compressForUpload,
  extractPhotoMetadata,
  fileToDataUrl,
  getLiveGps,
  runConcurrentUploads,
  uploadSessionPhoto,
} from "./capture-upload";

const apiMock = vi.hoisted(() => vi.fn());

vi.mock("./api", () => ({
  api: apiMock,
}));

vi.mock("browser-image-compression", () => ({
  default: vi.fn(async () => new File(["x"], "compressed.jpg", { type: "image/jpeg" })),
}));

vi.mock("exifr", () => ({
  parse: vi.fn(async () => ({
    latitude: 35.123456,
    longitude: -97.123456,
    DateTimeOriginal: new Date("2026-05-05T12:00:00.000Z"),
  })),
}));

describe("capture upload utilities", () => {
  beforeEach(() => {
    apiMock.mockReset();
    vi.unstubAllGlobals();
  });

  it("captures live GPS metadata when geolocation is available", async () => {
    Object.defineProperty(globalThis.navigator, "geolocation", {
      value: {
        getCurrentPosition: vi.fn((success) => success({ coords: { latitude: 35, longitude: -97 } })),
      },
      configurable: true,
    });

    const metadata = await getLiveGps();

    expect(metadata).toMatchObject({
      latitude: 35,
      longitude: -97,
      addressSource: "live_gps",
    });
    expect(metadata.takenAt).toEqual(expect.any(String));
  });

  it("returns empty GPS metadata when geolocation is unavailable", async () => {
    Object.defineProperty(globalThis.navigator, "geolocation", {
      value: undefined,
      configurable: true,
    });

    await expect(getLiveGps()).resolves.toEqual({});
  });

  it("falls back to a capture timestamp when GPS permission fails", async () => {
    Object.defineProperty(globalThis.navigator, "geolocation", {
      value: {
        getCurrentPosition: vi.fn((_success, error) => error()),
      },
      configurable: true,
    });

    await expect(getLiveGps()).resolves.toEqual({ takenAt: expect.any(String) });
  });

  it("compresses images with the field upload defaults", async () => {
    const input = new File(["original"], "photo.jpg", { type: "image/jpeg" });
    const output = await compressForUpload(input);

    expect(output.name).toBe("compressed.jpg");
    expect(output.size).toBeLessThan(input.size + 1);
  });

  it("extracts gallery EXIF GPS and taken-at metadata", async () => {
    const input = new File(["fixture"], "gallery.jpg", { type: "image/jpeg" });

    await expect(extractPhotoMetadata(input, "gallery")).resolves.toEqual({
      latitude: 35.123456,
      longitude: -97.123456,
      addressSource: "exif",
      takenAt: "2026-05-05T12:00:00.000Z",
    });
  });

  it("uses capture time for camera metadata without EXIF parsing", async () => {
    const input = new File(["fixture"], "camera.jpg", { type: "image/jpeg" });

    const metadata = await extractPhotoMetadata(input, "camera");

    expect(metadata).toEqual({ takenAt: expect.any(String) });
  });

  it("reads a file preview data URL", async () => {
    const input = new File(["fixture"], "preview.jpg", { type: "image/jpeg" });

    await expect(fileToDataUrl(input)).resolves.toMatch(/^data:image\/jpeg;base64,/);
  });

  it("builds field confirm metadata from session photos", () => {
    expect(buildUploadMetadata({
      dealId: "deal-1",
      objectKey: "r2/key.jpg",
      uploadToken: "token-1",
      category: "damage",
      caption: "North slope",
      metadata: {
        latitude: 35,
        longitude: -97,
        addressSource: "live_gps",
        takenAt: "2026-05-05T12:00:00.000Z",
      },
    })).toEqual({
      dealId: "deal-1",
      objectKey: "r2/key.jpg",
      uploadToken: "token-1",
      category: "damage",
      caption: "North slope",
      latitude: 35,
      longitude: -97,
      addressSource: "live_gps",
      takenAt: "2026-05-05T12:00:00.000Z",
    });
  });

  it("runs uploads with limited concurrency and continues after failures", async () => {
    const order: string[] = [];
    const result = await runConcurrentUploads(["a", "b", "c"], 2, async (item) => {
      order.push(item);
      if (item === "b") throw new Error("network");
      return `${item}-done`;
    });

    expect(order).toEqual(["a", "b", "c"]);
    expect(result).toEqual([
      { status: "fulfilled", value: "a-done" },
      { status: "rejected", reason: expect.any(Error) },
      { status: "fulfilled", value: "c-done" },
    ]);
  });

  it("uploads one session photo through upload-url, R2 PUT, and confirm-upload", async () => {
    apiMock
      .mockResolvedValueOnce({
        uploadUrl: "https://r2.example.com/upload",
        objectKey: "field/photo.jpg",
        uploadToken: "upload-token",
      })
      .mockResolvedValueOnce({ photo: { id: "photo-1" } });
    const fetchMock = vi.fn(async () => ({ ok: true })) as any;
    vi.stubGlobal("fetch", fetchMock);
    const file = new File(["original"], "photo.jpg", { type: "image/jpeg" });

    await expect(uploadSessionPhoto({
      dealId: "deal-1",
      file,
      category: "damage",
      caption: "North slope",
      tags: ["urgent"],
      metadata: { latitude: 35, longitude: -97, addressSource: "live_gps", takenAt: "2026-05-05T12:00:00.000Z" },
    })).resolves.toEqual({ photo: { id: "photo-1" } });

    expect(apiMock).toHaveBeenNthCalledWith(1, "/field/photos/upload-url", {
      method: "POST",
      json: {
        dealId: "deal-1",
        contentType: "image/jpeg",
        sizeBytes: 1,
        category: "damage",
        caption: "North slope",
        tags: ["urgent"],
      },
    });
    expect(fetchMock).toHaveBeenCalledWith("https://r2.example.com/upload", expect.objectContaining({
      method: "PUT",
      headers: { "Content-Type": "image/jpeg" },
    }));
    expect(apiMock).toHaveBeenNthCalledWith(2, "/field/photos/confirm-upload", {
      method: "POST",
      json: {
        dealId: "deal-1",
        objectKey: "field/photo.jpg",
        uploadToken: "upload-token",
        category: "damage",
        caption: "North slope",
        latitude: 35,
        longitude: -97,
        addressSource: "live_gps",
        takenAt: "2026-05-05T12:00:00.000Z",
      },
    });
  });

  it("surfaces R2 upload failures before confirm-upload", async () => {
    apiMock.mockResolvedValueOnce({
      uploadUrl: "https://r2.example.com/upload",
      objectKey: "field/photo.jpg",
      uploadToken: "upload-token",
    });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false })) as any);

    await expect(uploadSessionPhoto({
      dealId: "deal-1",
      file: new File(["original"], "photo.jpg", { type: "image/jpeg" }),
      category: null,
      metadata: {},
    })).rejects.toThrow("Upload to storage failed");

    expect(apiMock).toHaveBeenCalledTimes(1);
  });
});
