// server/src/modules/usage/interval-merge.test.ts
import { describe, expect, it } from "vitest";
import { mergeActiveSeconds } from "./interval-merge.js";

const t = (sec: number) => new Date(Date.UTC(2026, 5, 9, 12, 0, sec));

describe("mergeActiveSeconds", () => {
  it("credits one interval for a single heartbeat", () => {
    expect(mergeActiveSeconds([t(30)])).toBe(30);
  });

  it("treats two heartbeats one interval apart as contiguous (no double count)", () => {
    expect(mergeActiveSeconds([t(30), t(60)])).toBe(60);
  });

  it("merges across small jitter within the grace window", () => {
    expect(mergeActiveSeconds([t(30), t(63)])).toBe(63);
  });

  it("does NOT credit idle gaps beyond interval+grace", () => {
    expect(mergeActiveSeconds([t(30), t(600)])).toBe(60);
  });

  it("dedups overlapping windows from two tabs", () => {
    expect(mergeActiveSeconds([t(30), t(30), t(60), t(60)])).toBe(60);
  });

  it("returns 0 for no heartbeats", () => {
    expect(mergeActiveSeconds([])).toBe(0);
  });
});
