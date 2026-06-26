import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getDemoPassword } from "../../../src/mcp/gate/env.js";

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_DEMO = process.env.DEMO_PASSWORD;

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
