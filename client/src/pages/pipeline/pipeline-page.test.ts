import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildPipelineRequestPath,
  getTerminalDateFilterLabel,
  readTerminalDateFilter,
  summarizeTerminalStageCounts,
  writeTerminalDateFilter,
} from "./pipeline-page";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("summarizeTerminalStageCounts", () => {
  it("aggregates canonical and historical terminal outcomes", () => {
    const summary = summarizeTerminalStageCounts([
      {
        stage: { id: "won", name: "Won", slug: "won" },
        deals: [],
        count: 7,
      },
      {
        stage: { id: "won-normal", name: "Sent to Production", slug: "sent_to_production" },
        deals: [],
        count: 2,
      },
      {
        stage: {
          id: "won-service",
          name: "Service - Sent to Production",
          slug: "service_sent_to_production",
        },
        deals: [],
        count: 3,
      },
      {
        stage: { id: "lost-normal", name: "Production Lost", slug: "production_lost" },
        deals: [],
        count: 1,
      },
      {
        stage: { id: "lost-service", name: "Service - Lost", slug: "service_lost" },
        deals: [],
        count: 4,
      },
      {
        stage: { id: "lost", name: "Lost", slug: "lost" },
        deals: [],
        count: 6,
      },
    ]);

    expect(summary).toEqual({ won: 12, lost: 11 });
  });
});

describe("terminal pipeline date filters", () => {
  it("defaults terminal requests to a 30-day window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T16:00:00Z"));

    expect(
      buildPipelineRequestPath(false, {
        won: { preset: "30" },
        lost: { preset: "30" },
      })
    ).toBe("/deals/pipeline?includeDd=false&won_since=2026-04-01&lost_since=2026-04-01");
  });

  it("serializes preset and custom terminal windows", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T16:00:00Z"));

    expect(
      buildPipelineRequestPath(true, {
        won: { preset: "60" },
        lost: { preset: "custom", customStart: "2026-03-15", customEnd: "2026-04-15" },
      })
    ).toBe(
      "/deals/pipeline?includeDd=true&won_since=2026-03-02&lost_since=2026-03-15&lost_until=2026-04-15"
    );
    expect(getTerminalDateFilterLabel({ preset: "custom", customStart: "2026-03-15" })).toBe("custom");
  });

  it("persists terminal filters in localStorage", () => {
    const storage = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    });

    expect(readTerminalDateFilter("won")).toEqual({ preset: "30" });
    writeTerminalDateFilter("won", { preset: "90" });
    writeTerminalDateFilter("lost", {
      preset: "custom",
      customStart: "2026-04-01",
      customEnd: "2026-04-30",
    });

    expect(readTerminalDateFilter("won")).toEqual({ preset: "90" });
    expect(readTerminalDateFilter("lost")).toEqual({
      preset: "custom",
      customStart: "2026-04-01",
      customEnd: "2026-04-30",
    });
  });
});
