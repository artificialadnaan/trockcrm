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
  consumeResetToken: vi.fn(),
  applyPasswordReset: vi.fn(),
  notifyPasswordChanged: vi.fn(),
  lookupUserContact: vi.fn(),
  dbClient: { query: vi.fn() },
}));

vi.mock("../../../src/middleware/rate-limit.js", () => ({
  authLimiter: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

vi.mock("../../../src/modules/auth/password-reset-service.js", () => serviceMocks);

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

    serviceMocks.issueResetToken.mockResolvedValueOnce(null);
    const miss = await request(createTestApp())
      .post("/api/auth/password-reset/request")
      .send({ email: "nobody@trockgc.com" });

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
    expect(serviceMocks.deliverResetEmail).not.toHaveBeenCalled();
  });

  it("still returns the generic 200 when the service throws", async () => {
    // A database blip must not become an existence oracle either.
    serviceMocks.issueResetToken.mockRejectedValueOnce(new Error("db down"));
    const res = await request(createTestApp())
      .post("/api/auth/password-reset/request")
      .send({ email: "real@trockgc.com" });
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
    serviceMocks.consumeResetToken.mockResolvedValueOnce(null);
    const res = await request(createTestApp())
      .post("/api/auth/password-reset/complete")
      .send({ token: "bad", password: ["correct", "horse", "battery"].join("-") });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { message: GENERIC_FAILURE } });
    expect(serviceMocks.applyPasswordReset).not.toHaveBeenCalled();
  });

  it("applies the reset and notifies on success", async () => {
    const secret = ["correct", "horse", "battery"].join("-");
    serviceMocks.consumeResetToken.mockResolvedValueOnce("user-1");
    serviceMocks.applyPasswordReset.mockResolvedValueOnce(undefined);
    const res = await request(createTestApp())
      .post("/api/auth/password-reset/complete")
      .send({ token: "good", password: secret });

    expect(res.status).toBe(200);
    expect(serviceMocks.applyPasswordReset).toHaveBeenCalledWith("user-1", secret);
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
    expect(serviceMocks.consumeResetToken).not.toHaveBeenCalled();
  });

  it("surfaces a password-policy rejection instead of the generic link failure", async () => {
    // The link WAS valid; the chosen password was not. Telling the user "your link is dead" here would
    // send them back for another email they do not need.
    serviceMocks.consumeResetToken.mockResolvedValueOnce("user-1");
    const { AppError } = await import("../../../src/middleware/error-handler.js");
    serviceMocks.applyPasswordReset.mockRejectedValueOnce(
      new AppError(400, "Password must be at least 12 characters")
    );

    const res = await request(createTestApp())
      .post("/api/auth/password-reset/complete")
      .send({ token: "good", password: "short" });

    expect(res.status).toBe(400);
    expect(res.body?.error?.message).toContain("at least 12 characters");
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
