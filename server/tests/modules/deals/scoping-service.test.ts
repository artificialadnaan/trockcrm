import { describe, expect, it } from "vitest";
import { DEAL_SCOPING_INTAKE_STATUSES, WORKFLOW_ROUTES } from "@trock-crm/shared/types";

describe("Scoping Service Shared Contract", () => {
  it("defines workflow routes and intake statuses", () => {
    expect(WORKFLOW_ROUTES).toEqual(["estimating", "service"]);
    expect(DEAL_SCOPING_INTAKE_STATUSES).toEqual(["draft", "ready", "activated"]);
  });
});
