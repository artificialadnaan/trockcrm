import express from "express";
import helmet from "helmet";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { getSecurityOptions } from "../../src/middleware/security.js";

// The API service also serves the CRM SPA (https://trockcrm.com), so its `/api` calls are
// SAME-ORIGIN and therefore not CORS requests. Per the Fetch spec ("append a request `Origin`
// header"), a non-CORS request with a method other than GET/HEAD gets `Origin: null` when the
// document's referrer policy is `no-referrer` — and the `Referer` fallback is stripped too.
// helmet's DEFAULT is `no-referrer`, which left getRequestOrigin() with nothing to read and made
// every mutating request from that host 403 "Forbidden origin" (send-invite, logout, usage
// session/start). Cross-origin clients (the separate Frontend service) were unaffected because
// CORS mode always sends Origin.
describe("security Referrer-Policy", () => {
  it("uses a policy that preserves Origin on same-origin mutating requests", async () => {
    const app = express();
    app.use(helmet(getSecurityOptions({} as NodeJS.ProcessEnv)));
    app.get("/", (_req, res) => {
      res.send("ok");
    });

    const response = await request(app).get("/");

    expect(response.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(response.headers["referrer-policy"]).not.toBe("no-referrer");
  });
});
