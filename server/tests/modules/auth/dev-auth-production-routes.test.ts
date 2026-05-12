import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../../src/app.js";

const originalEnv = { ...process.env };

describe("production dev auth route hardening", () => {
  beforeEach(() => {
    process.env = {
      ...originalEnv,
      NODE_ENV: "production",
      DEV_MODE: "true",
      ALLOW_DEV_AUTH_IN_PROD: "true",
      FIELD_APP_URL: "https://field.trockcrm.com",
    };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("keeps /api/auth/dev/users closed when the production acknowledgement is absent", async () => {
    const response = await request(createApp())
      .get("/api/auth/dev/users")
      .set("Host", "trockcrm.com");

    expect(response.status).toBe(404);
  });

  it("keeps /api/auth/dev/login closed when the production acknowledgement is absent", async () => {
    const response = await request(createApp())
      .post("/api/auth/dev/login")
      .set("Host", "trockcrm.com")
      .send({ email: "admin@trock.dev" });

    expect(response.status).toBe(404);
  });
});
