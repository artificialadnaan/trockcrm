import assert from "node:assert/strict";
import test from "node:test";
import { getCanonicalCleanupRedirect } from "../src/middleware/canonical-host.js";

test("redirects old Railway cleanup host to onboarding domain with path and query", () => {
  assert.equal(
    getCanonicalCleanupRedirect({
      host: "trock-onboarding-cleanup-production.up.railway.app",
      originalUrl: "/cleanup?foo=bar",
      path: "/cleanup",
    }),
    "https://onboarding.trockcrm.com/cleanup?foo=bar",
  );
});

test("does not redirect health checks on old Railway cleanup host", () => {
  assert.equal(
    getCanonicalCleanupRedirect({
      host: "trock-onboarding-cleanup-production.up.railway.app",
      originalUrl: "/api/health",
      path: "/api/health",
    }),
    null,
  );
});

test("does not redirect canonical onboarding host", () => {
  assert.equal(
    getCanonicalCleanupRedirect({
      host: "onboarding.trockcrm.com",
      originalUrl: "/cleanup",
      path: "/cleanup",
    }),
    null,
  );
});
