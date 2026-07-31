import { describe, it, expect, vi } from "vitest";
import { fetchBoundedExternalImage } from "./external-image.js";

/**
 * The point of this helper is what it REFUSES. It makes the server issue an outbound request to an address
 * it did not choose (a CDN URL an importer wrote into our database), so every bound here is load-bearing.
 */

function response(body: Buffer, init: { status?: number; type?: string; length?: string; url?: string } = {}) {
  return {
    ok: (init.status ?? 200) < 400,
    status: init.status ?? 200,
    url: init.url ?? "https://cdn.example.com/a.jpg",
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "content-type" ? init.type ?? "image/jpeg"
        : name.toLowerCase() === "content-length" ? init.length ?? null
        : null,
    },
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  } as unknown as Response;
}

const CAP = 1_000;

describe("fetchBoundedExternalImage", () => {
  it("reads an ordinary https CDN image", async () => {
    const fetchImpl = vi.fn(async () => response(Buffer.from("jpegbytes")));
    const result = await fetchBoundedExternalImage("https://cdn.example.com/a.jpg", CAP, fetchImpl as never);
    expect(result?.buffer.toString()).toBe("jpegbytes");
    expect(result?.contentType).toBe("image/jpeg");
  });

  it("refuses any scheme other than https and data:", async () => {
    const fetchImpl = vi.fn();
    for (const url of ["http://cdn.example.com/a.jpg", "file:///etc/passwd", "ftp://h/a.jpg", "not a url"]) {
      expect(await fetchBoundedExternalImage(url, CAP, fetchImpl as never)).toBeNull();
    }
    // Refused BEFORE any request is made.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a redirect that lands on a disallowed scheme", async () => {
    // The original url passes; the FINAL one does not. Checking only the input would let a 302 walk the
    // request onto a protocol the allow-list exists to exclude.
    const fetchImpl = vi.fn(async () =>
      response(Buffer.from("x"), { url: "http://169.254.169.254/latest/meta-data" }),
    );
    expect(await fetchBoundedExternalImage("https://cdn.example.com/a.jpg", CAP, fetchImpl as never)).toBeNull();
  });

  it("rejects an oversized body from its declared length, without reading it", async () => {
    const arrayBuffer = vi.fn();
    const fetchImpl = vi.fn(async () => ({
      ...(response(Buffer.alloc(0), { length: String(CAP + 1) }) as unknown as Record<string, unknown>),
      arrayBuffer,
    }) as unknown as Response);
    expect(await fetchBoundedExternalImage("https://cdn.example.com/a.jpg", CAP, fetchImpl as never)).toBeNull();
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it("rejects an oversized body even when the server declared nothing", async () => {
    // A server that omits or lies about Content-Length must not get to stream past the cap unnoticed.
    const fetchImpl = vi.fn(async () => response(Buffer.alloc(CAP + 1), { length: undefined }));
    expect(await fetchBoundedExternalImage("https://cdn.example.com/a.jpg", CAP, fetchImpl as never)).toBeNull();
  });

  it("returns null for a non-OK response, an empty body, or a thrown request", async () => {
    expect(await fetchBoundedExternalImage("https://c/a.jpg", CAP, (async () => response(Buffer.from("x"), { status: 404 })) as never)).toBeNull();
    expect(await fetchBoundedExternalImage("https://c/a.jpg", CAP, (async () => response(Buffer.alloc(0))) as never)).toBeNull();
    expect(await fetchBoundedExternalImage("https://c/a.jpg", CAP, (async () => { throw new Error("ETIMEDOUT"); }) as never)).toBeNull();
  });

  it("returns null for a missing url rather than making a request", async () => {
    const fetchImpl = vi.fn();
    expect(await fetchBoundedExternalImage(null, CAP, fetchImpl as never)).toBeNull();
    expect(await fetchBoundedExternalImage(undefined, CAP, fetchImpl as never)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
