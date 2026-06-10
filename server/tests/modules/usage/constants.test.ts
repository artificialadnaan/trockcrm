import { describe, expect, it } from "vitest";
import { HEARTBEAT_INTERVAL_S, HEARTBEAT_GRACE_S, RAW_RETENTION_DAYS } from "../../../src/modules/usage/constants.js";

describe("usage constants", () => {
  it("pins the heartbeat cadence deterministically", () => {
    expect(HEARTBEAT_INTERVAL_S).toBe(30);
    expect(HEARTBEAT_GRACE_S).toBe(5);
  });

  it("pins the raw retention window", () => {
    expect(RAW_RETENTION_DAYS).toBe(14);
  });
});
