import { describe, expect, it } from "vitest";
import { resolveApiBase } from "./api";

describe("resolveApiBase", () => {
  it("uses the same-origin api path by default", () => {
    expect(resolveApiBase({})).toBe("/api");
  });

  it("uses the configured VITE_API_URL when provided", () => {
    expect(resolveApiBase({ VITE_API_URL: "https://api-production-ad218.up.railway.app" }))
      .toBe("https://api-production-ad218.up.railway.app/api");
  });

  it("removes a trailing slash from VITE_API_URL", () => {
    expect(resolveApiBase({ VITE_API_URL: "https://api-production-ad218.up.railway.app/" }))
      .toBe("https://api-production-ad218.up.railway.app/api");
  });

  it("uses the Railway API fallback on the deployed frontend hosts", () => {
    expect(resolveApiBase({}, { hostname: "frontend-production-bcab.up.railway.app" }))
      .toBe("https://api-production-ad218.up.railway.app/api");
    expect(resolveApiBase({}, { hostname: "crm.trockconstruction.com" }))
      .toBe("https://api-production-ad218.up.railway.app/api");
  });

  it("uses the ai-copilot API fallback on the ai-copilot frontend host", () => {
    expect(resolveApiBase({}, { hostname: "frontend-ai-copilot.up.railway.app" }))
      .toBe("https://api-ai-copilot.up.railway.app/api");
  });
});
