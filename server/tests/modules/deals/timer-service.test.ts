import { describe, expect, it, vi } from "vitest";
import { createStageTimers } from "../../../src/modules/deals/timer-service.js";

function createTenantDb() {
  const inserts: Array<Record<string, unknown>> = [];

  return {
    inserts,
    insert() {
      return {
        values: vi.fn(async (value: Record<string, unknown>) => {
          inserts.push(value);
          return [value];
        }),
      };
    },
  };
}

describe("createStageTimers", () => {
  it("creates estimate review timers for canonical estimating boundary stages", async () => {
    const tenantDb = createTenantDb();

    await createStageTimers(tenantDb as never, "deal-1", "estimate_in_progress", "user-1");
    await createStageTimers(tenantDb as never, "deal-2", "service_estimating", "user-2");

    expect(tenantDb.inserts).toHaveLength(2);
    expect(tenantDb.inserts[0]).toMatchObject({
      dealId: "deal-1",
      timerType: "estimate_review",
      label: "Estimate Review Due",
      createdBy: "user-1",
    });
    expect(tenantDb.inserts[1]).toMatchObject({
      dealId: "deal-2",
      timerType: "estimate_review",
      label: "Estimate Review Due",
      createdBy: "user-2",
    });
  });

  it("creates proposal response timers for canonical proposal-sent stages", async () => {
    const tenantDb = createTenantDb();

    await createStageTimers(tenantDb as never, "deal-1", "estimate_sent_to_client", "user-1");

    expect(tenantDb.inserts).toHaveLength(1);
    expect(tenantDb.inserts[0]).toMatchObject({
      dealId: "deal-1",
      timerType: "proposal_response",
      label: "Proposal Response Due",
      createdBy: "user-1",
    });
  });
});
