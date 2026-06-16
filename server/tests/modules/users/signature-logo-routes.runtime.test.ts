import { describe, expect, it, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../../../src/lib/r2-client.js", () => ({ getObjectStream: vi.fn() }));

import { getObjectStream } from "../../../src/lib/r2-client.js";
const { signatureLogoPublicRoutes } = await import("../../../src/modules/users/signature-logo-routes.js");

const mockGet = vi.mocked(getObjectStream);

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
  beforeEach(() => mockGet.mockReset());

  it("serves a valid logo from signature-logos/<userId>/<asset> with hardened headers", async () => {
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
    // Key is built ONLY from validated params — always under signature-logos/.
    expect(mockGet).toHaveBeenCalledWith(`signature-logos/${USER}/${ASSET}`);
  });

  it("rejects a non-uuid userId without touching R2 (404)", async () => {
    const res = await request(makeApp()).get(`/api/public/signature-logo/not-a-uuid/${ASSET}`);
    expect(res.status).toBe(404);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("rejects traversal / non-image / malformed assets without touching R2 (404)", async () => {
    for (const bad of ["evil.txt", `${USER}.exe`, "short.png", "..%2f..%2fsecret.png"]) {
      const res = await request(makeApp()).get(`/api/public/signature-logo/${USER}/${bad}`);
      expect(res.status).toBe(404);
    }
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("404s when the object is missing (R2 rejects)", async () => {
    mockGet.mockRejectedValueOnce(new Error("NoSuchKey"));
    const res = await request(makeApp()).get(`/api/public/signature-logo/${USER}/${ASSET}`);
    expect(res.status).toBe(404);
  });
});
