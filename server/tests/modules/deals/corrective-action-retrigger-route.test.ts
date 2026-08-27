import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(import.meta.dirname, "../../../src/modules/deals/routes.ts"),
  "utf8",
);
const routeStart = source.indexOf('router.post(\n  "/:id/scorecards/:scorecardId/corrective-actions/retrigger"');
const routeSource = source.slice(routeStart, routeStart + 4_500);

describe("corrective-action email retrigger route contract", () => {
  it("uses the director-only nested deal route with UUID and deal-access guards", () => {
    expect(routeStart).toBeGreaterThan(-1);
    expect(routeSource).toContain("requireDirector");
    expect(routeSource).toContain('assertValidUuid(dealId, "dealId")');
    expect(routeSource).toContain('assertValidUuid(scorecardId, "scorecardId")');
    expect(routeSource).toContain("await assertDealRouteAccess(req, dealId)");
    expect(routeSource.indexOf('assertValidUuid(dealId, "dealId")')).toBeLessThan(
      routeSource.indexOf("await assertDealRouteAccess(req, dealId)"),
    );
  });

  it("distinguishes a newly queued repair from an existing current-cycle job and audits only the enqueue", () => {
    expect(routeSource).toContain("retriggerCorrectiveActionNotification");
    expect(routeSource).toContain("if (result.queued)");
    expect(routeSource).toContain('operation: "corrective_action_email_retriggered"');
    expect(routeSource).toContain("priorCycleNonce: result.priorCycleNonce");
    expect(routeSource).toContain("newCycleNonce: result.newCycleNonce");
    expect(routeSource).toContain("res.status(result.queued ? 202 : 200)");
    expect(routeSource).toContain("alreadyQueued: result.alreadyQueued");
  });
});
