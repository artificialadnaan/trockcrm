import request from "supertest";
import { describe, expect, it, vi } from "vitest";

vi.mock("./modules/procore/event-handlers.js", () => ({
  registerProcoreEventHandlers: vi.fn(),
}));

vi.mock("./modules/notifications/sse-manager.js", () => ({
  initSsePush: vi.fn(),
}));

describe("app SyncHub relay registration", () => {
  it("serves health checks", async () => {
    const { createApp } = await import("./app.js");

    const response = await request(createApp()).get("/api/health");

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("ok");
  });

  it("mounts the SyncHub relay before JSON and CSRF middleware", async () => {
    process.env.SYNCHUB_RELAY_RECEIVER_ENABLED = "false";
    const { createApp } = await import("./app.js");

    const response = await request(createApp())
      .post("/api/webhooks/synchub/procore-project-created")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ eventType: "procore.project.created" }));

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: { message: "relay receiver disabled" } });
    delete process.env.SYNCHUB_RELAY_RECEIVER_ENABLED;
  });

  it("keeps field custom-header CSRF behavior active after public webhook mounts", async () => {
    const { createApp } = await import("./app.js");

    const response = await request(createApp())
      .post("/api/field/projects/project-1/star")
      .set("Cookie", ["token=session-token"]);

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: { message: "Missing required header for cross-origin request." } });
  });

  it("keeps CRM double-submit CSRF origin and token checks active", async () => {
    const { createApp } = await import("./app.js");

    const missingOrigin = await request(createApp())
      .post("/api/health")
      .set("Cookie", ["token=session-token"]);
    expect(missingOrigin.status).toBe(403);
    expect(missingOrigin.body).toEqual({ error: { message: "Forbidden origin" } });

    const invalidToken = await request(createApp())
      .post("/api/health")
      .set("Origin", "http://localhost:5173")
      .set("Cookie", ["token=session-token", "csrf_token=csrf-a"])
      .set("x-csrf-token", "csrf-b");
    expect(invalidToken.status).toBe(403);
    expect(invalidToken.body).toEqual({ error: { message: "Invalid CSRF token" } });

    const validToken = await request(createApp())
      .post("/api/health")
      .set("Origin", "http://localhost:5173")
      .set("Cookie", ["token=session-token", "csrf_token=csrf-a"])
      .set("x-csrf-token", "csrf-a");
    expect(validToken.status).toBe(401);
  });
});
