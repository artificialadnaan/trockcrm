import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Request } from "express";
import {
  publicViewerBaseUrl,
  publicPhotoShareUrl,
} from "../../../src/modules/public-photo-tokens/public-share-url.js";

// Minimal Express Request stub — only req.get(header) + req.protocol are used.
function fakeReq(headers: Record<string, string>, protocol = "http"): Request {
  return { protocol, get: (h: string) => headers[h.toLowerCase()] } as unknown as Request;
}

describe("publicViewerBaseUrl", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env.PUBLIC_SHARE_BASE_URL;
    delete process.env.FRONTEND_URL;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("prefers PUBLIC_SHARE_BASE_URL (branded domain) over FRONTEND_URL and the request host, trimming trailing slash", () => {
    process.env.PUBLIC_SHARE_BASE_URL = "https://trockcam.com/";
    process.env.FRONTEND_URL = "https://frontend-production-bcab.up.railway.app";
    const req = fakeReq({ host: "api-production-ad218.up.railway.app", "x-forwarded-proto": "https" });
    expect(publicViewerBaseUrl(req)).toBe("https://trockcam.com"); // NOT the railway subdomain or api host
  });

  it("falls back to FRONTEND_URL when PUBLIC_SHARE_BASE_URL is unset (back-compat)", () => {
    process.env.FRONTEND_URL = "https://frontend-production-bcab.up.railway.app/";
    const req = fakeReq({ host: "api-production-ad218.up.railway.app", "x-forwarded-proto": "https" });
    expect(publicViewerBaseUrl(req)).toBe("https://frontend-production-bcab.up.railway.app");
  });

  it("falls back to the request proto+host when neither env var is set (honoring x-forwarded-proto)", () => {
    expect(publicViewerBaseUrl(fakeReq({ host: "localhost:5173" }, "http"))).toBe("http://localhost:5173");
    expect(publicViewerBaseUrl(fakeReq({ host: "localhost:5173", "x-forwarded-proto": "https" }, "http")))
      .toBe("https://localhost:5173");
  });

  it("ignores a blank PUBLIC_SHARE_BASE_URL and falls through", () => {
    process.env.PUBLIC_SHARE_BASE_URL = "   ";
    process.env.FRONTEND_URL = "https://crm.example.com";
    expect(publicViewerBaseUrl(fakeReq({ host: "x" }))).toBe("https://crm.example.com");
  });
});

describe("publicPhotoShareUrl", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("appends /p/<token> (URL-encoded) to the branded base", () => {
    process.env.PUBLIC_SHARE_BASE_URL = "https://trockcam.com";
    expect(publicPhotoShareUrl(fakeReq({ host: "api.example.com", "x-forwarded-proto": "https" }), "Ab3_x-Yz"))
      .toBe("https://trockcam.com/p/Ab3_x-Yz");
  });
});
