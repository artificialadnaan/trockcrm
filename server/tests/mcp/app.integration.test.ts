import { describe, it, expect, beforeAll } from "vitest";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import request from "supertest";
import { createMcpDemoApp } from "../../src/mcp/app.js";
import { mintSessionToken } from "../../src/mcp/auth/mintSessionToken.js";

const DEMO_PW = "integration-demo-pw";

// The static-serve block only mounts when the built client exists; mirror the app's own resolution
// so the SPA-fallback test runs in CI (client built) and skips cleanly when it hasn't been built.
const clientDistBuilt = existsSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../../client/dist/index.html")
);

let app: ReturnType<typeof createMcpDemoApp>;

beforeAll(() => {
  process.env.DEMO_PASSWORD = DEMO_PW;
  process.env.MCP_SESSION_SECRET = "integration-mcp-secret";
  app = createMcpDemoApp();
});

describe("T Rock AI demo app (page gate + MCP mount)", () => {
  it("exposes a public health check", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("rejects login with the wrong password and issues no session cookie", async () => {
    const res = await request(app).post("/api/login").send({ password: "nope" });
    expect(res.status).toBe(401);
    // The app always sets a csrf_token cookie (double-submit pattern); the guarantee here is that
    // NO demo session cookie is issued on a failed login.
    const cookies = (res.headers["set-cookie"] as unknown as string[] | undefined) ?? [];
    expect(cookies.some((c) => c.startsWith("trock_ai_demo_session="))).toBe(false);
  });

  it("accepts the correct password and sets an httpOnly session cookie", async () => {
    const res = await request(app).post("/api/login").send({ password: DEMO_PW });
    expect(res.status).toBe(200);
    const cookies = res.headers["set-cookie"] as unknown as string[];
    expect(cookies.some((c) => c.startsWith("trock_ai_demo_session=") && /HttpOnly/i.test(c))).toBe(true);
  });

  it("401s a gated route without a session, 200s with one (full login flow)", async () => {
    const agent = request.agent(app);
    const before = await agent.get("/api/session");
    expect(before.status).toBe(401);

    await agent.post("/api/login").send({ password: DEMO_PW }).expect(200);

    const after = await agent.get("/api/session");
    expect(after.status).toBe(200);
    expect(after.body.authenticated).toBe(true);
  });

  it("401s /api/ai-chat without a demo session (page gate wraps the chat)", async () => {
    const res = await request(app).post("/api/ai-chat").send({ messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(401);
  });

  it("sets a CSP that allows Vega charts to run (unsafe-eval script-src, inline styles)", async () => {
    const res = await request(app).get("/api/health");
    const csp = res.headers["content-security-policy"] ?? "";
    // Vega's expression runtime compiles via Function() and vega-embed injects <style> elements;
    // without these the demo's charts render blank under helmet's default CSP.
    expect(csp).toMatch(/script-src[^;]*'unsafe-eval'/);
    expect(csp).toMatch(/style-src[^;]*'unsafe-inline'/);
    // default-src stays locked to 'self' — the loosening is scoped, not a blanket disable.
    expect(csp).toMatch(/default-src[^;]*'self'/);
  });

  it("401s the /mcp endpoint without a Bearer MCP token", async () => {
    const res = await request(app)
      .post("/mcp")
      .set("Accept", "application/json, text/event-stream")
      .send({ jsonrpc: "2.0", id: 1, method: "ping" });
    expect(res.status).toBe(401);
  });

  it("405s a non-POST method on /mcp (authenticated) instead of falling through to the SPA shell", async () => {
    const res = await request(app).get("/mcp").set("Authorization", `Bearer ${mintSessionToken()}`);
    expect(res.status).toBe(405);
    expect(res.headers["allow"]).toBe("POST");
    // a proper JSON-RPC error, NOT the index.html the SPA catch-all would serve
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body?.error?.code).toBe(-32000);
  });

  // The SPA catch-all serves index.html for any non-API GET so client-side routes (e.g. /ai-demo)
  // load on a hard refresh. sendFile uses the { root } form so a parent dir with a dot-segment (a
  // .claude worktree) doesn't trip send()'s dotfile guard and 500. Only runs when the client is built.
  it.skipIf(!clientDistBuilt)("redirects the root to /ai-demo (dedicated demo service, not the CRM login)", async () => {
    const res = await request(app).get("/").redirects(0);
    expect(res.status).toBe(302);
    expect(res.headers["location"]).toBe("/ai-demo");
  });

  it.skipIf(!clientDistBuilt)("serves the SPA shell (index.html) for a deep link, not a JSON error", async () => {
    const res = await request(app).get("/ai-demo");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.text).toContain("<!DOCTYPE html>");
  });

  it.skipIf(!clientDistBuilt)("keeps API routes ahead of the SPA catch-all", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body.status).toBe("ok");
  });
});
