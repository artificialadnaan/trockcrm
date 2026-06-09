import { describe, expect, it } from "vitest";
import { formatActiveTime } from "./use-platform-usage-report";

describe("formatActiveTime", () => {
  it("returns em-dash for zero/negative", () => {
    expect(formatActiveTime(0)).toBe("—");
    expect(formatActiveTime(-1)).toBe("—");
  });

  it("never emits 60m — carries into the hour", () => {
    expect(formatActiveTime(3599)).toBe("1h 0m"); // was "60m" before fix
    expect(formatActiveTime(7199)).toBe("2h 0m"); // was "1h 60m" before fix
  });

  it("formats normal durations", () => {
    expect(formatActiveTime(51600)).toBe("14h 20m");
    expect(formatActiveTime(600)).toBe("10m");
  });
});
