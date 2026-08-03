import { describe, expect, it } from "vitest";
import { buildTrockScopeReviewUrl, resolveTrockScopeBaseUrl } from "./trock-scope";

describe("resolveTrockScopeBaseUrl", () => {
  it("returns null when the build has no VITE_TROCK_SCOPE_URL", () => {
    // The panel renders without the link on this answer. It must never become a hardcoded host: TROCK Scope
    // has no stable public origin yet, so a guess ships a link that 404s and looks live.
    expect(resolveTrockScopeBaseUrl({})).toBeNull();
    expect(resolveTrockScopeBaseUrl({ VITE_TROCK_SCOPE_URL: undefined })).toBeNull();
  });

  it("treats a blank or whitespace-only value as not configured", () => {
    expect(resolveTrockScopeBaseUrl({ VITE_TROCK_SCOPE_URL: "   " })).toBeNull();
  });

  it("returns the configured origin", () => {
    expect(resolveTrockScopeBaseUrl({ VITE_TROCK_SCOPE_URL: "https://scope.example.com" })).toBe(
      "https://scope.example.com"
    );
  });

  it("strips trailing slashes so the built path has no empty segment", () => {
    // `https://host//walkthroughs/...` is a different route to several routers, and the failure mode is a
    // 404 on a link that looks correct in the address bar.
    expect(resolveTrockScopeBaseUrl({ VITE_TROCK_SCOPE_URL: "https://scope.example.com//" })).toBe(
      "https://scope.example.com"
    );
  });
});

describe("buildTrockScopeReviewUrl", () => {
  const env = { VITE_TROCK_SCOPE_URL: "https://scope.example.com" };

  it("builds the walkthrough's review URL", () => {
    expect(buildTrockScopeReviewUrl("b91a5bfd-1111-4222-8333-444455556666", env)).toBe(
      "https://scope.example.com/walkthroughs/b91a5bfd-1111-4222-8333-444455556666/review"
    );
  });

  it("returns null for a walk that has no TROCK Scope walkthrough yet", () => {
    // A `processing` walk carries `scopeWalkthroughId: null`. Without this the panel would offer a link to
    // `/walkthroughs/null/review`.
    expect(buildTrockScopeReviewUrl(null, env)).toBeNull();
    expect(buildTrockScopeReviewUrl("   ", env)).toBeNull();
  });

  it("returns null when the origin is not configured, even with a walkthrough id", () => {
    expect(buildTrockScopeReviewUrl("b91a5bfd-1111-4222-8333-444455556666", {})).toBeNull();
  });

  it("percent-encodes the id rather than trusting another service's identifier format", () => {
    expect(buildTrockScopeReviewUrl("a/b?c", env)).toBe("https://scope.example.com/walkthroughs/a%2Fb%3Fc/review");
  });
});
