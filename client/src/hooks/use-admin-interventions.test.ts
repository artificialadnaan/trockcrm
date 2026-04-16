import { describe, expect, it } from "vitest";
import {
  buildAdminInterventionQuery,
  buildInterventionWorkspacePath,
  localDateTimeInputToIso,
  toLocalDateTimeInput,
} from "./use-admin-interventions";

describe("buildAdminInterventionQuery", () => {
  it("omits the all status filter from the query string", () => {
    expect(buildAdminInterventionQuery({ page: 1, pageSize: 50, status: "all" })).toBe("?page=1&limit=50");
  });

  it("includes an explicit status filter when selected", () => {
    expect(buildAdminInterventionQuery({ page: 2, pageSize: 25, status: "snoozed" })).toBe(
      "?page=2&limit=25&status=snoozed"
    );
  });

  it("returns an empty string when no params are provided", () => {
    expect(buildAdminInterventionQuery({})).toBe("");
  });
});

describe("buildInterventionWorkspacePath", () => {
  it("omits the default open view", () => {
    expect(buildInterventionWorkspacePath({ view: "open" })).toBe("/admin/interventions");
  });

  it("builds a workspace path with view and cluster filters", () => {
    expect(buildInterventionWorkspacePath({ view: "aging", clusterKey: "execution_stall" })).toBe(
      "/admin/interventions?view=aging&clusterKey=execution_stall"
    );
  });
});

describe("datetime helpers", () => {
  it("formats an ISO string for a datetime-local input", () => {
    expect(toLocalDateTimeInput("2026-04-16T15:45:00.000Z")).toMatch(/^2026-04-16T\d{2}:\d{2}$/);
  });

  it("converts a datetime-local string into an ISO timestamp", () => {
    expect(localDateTimeInputToIso("2026-04-16T10:45")).toMatch(/^2026-04-16T\d{2}:45:00.000Z$/);
  });
});
