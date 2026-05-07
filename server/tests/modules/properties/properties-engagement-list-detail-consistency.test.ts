import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildPropertyEngagementStatus,
  classifyPropertyEngagementStatus,
} from "../../../src/modules/properties/service.js";

describe("properties engagement list/detail consistency", () => {
  it("matches detail classification when inactive deals are also attached", () => {
    const fixture = {
      leads: [],
      deals: [
        { isActive: true, sourceLeadId: "converted-lead-id" },
        { isActive: false, sourceLeadId: null },
      ],
    };

    const detailStatus = buildPropertyEngagementStatus(fixture);
    const listStatus = classifyPropertyEngagementStatus({
      dealCount: fixture.deals.filter((deal) => deal.isActive).length,
      leadCount: fixture.leads.filter((lead) => lead.isActive).length,
      convertedDealCount: fixture.deals.filter((deal) => Boolean(deal.sourceLeadId)).length,
    });

    expect(listStatus).toBe("won");
    expect(listStatus).toBe(detailStatus);
  });

  it("keeps list count queries aligned to active deal and lead predicates", () => {
    const serviceSource = readFileSync(
      resolve(process.cwd(), "src/modules/properties/service.ts"),
      "utf8"
    );

    expect(serviceSource).toContain(
      ".where(and(inArray(leads.propertyId, propertyIds), eq(leads.isActive, true)))"
    );
    expect(serviceSource).toContain(
      ".where(and(inArray(deals.propertyId, propertyIds), eq(deals.isActive, true)))"
    );
  });
});
