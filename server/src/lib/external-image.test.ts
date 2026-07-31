import { describe, it, expect, vi } from "vitest";
import { fetchBoundedExternalImage } from "./external-image.js";

/**
 * The point of this helper is what it REFUSES, and how it tells the two kinds of refusal apart. It makes
 * the server issue an outbound request to an address it did not choose (a CDN URL an importer wrote into
 * our database), so every bound here is load-bearing.
 */

/** A response whose body streams in fixed-size chunks, so the cap can be observed mid-download. */
function streamingResponse(
  chunks: Buffer[],
  init: { status?: number; type?: string; length?: string; url?: string } = {},
) {
  let index = 0;
  const cancel = vi.fn(async () => undefined);
  const reader = {
    read: async () =>
      index < chunks.length ? { done: false, value: new Uint8Array(chunks[index++]) } : { done: true, value: undefined },
    cancel,
    releaseLock: () => undefined,
  };
  return {
    response: {
      ok: (init.status ?? 200) < 400,
      status: init.status ?? 200,
      url: init.url ?? "https://cdn.example.com/a.jpg",
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "content-type" ? init.type ?? "image/jpeg"
          : name.toLowerCase() === "content-length" ? init.length ?? null
          : null,
      },
      body: { getReader: () => reader },
    } as unknown as Response,
    cancel,
    chunksRead: () => index,
  };
}

const CAP = 1_000;

describe("fetchBoundedExternalImage", () => {
  it("reads an ordinary https CDN image", async () => {
    const { response } = streamingResponse([Buffer.from("jpeg"), Buffer.from("bytes")]);
    const result = await fetchBoundedExternalImage("https://cdn.example.com/a.jpg", CAP, (async () => response) as never);
    expect(result.status).toBe("ok");
    expect(result.status === "ok" && result.image.buffer.toString()).toBe("jpegbytes");
    expect(result.status === "ok" && result.image.contentType).toBe("image/jpeg");
  });

  it("aborts mid-stream once the cap is passed, instead of buffering the whole body first", async () => {
    // The bound exists to keep the serialized report worker inside its memory budget. Reading the entire
    // response and measuring afterwards would let an unbounded CDN allocate hundreds of megabytes before
    // anything rejected it — so the download is cancelled the moment the running total goes over.
    const chunks = Array.from({ length: 10 }, () => Buffer.alloc(400)); // 4000 bytes total, cap is 1000
    const { response, cancel, chunksRead } = streamingResponse(chunks, { length: undefined });

    const result = await fetchBoundedExternalImage("https://cdn.example.com/a.jpg", CAP, (async () => response) as never);

    expect(result.status).toBe("unusable");
    expect(cancel).toHaveBeenCalled();
    // Stopped as soon as the total exceeded the cap — not after draining all ten chunks.
    expect(chunksRead()).toBeLessThanOrEqual(3);
  });

  it("refuses any scheme other than https and data:", async () => {
    const fetchImpl = vi.fn();
    for (const url of ["http://cdn.example.com/a.jpg", "file:///etc/passwd", "ftp://h/a.jpg", "not a url"]) {
      expect((await fetchBoundedExternalImage(url, CAP, fetchImpl as never)).status).toBe("unusable");
    }
    expect(fetchImpl).not.toHaveBeenCalled(); // refused BEFORE any request is made
  });

  it("refuses a redirect that lands on a disallowed scheme", async () => {
    // The original url passes; the FINAL one does not. Checking only the input would let a 302 walk the
    // request onto a protocol the allow-list exists to exclude.
    const { response } = streamingResponse([Buffer.from("x")], { url: "http://169.254.169.254/latest/meta-data" });
    const result = await fetchBoundedExternalImage("https://cdn.example.com/a.jpg", CAP, (async () => response) as never);
    expect(result.status).toBe("unusable");
  });

  it("rejects a declared oversize without reading the body at all", async () => {
    const { response, chunksRead } = streamingResponse([Buffer.alloc(10)], { length: String(CAP + 1) });
    expect((await fetchBoundedExternalImage("https://c/a.jpg", CAP, (async () => response) as never)).status).toBe("unusable");
    expect(chunksRead()).toBe(0);
  });

  it("classifies a timeout or reset as UNAVAILABLE, not unusable", async () => {
    // The object is probably fine; this attempt was not. Strict callers fail the render rather than
    // publishing a placeholder beside findings written about that photograph.
    const thrown = await fetchBoundedExternalImage("https://c/a.jpg", CAP, (async () => { throw new Error("ETIMEDOUT"); }) as never);
    expect(thrown.status).toBe("unavailable");

    const { response } = streamingResponse([], { status: 503 });
    expect((await fetchBoundedExternalImage("https://c/a.jpg", CAP, (async () => response) as never)).status).toBe("unavailable");

    const { response: rateLimited } = streamingResponse([], { status: 429 });
    expect((await fetchBoundedExternalImage("https://c/a.jpg", CAP, (async () => rateLimited) as never)).status).toBe("unavailable");
  });

  it("classifies a 4xx and an empty body as UNUSABLE", async () => {
    const { response: notFound } = streamingResponse([], { status: 404 });
    expect((await fetchBoundedExternalImage("https://c/a.jpg", CAP, (async () => notFound) as never)).status).toBe("unusable");

    const { response: empty } = streamingResponse([]);
    expect((await fetchBoundedExternalImage("https://c/a.jpg", CAP, (async () => empty) as never)).status).toBe("unusable");
  });

  it("treats a body that dies partway through as UNAVAILABLE", async () => {
    const response = {
      ok: true,
      status: 200,
      url: "https://cdn.example.com/a.jpg",
      headers: { get: () => null },
      body: { getReader: () => ({ read: async () => { throw new Error("ECONNRESET"); }, cancel: async () => undefined }) },
    } as unknown as Response;
    expect((await fetchBoundedExternalImage("https://c/a.jpg", CAP, (async () => response) as never)).status).toBe("unavailable");
  });

  it("returns unusable for a missing url rather than making a request", async () => {
    const fetchImpl = vi.fn();
    expect((await fetchBoundedExternalImage(null, CAP, fetchImpl as never)).status).toBe("unusable");
    expect((await fetchBoundedExternalImage(undefined, CAP, fetchImpl as never)).status).toBe("unusable");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
