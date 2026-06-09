import { describe, expect, it } from "vitest";
import { usageSession, usageHeartbeat, usageViewEvent, usageDaily } from "../index.js";

function columnNames(table: unknown): string[] {
  return Object.values(table as Record<string, unknown>)
    .filter((c): c is { name: string } => !!c && typeof c === "object" && "name" in (c as object))
    .map((c) => c.name);
}

describe("usage schema tables", () => {
  it("usage_session has the expected columns", () => {
    const cols = columnNames(usageSession);
    expect(cols).toEqual(
      expect.arrayContaining([
        "id", "user_id", "started_at", "last_heartbeat_at", "ended_at",
        "active_seconds", "user_agent", "impersonator_id", "created_at",
      ]),
    );
  });

  it("usage_heartbeat references a session and is server-stamped", () => {
    expect(columnNames(usageHeartbeat)).toEqual(
      expect.arrayContaining(["id", "session_id", "user_id", "at"]),
    );
  });

  it("usage_view_event captures entity + route", () => {
    expect(columnNames(usageViewEvent)).toEqual(
      expect.arrayContaining(["id", "user_id", "session_id", "at", "entity_type", "entity_id", "route", "label_snapshot"]),
    );
  });

  it("usage_daily is the forever rollup with a rolled_up_at gate", () => {
    expect(columnNames(usageDaily)).toEqual(
      expect.arrayContaining([
        "user_id", "date", "active_seconds", "session_count", "view_count",
        "action_count", "breakdown", "first_active_at", "last_active_at", "rolled_up_at",
      ]),
    );
  });
});
