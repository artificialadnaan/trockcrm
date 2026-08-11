// The write half of the service-classification fix.
//
// Reading service correctly (aliasedIsServiceProjectSql) fixes today's REPORTS. It does not fix
// `deals.workflow_route`, which drives BEHAVIOUR: which pipeline family a deal travels
// (service_estimating vs estimating), the family a converted lead lands in, and whether the deal is
// exempt from RFP approval voting. That column is NOT NULL DEFAULT 'normal' and nothing derived it from
// the project type, so a service deal started life in the normal pipeline and stayed there.
//
// This pins the derivation itself. The route is derived at CREATE only — deliberately not on a later
// project-type change, because flipping the route on a live deal moves it to a different stage family
// and changes its RFP voting rules mid-flight. Reclassifying existing rows is a reviewed backfill, not a
// silent side effect of editing a dropdown.
import { describe, expect, it } from "vitest";
import { PROJECT_TYPE_OPTIONS } from "@trock-crm/shared/types";
import { workflowRouteForProjectType } from "../../../src/modules/deals/service.js";
import { resolveProjectTypeCode } from "../../../src/services/projectNumber.js";

describe("workflowRouteForProjectType", () => {
  it("routes the service project type to the service workflow", () => {
    expect(workflowRouteForProjectType("service")).toBe("service");
  });

  it("routes every OTHER configured project type to normal", () => {
    // Driven off the shared vocabulary rather than a retyped list, so adding a project type cannot
    // silently acquire a route nobody chose for it.
    const others = PROJECT_TYPE_OPTIONS.filter((option) => option.value !== "service");
    expect(others.length).toBe(8); // not vacuous: the loop below has real work to do
    for (const option of others) {
      expect({ type: option.value, route: workflowRouteForProjectType(option.value) })
        .toEqual({ type: option.value, route: "normal" });
    }
  });

  it("normalizes case and surrounding whitespace, as the canonical resolver does", () => {
    for (const spelling of ["Service", "SERVICE", "  service  ", "\tService\n"]) {
      expect({ spelling, route: workflowRouteForProjectType(spelling) })
        .toEqual({ spelling, route: "service" });
    }
  });

  it("treats an absent or unrecognised type as normal, never as service", () => {
    // Falling OPEN to service here would silently re-route every untyped deal into the service pipeline.
    for (const value of [null, undefined, "", "   ", "not a real type", "servicing", "self-service"]) {
      expect({ value, route: workflowRouteForProjectType(value) })
        .toEqual({ value, route: "normal" });
    }
  });

  it("agrees with resolveProjectTypeCode for every configured type", () => {
    // The assertion is AGREEMENT with the canonical resolver, not a second hardcoded table. If the code
    // map changes, this fails here instead of quietly routing deals by a stale copy of it.
    for (const option of PROJECT_TYPE_OPTIONS) {
      const expected = resolveProjectTypeCode({ projectType: option.value }) === "4" ? "service" : "normal";
      expect({ type: option.value, route: workflowRouteForProjectType(option.value) })
        .toEqual({ type: option.value, route: expected });
    }
  });
});
