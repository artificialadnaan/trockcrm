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
});
