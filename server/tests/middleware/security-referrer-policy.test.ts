import express, { type Express } from "express";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import helmet from "helmet";
import { join } from "path";
import request from "supertest";
import { fileURLToPath } from "url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
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

// A handful of SPA routes carry a bearer credential IN THE URL, so for those documents the global
// policy above is the wrong trade: `strict-origin-when-cross-origin` still sends the full path to
// same-origin destinations, and it sends the origin cross-origin, which is enough to tell a third
// party that a given person is holding a reset link. Those pages get `no-referrer` per-response.
//
// The reason this is a per-route header and NOT `<meta name="referrer">` in client/index.html: that
// file is the ONE shell every route loads, so a meta tag there is a GLOBAL policy and reintroduces
// the P0 documented above verbatim. The header is set on the individual `sendFile` response instead,
// which is the only place the SPA's routes are distinguishable server-side.
//
// The tests below deliberately assert status 200 as well as the header. Without that, a route the
// fallback never reaches would 404 and STILL carry helmet's global header — so the "ordinary route
// keeps strict-origin-when-cross-origin" cases would pass against an app that serves nothing at all.
describe("Referrer-Policy on tokenized SPA documents", () => {
  // app.ts resolves the SPA from `<repo>/client/dist` and only registers the fallback when that
  // directory exists — which in a test checkout it usually does not. Stub the minimum that makes the
  // real handler run, and put back exactly what we found: CI may have a genuine client build here.
  const clientDist = fileURLToPath(new URL("../../../client/dist", import.meta.url));
  const clientIndex = join(clientDist, "index.html");
  let createdDist = false;
  let createdIndex = false;
  let app: Express;

  beforeAll(() => {
    if (!existsSync(clientDist)) {
      mkdirSync(clientDist, { recursive: true });
      createdDist = true;
    }
    if (!existsSync(clientIndex)) {
      writeFileSync(clientIndex, "<!doctype html><title>spa stub</title>");
      createdIndex = true;
    }
    // Built AFTER the stub exists: the fallback is registered by an existsSync() check at createApp() time.
    app = createApp();
  });

  afterAll(() => {
    if (createdIndex) rmSync(clientIndex, { force: true });
    if (createdDist) rmSync(clientDist, { recursive: true, force: true });
  });

  it.each([
    ["/reset-password", "the token rides in the query string of this exact path"],
    ["/p/abcdef0123456789", "the photo-viewer token IS the path segment"],
    ["/daily-summary/2026-08-18", "the daily summary is opened by token from an email"],
  ])("serves %s with no-referrer — %s", async (path) => {
    const response = await request(app).get(path);

    expect(response.status).toBe(200);
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
  });

  it.each([
    ["/deals"],
    ["/dashboard"],
    // `/properties` and `/pipeline` are the reason the match cannot be a bare `startsWith("/p")`.
    // Getting that wrong does not merely over-apply a header: it puts `no-referrer` on the documents
    // people do their writing from, which is the exact P0 this file opens with.
    ["/properties"],
    ["/pipeline"],
    // A sibling route whose name merely BEGINS with a tokenized one must not inherit the stricter
    // policy either — `/reset-password` has to match as a whole path segment, not as a substring.
    ["/reset-password-help"],
  ])("leaves %s on the global policy", async (path) => {
    const response = await request(app).get(path);

    expect(response.status).toBe(200);
    expect(response.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  });
});
