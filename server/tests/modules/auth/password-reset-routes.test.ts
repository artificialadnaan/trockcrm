import cookieParser from "cookie-parser";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isPublicAuthCsrfExempt } from "../../../src/modules/auth/http-config.js";

/**
 * The unauthenticated half of the reset flow.
 *
 * The property that matters most is that `request` is INDISTINGUISHABLE between a real account and an
 * unknown one -- same status, same body, same bytes -- and that no email is attempted for an
 * ineligible account. Anything that leaks existence here hands an attacker a roster.
 */

const serviceMocks = vi.hoisted(() => ({
  issueResetToken: vi.fn(),
  deliverResetEmail: vi.fn(),
  isResetTokenUsable: vi.fn(),
  completePasswordReset: vi.fn(),
  finalizePasswordReset: vi.fn(),
  notifyPasswordChanged: vi.fn(),
  lookupUserContact: vi.fn(),
  dbClient: { query: vi.fn(), transaction: vi.fn() },
}));

vi.mock("../../../src/middleware/rate-limit.js", () => ({
  authLimiter: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

vi.mock("../../../src/modules/auth/password-reset-service.js", () => serviceMocks);

// Plain factory, matching the sibling auth suites. The route reaches the password policy through
// password-policy.js, which is NOT mocked here, so the real 12-character rule runs -- no importActual
// and no hand-copied duplicate that could drift from it.
vi.mock("../../../src/modules/auth/local-auth-service.js", () => ({
  loginWithLocalPassword: vi.fn(),
  changeLocalPassword: vi.fn(),
  getUserLocalAuthGate: vi.fn().mockResolvedValue({ mustChangePassword: false }),
}));

const { authRoutes } = await import("../../../src/modules/auth/routes.js");
const { errorHandler } = await import("../../../src/middleware/error-handler.js");

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/auth", authRoutes);
  app.use(errorHandler);
  return app;
}

const GENERIC_FAILURE = "This reset link is no longer valid. Request a new one.";

/**
 * /request answers before it does ANY database work, so the issue+deliver chain is still in flight
 * when supertest resolves. Drain the microtask queue before asserting on it.
 *
 * That ordering is the anti-enumeration property itself, not an implementation detail: leaving work in
 * the handler makes response cost depend on whether the account exists.
 */
async function flushDeferredWork() {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  vi.clearAllMocks();
  serviceMocks.lookupUserContact.mockResolvedValue({ email: "a@b.c", display_name: "A" });
});

describe("POST /api/auth/password-reset/request", () => {
  it("returns a byte-identical response whether or not the account exists", async () => {
    serviceMocks.issueResetToken.mockResolvedValueOnce({
      rawToken: "t",
      user: { id: "u", email: "a@b.c", display_name: "A" },
    });
    const hit = await request(createTestApp())
      .post("/api/auth/password-reset/request")
      .send({ email: "real@trockgc.com" });
    await flushDeferredWork();

    serviceMocks.issueResetToken.mockResolvedValueOnce(null);
    const miss = await request(createTestApp())
      .post("/api/auth/password-reset/request")
      .send({ email: "nobody@trockgc.com" });
    await flushDeferredWork();

    // Pin the status too: "both 404" is also byte-identical, so without this the assertion passes
    // vacuously against a route that does not exist yet.
    expect(hit.status).toBe(200);
    expect(hit.status).toBe(miss.status);
    expect(hit.body).toEqual(miss.body);
    expect(hit.text).toEqual(miss.text);
  });

  it("sends no email when the account is not eligible", async () => {
    serviceMocks.issueResetToken.mockResolvedValueOnce(null);
    await request(createTestApp())
      .post("/api/auth/password-reset/request")
      .send({ email: "nobody@trockgc.com" });
    await flushDeferredWork();
    expect(serviceMocks.deliverResetEmail).not.toHaveBeenCalled();
  });

  it("still returns the generic 200 when the service throws", async () => {
    // A database blip must not become an existence oracle either.
    serviceMocks.issueResetToken.mockRejectedValueOnce(new Error("db down"));
    const res = await request(createTestApp())
      .post("/api/auth/password-reset/request")
      .send({ email: "real@trockgc.com" });
    await flushDeferredWork();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("returns the same 200 for a missing or malformed email without touching the service", async () => {
    const res = await request(createTestApp()).post("/api/auth/password-reset/request").send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(serviceMocks.issueResetToken).not.toHaveBeenCalled();
  });

  it("attempts delivery for an eligible account", async () => {
    const issued = { rawToken: "t", user: { id: "u", email: "a@b.c", display_name: "A" } };
    serviceMocks.issueResetToken.mockResolvedValueOnce(issued);
    await request(createTestApp())
      .post("/api/auth/password-reset/request")
      .send({ email: "real@trockgc.com" });
    await flushDeferredWork();
    expect(serviceMocks.deliverResetEmail).toHaveBeenCalledWith(expect.anything(), issued);
  });
});

describe("POST /api/auth/password-reset/validate", () => {
  it("reports a usable token", async () => {
    serviceMocks.isResetTokenUsable.mockResolvedValueOnce(true);
    const res = await request(createTestApp())
      .post("/api/auth/password-reset/validate")
      .send({ token: "good" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ valid: true });
  });

  it("reports an absent token as invalid without querying", async () => {
    const res = await request(createTestApp()).post("/api/auth/password-reset/validate").send({});
    expect(res.body).toEqual({ valid: false });
    expect(serviceMocks.isResetTokenUsable).not.toHaveBeenCalled();
  });
});

describe("POST /api/auth/password-reset/complete", () => {
  it("returns one generic failure for an unusable token", async () => {
    serviceMocks.completePasswordReset.mockResolvedValueOnce(null);
    const res = await request(createTestApp())
      .post("/api/auth/password-reset/complete")
      .send({ token: "bad", password: ["correct", "horse", "battery"].join("-") });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message: GENERIC_FAILURE } });
    // null also covers "eligibility lapsed inside the TTL", which must NOT reach the finalize step.
    expect(serviceMocks.finalizePasswordReset).not.toHaveBeenCalled();
  });

  it("applies the reset and finalizes on success", async () => {
    const secret = ["correct", "horse", "battery"].join("-");
    serviceMocks.completePasswordReset.mockResolvedValueOnce("user-1");
    const res = await request(createTestApp())
      .post("/api/auth/password-reset/complete")
      .send({ token: "good", password: secret });
    await flushDeferredWork();

    expect(res.status).toBe(200);
    // Consume and apply are one call now, so the route cannot burn a token without writing a password.
    expect(serviceMocks.completePasswordReset).toHaveBeenCalledWith(expect.anything(), "good", secret);
    expect(serviceMocks.finalizePasswordReset).toHaveBeenCalledWith(expect.anything(), "user-1");
  });

  it("rejects a missing token or password with the same generic failure", async () => {
    const noToken = await request(createTestApp())
      .post("/api/auth/password-reset/complete")
      .send({ password: ["correct", "horse", "battery"].join("-") });
    const noPassword = await request(createTestApp())
      .post("/api/auth/password-reset/complete")
      .send({ token: "good" });

    expect(noToken.status).toBe(400);
    expect(noPassword.status).toBe(400);
    expect(noToken.body).toEqual({ error: { message: GENERIC_FAILURE } });
    expect(noPassword.body).toEqual({ error: { message: GENERIC_FAILURE } });
    expect(serviceMocks.completePasswordReset).not.toHaveBeenCalled();
  });

  it("rejects a too-short password WITHOUT consuming the token, so the link survives a typo", async () => {
    const res = await request(createTestApp())
      .post("/api/auth/password-reset/complete")
      .send({ token: "good", password: "short" });

    expect(res.status).toBe(400);
    expect(res.body?.error?.message).toContain("at least 12 characters");
    // The important half: burning the link on a typo would force a whole new email to try again.
    expect(serviceMocks.completePasswordReset).not.toHaveBeenCalled();
  });

  it("surfaces a real failure as itself, not as the generic link failure", async () => {
    // Reporting an infrastructure failure as "your link is no longer valid" would be misleading and
    // send the user off to request an email that would fail the same way. Password is deliberately
    // policy-VALID so the failure comes from the service, not the pre-consume policy check.
    const { AppError } = await import("../../../src/middleware/error-handler.js");
    serviceMocks.completePasswordReset.mockRejectedValueOnce(
      new AppError(409, "Local login is not enabled")
    );

    const res = await request(createTestApp())
      .post("/api/auth/password-reset/complete")
      .send({ token: "good", password: ["correct", "horse", "battery"].join("-") });

    expect(res.status).toBe(409);
    expect(res.body?.error?.message).toContain("Local login is not enabled");
    // Nothing was committed, so nothing may be finalized.
    expect(serviceMocks.finalizePasswordReset).not.toHaveBeenCalled();
  });
});

describe("CSRF exemption", () => {
  const env = {} as never;

  // The CSRF gate engages on any unsafe request carrying a `token` cookie, and this flow's audience is
  // precisely someone holding a STALE cookie who cannot log in. Without the exemption they 403 before
  // the request is ever read.
  it.each([
    "/api/auth/password-reset/request",
    "/api/auth/password-reset/validate",
    "/api/auth/password-reset/complete",
  ])("exempts POST %s", (path) => {
    expect(isPublicAuthCsrfExempt({ method: "POST", path, env })).toBe(true);
  });

  it("does not exempt non-POST methods", () => {
    expect(
      isPublicAuthCsrfExempt({ method: "GET", path: "/api/auth/password-reset/request", env })
    ).toBe(false);
  });

  it("does not exempt an unrelated authenticated path", () => {
    expect(
      isPublicAuthCsrfExempt({ method: "POST", path: "/api/auth/local/change-password", env })
    ).toBe(false);
  });
});
