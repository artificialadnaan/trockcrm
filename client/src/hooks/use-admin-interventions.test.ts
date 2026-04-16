import { describe, expect, it } from "vitest";
import { buildAdminInterventionQuery } from "./use-admin-interventions";

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
