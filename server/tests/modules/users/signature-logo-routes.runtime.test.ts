import { describe, expect, it, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../../../src/lib/r2-client.js", () => ({ getObjectStream: vi.fn(), headObject: vi.fn() }));

import { getObjectStream, headObject } from "../../../src/lib/r2-client.js";
import { SIGNATURE_LOGO_MAX_BYTES } from "../../../src/modules/users/signature-logo.js";
const { signatureLogoPublicRoutes } = await import("../../../src/modules/users/signature-logo-routes.js");

const mockGet = vi.mocked(getObjectStream);
const mockHead = vi.mocked(headObject);

function makeApp() {
  const app = express();
  app.use("/api/public/signature-logo", signatureLogoPublicRoutes);
  // Surface AppError statusCode (express's default handler would 500 everything).
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err?.statusCode ?? 500).json({ error: err?.message ?? "error" });
  });
  return app;
}

const USER = "11111111-1111-4111-8111-111111111111";
const ASSET = "22222222-2222-4222-8222-222222222222.png";

describe("public signature-logo route", () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockHead.mockReset();
  });

  it("serves a within-cap logo from signature-logos/<userId>/<asset> with hardened headers", async () => {
    mockHead.mockResolvedValue({ contentLength: 4 });
    async function* body() {
      yield new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    }
    mockGet.mockResolvedValue({ stream: body(), contentLength: 4 });

    const res = await request(makeApp()).get(`/api/public/signature-logo/${USER}/${ASSET}`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("image/png");
    expect(res.headers["cache-control"]).toContain("immutable");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    expect(mockGet).toHaveBeenCalledWith(`signature-logos/${USER}/${ASSET}`);
  });

  it("404s an OVERSIZED object at serve time and never streams it (TOCTOU/overwrite guard)", async () => {
    mockHead.mockResolvedValue({ contentLength: SIGNATURE_LOGO_MAX_BYTES + 1 });
    const res = await request(makeApp()).get(`/api/public/signature-logo/${USER}/${ASSET}`);
    expect(res.status).toBe(404);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("404s (no immutable cache) an object that passes HEAD but is oversized at GET (overwrite race)", async () => {
    mockHead.mockResolvedValue({ contentLength: 100 }); // small at HEAD → passes the gate
    const chunk = new Uint8Array(600_000); // two of these = 1.2 MB at GET, over the 1 MB cap
    async function* body() {
      yield chunk;
      yield chunk;
    }
    mockGet.mockResolvedValue({ stream: body() });

    const res = await request(makeApp()).get(`/api/public/signature-logo/${USER}/${ASSET}`);

    // Over-cap at GET: never relayed as a 200, and crucially NOT cached (no immutable header on the 404).
    expect(res.status).toBe(404);
    expect(res.headers["cache-control"]).toBeUndefined();
  });

  it("404s (no immutable cache) when the stream errors mid-read", async () => {
    mockHead.mockResolvedValue({ contentLength: 100 });
    async function* body() {
      yield new Uint8Array([1, 2, 3]);
      throw new Error("R2 stream error");
    }
    mockGet.mockResolvedValue({ stream: body() });

    const res = await request(makeApp()).get(`/api/public/signature-logo/${USER}/${ASSET}`);
    expect(res.status).toBe(404);
    expect(res.headers["cache-control"]).toBeUndefined();
  });

  it("404s a missing object without streaming", async () => {
    mockHead.mockResolvedValue(null);
    const res = await request(makeApp()).get(`/api/public/signature-logo/${USER}/${ASSET}`);
    expect(res.status).toBe(404);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("rejects a non-uuid userId without touching R2 (404)", async () => {
    const res = await request(makeApp()).get(`/api/public/signature-logo/not-a-uuid/${ASSET}`);
    expect(res.status).toBe(404);
    expect(mockHead).not.toHaveBeenCalled();
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("rejects traversal / non-image / malformed assets without touching R2 (404)", async () => {
    for (const bad of ["evil.txt", `${USER}.exe`, "short.png", "..%2f..%2fsecret.png"]) {
      const res = await request(makeApp()).get(`/api/public/signature-logo/${USER}/${bad}`);
      expect(res.status).toBe(404);
    }
    expect(mockHead).not.toHaveBeenCalled();
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("404s when the stream fetch rejects after the size check passes", async () => {
    mockHead.mockResolvedValue({ contentLength: 4 });
    mockGet.mockImplementation(async () => {
      throw new Error("NoSuchKey");
    });
    const res = await request(makeApp()).get(`/api/public/signature-logo/${USER}/${ASSET}`);
    expect(res.status).toBe(404);
  });
});
