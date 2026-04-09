import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/modules/deals/scoping-service.js", () => ({
  evaluateDealScopingReadiness: vi.fn(),
}));

const scopingService = await import("../../../src/modules/deals/scoping-service.js");
const { activateServiceHandoff } = await import("../../../src/modules/deals/stage-change.js");

function createTenantDbForServiceHandoff() {
  return {
    select() {
      return {
        from() {
          return {
            where() {
              return {
                limit() {
                  return Promise.resolve([
                    {
                      id: "deal-1",
                      workflowRoute: "service",
                      assignedRepId: "user-1",
                    },
                  ]);
                },
              };
            },
          };
        },
      };
    },
  };
}

describe("Service handoff gating", () => {
  it("blocks service handoff activation until service-routed intake is ready", async () => {
    vi.mocked(scopingService.evaluateDealScopingReadiness).mockResolvedValueOnce({
      status: "draft",
      errors: { sections: { projectOverview: ["propertyName"] }, attachments: {} },
    } as never);

    await expect(
      activateServiceHandoff(createTenantDbForServiceHandoff() as never, {
        dealId: "deal-1",
        userId: "user-1",
        userRole: "director",
      })
    ).rejects.toMatchObject({
      statusCode: 400,
      message: "Scoping intake is incomplete. Complete all required scoping items before activating service handoff.",
    });
  });
});
