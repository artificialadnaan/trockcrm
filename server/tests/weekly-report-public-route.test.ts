import request from "supertest";
import { describe, expect, it } from "vitest";
import { PUBLIC_ROUTE_MOUNTS } from "../src/route-access-policy.js";
import { createApp } from "../src/app.js";

// App-level surface of the client's link.
//
// Every case here is deliberately one the SHAPE GATE answers, so the suite touches no database: a token
// that is not 43 characters of base64url cannot be one of ours, and refusing it before any query is both
// the security property worth testing and what makes this test hermetic. Token lifecycle against real SQL
// lives in tests/modules/weekly-reports/weekly-report-share.runtime.test.ts.

const app = createApp();

describe("/wr is a public mount", () => {
  it("is declared in the public route policy", () => {
    // Not under /api on purpose: it serves HTML to a person, and `/wr/<token>` survives being copied out of
    // an email in a way `/api/public/weekly-reports/<token>` does not.
    expect(PUBLIC_ROUTE_MOUNTS).toContain("/wr");
  });

  it("needs no authentication — a client has no account", async () => {
    const response = await request(app).get("/wr/not-a-real-token");
    expect(response.status).not.toBe(401);
    expect(response.status).not.toBe(403);
  });
});

describe("a link that cannot be one of ours", () => {
  it("answers a friendly HTML page, not JSON and not a stack trace", async () => {
    const response = await request(app).get("/wr/not-a-real-token");

    expect(response.status).toBe(404);
    expect(response.headers["content-type"]).toMatch(/text\/html/);
    expect(response.text).toContain("<!DOCTYPE html>");
    expect(response.text).toContain("couldn’t find that report link");
    // The failure mode this replaces: an "Error: ..." line and a `at fn (file.ts:12:3)` frame.
    expect(response.text).not.toContain("Error:");
    expect(response.text).not.toMatch(/\bat .+\(.+:\d+:\d+\)/);
  });

  it("is marked noindex on the response itself, not only in the markup", async () => {
    const response = await request(app).get("/wr/not-a-real-token");
    expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow, noarchive");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.headers["cache-control"]).toContain("no-store");
  });

  it.each([
    ["", "/wr"],
    ["a trailing slash", "/wr/"],
    ["a traversal attempt", "/wr/..%2f..%2fetc%2fpasswd"],
    ["an over-long segment", `/wr/${"a".repeat(300)}`],
  ])("refuses %s without reaching the database", async (_label, path) => {
    const response = await request(app).get(path);
    expect(response.status).toBe(404);
    expect(response.headers["content-type"]).toMatch(/text\/html/);
  });

  it("refuses the PDF and photo sub-routes on the same gate", async () => {
    expect((await request(app).get("/wr/nope/pdf")).status).toBe(404);
    expect((await request(app).get("/wr/nope/photos/some-file")).status).toBe(404);
  });

  it("answers from the /wr router itself, not from a generic fallback", async () => {
    // What this proves is that the mount handles even a bad link rather than passing it on. It does NOT
    // prove the ordering against the SPA fallback: `app.get("/{*path}")` is only registered when
    // client/dist exists, which it does not in a test checkout. That ordering is a property of app.ts —
    // /wr is mounted at the top, with the other public surfaces — and is stated there.
    const response = await request(app).get("/wr/not-a-real-token");
    expect(response.text).toContain("T-Rock Construction");
    expect(response.text).toContain("couldn’t find that report link");
  });
});
