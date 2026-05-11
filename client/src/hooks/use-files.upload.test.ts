/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { uploadFile } from "./use-files";

class MockXHR {
  static instances: MockXHR[] = [];
  method = "";
  url = "";
  requestHeaders: Record<string, string> = {};
  withCredentials = false;
  status = 200;
  responseText = "";
  upload = { onprogress: null as ((event: ProgressEvent) => void) | null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  body: unknown;

  constructor() {
    MockXHR.instances.push(this);
  }

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string) {
    this.requestHeaders[name] = value;
  }

  send(body?: unknown) {
    this.body = body;
    this.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 } as ProgressEvent);
    this.onload?.();
  }
}

describe("uploadFile", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    MockXHR.instances = [];
    document.cookie = "csrf_token=; Max-Age=0; path=/";
  });

  it("uploads through presign, direct R2 PUT, and confirm without proxying file bytes through the API", async () => {
    document.cookie = "csrf_token=test-csrf-token; path=/";
    vi.stubGlobal("XMLHttpRequest", MockXHR);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({
          uploadUrl: "https://acct.r2.cloudflarestorage.com/bucket/key",
          uploadToken: "upload-token",
          r2Key: "office/deals/TR-1/photos/file.jpg",
          expiresIn: 1800,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({
          file: { id: "file-1", category: "photo", originalFilename: "roof.jpg" },
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const file = new File(["hello"], "roof.jpg", { type: "image/jpeg" });
    const progress: number[] = [];
    const result = await uploadFile({
      file,
      category: "photo",
      dealId: "deal-1",
      onProgress: (pct) => progress.push(pct),
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/files/upload-url",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "X-CSRF-Token": "test-csrf-token",
        }),
      })
    );
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toMatchObject({
      originalFilename: "roof.jpg",
      mimeType: "image/jpeg",
      fileSizeBytes: file.size,
      category: "photo",
      dealId: "deal-1",
    });
    expect(MockXHR.instances).toHaveLength(1);
    expect(MockXHR.instances[0]).toMatchObject({
      method: "PUT",
      url: "https://acct.r2.cloudflarestorage.com/bucket/key",
      withCredentials: false,
      requestHeaders: { "Content-Type": "image/jpeg" },
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/files/confirm-upload",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
      })
    );
    expect(JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string)).toEqual({
      uploadToken: "upload-token",
    });
    expect(progress).toContain(50);
    expect(result).toMatchObject({ id: "file-1" });
  });

  it("rejects files larger than 200 MB before requesting a presigned URL", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const file = new File(["x"], "drone-scan.zip", { type: "application/zip" });
    Object.defineProperty(file, "size", { value: 201 * 1024 * 1024 });

    await expect(uploadFile({ file, category: "other" })).rejects.toThrow("File exceeds 200 MB limit");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
