import { describe, it, expect, vi } from "vitest";
import { fetchBoundedExternalImage, isPrivateAddress } from "./external-image.js";

/**
 * The point of this helper is what it REFUSES, and how it tells the two kinds of refusal apart. It makes
 * the server issue an outbound request to an address it did not choose (a CDN URL an importer wrote into
 * our database), so every bound here is load-bearing.
 *
 * Hosts are written as PUBLIC IP LITERALS so the destination check resolves without touching DNS — these
 * stay hermetic and deterministic, and no request is ever actually issued (fetch is injected).
 */

const PUBLIC_HOST = "https://93.184.216.34/a.jpg";
const CAP = 1_000;

/** A response whose body streams in fixed-size chunks, so the cap can be observed mid-download. */
function streamingResponse(
  chunks: Buffer[],
  init: { status?: number; type?: string; length?: string; location?: string } = {},
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
      headers: {
        get: (name: string) => {
          const key = name.toLowerCase();
          if (key === "content-type") return init.type ?? "image/jpeg";
          if (key === "content-length") return init.length ?? null;
          if (key === "location") return init.location ?? null;
          return null;
        },
      },
      body: { getReader: () => reader },
    } as unknown as Response,
    cancel,
    chunksRead: () => index,
  };
}

describe("isPrivateAddress", () => {
  it("recognises every non-routable range a CDN url must never reach", () => {
    for (const ip of [
      "127.0.0.1", "0.0.0.0", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1",
      "169.254.169.254", // the cloud metadata endpoint — the one that matters most
      "100.64.0.1", "224.0.0.1",
      "::1", "::", "fd00::1", "fe80::1", "::ffff:127.0.0.1",
      "not-an-ip",
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it("lets ordinary public addresses through", () => {
    for (const ip of ["93.184.216.34", "8.8.8.8", "172.15.0.1", "172.32.0.1", "2606:2800:220:1::1"]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });
});

describe("fetchBoundedExternalImage", () => {
  it("reads an ordinary https CDN image", async () => {
    const { response } = streamingResponse([Buffer.from("jpeg"), Buffer.from("bytes")]);
    const result = await fetchBoundedExternalImage(PUBLIC_HOST, CAP, (async () => response) as never);
    expect(result.status).toBe("ok");
    expect(result.status === "ok" && result.image.buffer.toString()).toBe("jpegbytes");
    expect(result.status === "ok" && result.image.contentType).toBe("image/jpeg");
  });

  it("refuses a private destination before any connection is made", async () => {
    // A scheme check alone would accept these: they are all perfectly valid https urls. Reaching them turns
    // report generation into a request against internal infrastructure.
    const fetchImpl = vi.fn();
    for (const url of [
      "https://127.0.0.1/a.jpg",
      "https://169.254.169.254/latest/meta-data",
      "https://10.0.0.5/a.jpg",
      "https://192.168.1.1/a.jpg",
      "https://[::1]/a.jpg",
    ]) {
      expect((await fetchBoundedExternalImage(url, CAP, fetchImpl as never)).status, url).toBe("unusable");
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("validates each redirect hop BEFORE following it", async () => {
    // `redirect: "follow"` was not enough: fetch completes the hop and only then exposes response.url, so
    // the disallowed request has already happened by the time it can be inspected. Following manually is
    // what lets the metadata endpoint be refused without ever being contacted.
    const requested: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      requested.push(url);
      return streamingResponse([], { status: 302, location: "https://169.254.169.254/latest/meta-data" }).response;
    });

    const result = await fetchBoundedExternalImage(PUBLIC_HOST, CAP, fetchImpl as never);

    expect(result.status).toBe("unusable");
    // The first hop was requested; the private target never was.
    expect(requested).toEqual([PUBLIC_HOST]);
  });

  it("gives up on an endless redirect chain", async () => {
    const fetchImpl = vi.fn(async () =>
      streamingResponse([], { status: 302, location: "https://93.184.216.34/next.jpg" }).response,
    );
    const result = await fetchBoundedExternalImage(PUBLIC_HOST, CAP, fetchImpl as never);
    expect(result.status).toBe("unusable");
    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(4); // bounded hop count
  });

  it("aborts mid-stream once the cap is passed, instead of buffering the whole body first", async () => {
    // The bound exists to keep the serialized report worker inside its memory budget. Reading the entire
    // response and measuring afterwards would let an unbounded CDN allocate hundreds of megabytes before
    // anything rejected it — so the download is cancelled the moment the running total goes over.
    const chunks = Array.from({ length: 10 }, () => Buffer.alloc(400)); // 4000 bytes total, cap is 1000
    const { response, cancel, chunksRead } = streamingResponse(chunks, { length: undefined });

    const result = await fetchBoundedExternalImage(PUBLIC_HOST, CAP, (async () => response) as never);

    expect(result.status).toBe("unusable");
    expect(cancel).toHaveBeenCalled();
    expect(chunksRead()).toBeLessThanOrEqual(3); // stopped early, not after draining all ten
  });

  it("refuses any scheme other than https and data:", async () => {
    const fetchImpl = vi.fn();
    for (const url of ["http://93.184.216.34/a.jpg", "file:///etc/passwd", "ftp://h/a.jpg", "not a url"]) {
      expect((await fetchBoundedExternalImage(url, CAP, fetchImpl as never)).status, url).toBe("unusable");
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a declared oversize without reading the body at all", async () => {
    const { response, chunksRead } = streamingResponse([Buffer.alloc(10)], { length: String(CAP + 1) });
    expect((await fetchBoundedExternalImage(PUBLIC_HOST, CAP, (async () => response) as never)).status).toBe("unusable");
    expect(chunksRead()).toBe(0);
  });

  it("classifies a timeout, a 5xx and a 429 as UNAVAILABLE, not unusable", async () => {
    // The object is probably fine; this attempt was not. Strict callers fail the render rather than
    // publishing a placeholder beside findings written about that photograph.
    const thrown = await fetchBoundedExternalImage(PUBLIC_HOST, CAP, (async () => { throw new Error("ETIMEDOUT"); }) as never);
    expect(thrown.status).toBe("unavailable");

    for (const status of [500, 503, 429]) {
      const { response } = streamingResponse([], { status });
      expect((await fetchBoundedExternalImage(PUBLIC_HOST, CAP, (async () => response) as never)).status, String(status)).toBe("unavailable");
    }
  });

  it("classifies a 4xx and an empty body as UNUSABLE", async () => {
    const { response: notFound } = streamingResponse([], { status: 404 });
    expect((await fetchBoundedExternalImage(PUBLIC_HOST, CAP, (async () => notFound) as never)).status).toBe("unusable");

    const { response: empty } = streamingResponse([]);
    expect((await fetchBoundedExternalImage(PUBLIC_HOST, CAP, (async () => empty) as never)).status).toBe("unusable");
  });

  it("treats a body that dies partway through as UNAVAILABLE", async () => {
    const response = {
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: { getReader: () => ({ read: async () => { throw new Error("ECONNRESET"); }, cancel: async () => undefined }) },
    } as unknown as Response;
    expect((await fetchBoundedExternalImage(PUBLIC_HOST, CAP, (async () => response) as never)).status).toBe("unavailable");
  });

  it("returns unusable for a missing url rather than making a request", async () => {
    const fetchImpl = vi.fn();
    expect((await fetchBoundedExternalImage(null, CAP, fetchImpl as never)).status).toBe("unusable");
    expect((await fetchBoundedExternalImage(undefined, CAP, fetchImpl as never)).status).toBe("unusable");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
