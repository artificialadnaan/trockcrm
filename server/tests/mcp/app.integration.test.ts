import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { createMcpDemoApp } from "../../src/mcp/app.js";

const DEMO_PW = "integration-demo-pw";

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

  it("401s the /mcp endpoint without a Bearer MCP token", async () => {
    const res = await request(app)
      .post("/mcp")
      .set("Accept", "application/json, text/event-stream")
      .send({ jsonrpc: "2.0", id: 1, method: "ping" });
    expect(res.status).toBe(401);
  });
});
