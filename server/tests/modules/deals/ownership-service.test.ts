import { describe, expect, it } from "vitest";
import { deriveDealDepartmentOwnership } from "../../../src/modules/deals/ownership-service.js";

describe("deriveDealDepartmentOwnership", () => {
  it("keeps ownership on the source department while a handoff is pending", () => {
    const ownership = deriveDealDepartmentOwnership(
      {
        stageSlug: "estimating",
        pipelineDisposition: "deals",
        workflowRoute: "estimating",
      },
      [
        {
          fromDepartment: "sales",
          toDepartment: "estimating",
          acceptanceStatus: "pending",
          effectiveOwnerUserId: null,
          acceptedAt: null,
          createdAt: new Date("2026-04-21T10:00:00.000Z"),
        },
      ]
    );

    expect(ownership).toMatchObject({
      currentDepartment: "sales",
      acceptanceStatus: "pending",
      pendingDepartment: "estimating",
    });
  });

  it("promotes ownership to the accepted handoff department", () => {
    const ownership = deriveDealDepartmentOwnership(
      {
        stageSlug: "estimating",
        pipelineDisposition: "deals",
        workflowRoute: "estimating",
      },
      [
        {
          fromDepartment: "sales",
          toDepartment: "estimating",
          acceptanceStatus: "accepted",
          effectiveOwnerUserId: "user-2",
          acceptedAt: new Date("2026-04-21T12:00:00.000Z"),
          createdAt: new Date("2026-04-21T10:00:00.000Z"),
        },
      ]
    );

    expect(ownership).toMatchObject({
      currentDepartment: "estimating",
      acceptanceStatus: "accepted",
      effectiveOwnerUserId: "user-2",
      pendingDepartment: null,
    });
  });

  it("falls back to operations ownership for production stages without handoffs", () => {
    const ownership = deriveDealDepartmentOwnership(
      {
        stageSlug: "in_production",
        pipelineDisposition: "deals",
        workflowRoute: "estimating",
      },
      []
    );

    expect(ownership.currentDepartment).toBe("operations");
  });
});
