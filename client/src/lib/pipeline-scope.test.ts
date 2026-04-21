import { describe, expect, it } from "vitest";
import { normalizePipelineScope } from "./pipeline-scope";

describe("normalizePipelineScope", () => {
  it("redirects reps to mine scope when team is requested", () => {
    expect(
      normalizePipelineScope({
        role: "rep",
        requestedScope: "team",
        entity: "deals",
      })
    ).toEqual({
      allowedScope: "mine",
      redirectTo: "/deals?scope=mine",
    });
  });

  it("keeps directors on team scope when no scope is provided", () => {
    expect(
      normalizePipelineScope({
        role: "director",
        requestedScope: null,
        entity: "leads",
      })
    ).toEqual({
      allowedScope: "team",
      redirectTo: "/leads?scope=team",
    });
  });
});
