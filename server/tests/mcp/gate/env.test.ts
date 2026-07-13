import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getDemoPassword, getPublicBaseUrl } from "../../../src/mcp/gate/env.js";

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_DEMO = process.env.DEMO_PASSWORD;
const ORIGINAL_BASE_URL = process.env.PUBLIC_BASE_URL;

describe("getDemoPassword", () => {
  beforeEach(() => {
    delete process.env.DEMO_PASSWORD;
  });
  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    if (ORIGINAL_DEMO === undefined) delete process.env.DEMO_PASSWORD;
    else process.env.DEMO_PASSWORD = ORIGINAL_DEMO;
  });

  it("returns the configured password when set", () => {
    process.env.NODE_ENV = "production";
    const configured = "let-me-in";
    process.env.DEMO_PASSWORD = configured;
    expect(getDemoPassword()).toBe(configured);
  });

  it("throws when missing outside local development/test", () => {
    process.env.NODE_ENV = "production";
    expect(() => getDemoPassword()).toThrow(/DEMO_PASSWORD/);
  });

  it("falls back to a dev placeholder in development/test", () => {
    process.env.NODE_ENV = "test";
    expect(getDemoPassword()).toBeTruthy();
  });
});

describe("getPublicBaseUrl", () => {
  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    if (ORIGINAL_BASE_URL === undefined) delete process.env.PUBLIC_BASE_URL;
    else process.env.PUBLIC_BASE_URL = ORIGINAL_BASE_URL;
  });

  it("accepts a public https origin and normalizes to the origin", () => {
    process.env.NODE_ENV = "production";
    process.env.PUBLIC_BASE_URL = "https://demo.up.railway.app/whatever";
    expect(getPublicBaseUrl()).toBe("https://demo.up.railway.app");
  });

  it("rejects a non-https public origin", () => {
    process.env.NODE_ENV = "production";
    process.env.PUBLIC_BASE_URL = "http://demo.up.railway.app";
    expect(() => getPublicBaseUrl()).toThrow(/https/);
  });

  it("rejects localhost outside local dev/test (Anthropic would hit its own machine)", () => {
    process.env.NODE_ENV = "production";
    process.env.PUBLIC_BASE_URL = "http://localhost:3002";
    expect(() => getPublicBaseUrl()).toThrow(/localhost/);
  });

  it("allows http://localhost in local dev/test", () => {
    process.env.NODE_ENV = "development";
    process.env.PUBLIC_BASE_URL = "http://localhost:3002";
    expect(getPublicBaseUrl()).toBe("http://localhost:3002");
  });
});
