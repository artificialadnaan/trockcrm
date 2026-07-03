import { describe, expect, it } from "vitest";
import { resolveCommissionRecomputeScope } from "../../../src/modules/admin/users-service.js";

// Gate logic for the settings-change cross-office recompute (which roles fan out, and whether at all).
describe("resolveCommissionRecomputeScope", () => {
  it("no change → no recompute", () => {
    expect(
      resolveCommissionRecomputeScope({ capxChanged: false, serviceSourceChanged: false, reactivated: false })
    ).toEqual({ commissionRatesChanged: false, affectedRoles: undefined });
  });

  it("capX change → owner + estimator only", () => {
    expect(
      resolveCommissionRecomputeScope({ capxChanged: true, serviceSourceChanged: false, reactivated: false })
    ).toEqual({ commissionRatesChanged: true, affectedRoles: ["owner", "estimator"] });
  });

  it("service-source change → sales_source only", () => {
    expect(
      resolveCommissionRecomputeScope({ capxChanged: false, serviceSourceChanged: true, reactivated: false })
    ).toEqual({ commissionRatesChanged: true, affectedRoles: ["sales_source"] });
  });

  it("both rate changes → all three roles", () => {
    expect(
      resolveCommissionRecomputeScope({ capxChanged: true, serviceSourceChanged: true, reactivated: false })
    ).toEqual({ commissionRatesChanged: true, affectedRoles: ["owner", "estimator", "sales_source"] });
  });

  // Finding G: a reactivation (inactive → active) with UNCHANGED rates must still recompute so the
  // sales-source discovery mints rows for deals signed while the rep was inactive.
  it("reactivation with no rate change → sales_source recompute runs", () => {
    expect(
      resolveCommissionRecomputeScope({ capxChanged: false, serviceSourceChanged: false, reactivated: true })
    ).toEqual({ commissionRatesChanged: true, affectedRoles: ["sales_source"] });
  });

  it("reactivation is deliberately sales_source-only, not owner/estimator (backfill-only convention)", () => {
    const scope = resolveCommissionRecomputeScope({
      capxChanged: false,
      serviceSourceChanged: false,
      reactivated: true,
    });
    expect(scope.affectedRoles).not.toContain("owner");
    expect(scope.affectedRoles).not.toContain("estimator");
  });

  it("reactivation alongside a capX change → owner + estimator + sales_source", () => {
    expect(
      resolveCommissionRecomputeScope({ capxChanged: true, serviceSourceChanged: false, reactivated: true })
    ).toEqual({ commissionRatesChanged: true, affectedRoles: ["owner", "estimator", "sales_source"] });
  });
});
