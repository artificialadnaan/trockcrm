import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const serviceSource = readFileSync(resolve(__dirname, "../../../src/modules/properties/service.ts"), "utf8");

describe("property detail metadata contract", () => {
  it("selects redesign property metadata in detail responses", () => {
    expect(serviceSource).toContain("propertyType: properties.propertyType");
    expect(serviceSource).toContain("lat: properties.lat");
    expect(serviceSource).toContain("lng: properties.lng");
    expect(serviceSource).toContain("procorePropertyId: properties.procorePropertyId");
    expect(serviceSource).toContain("companycamProjectId: properties.companycamProjectId");
    expect(serviceSource).toContain("hubspotPropertyId: properties.hubspotPropertyId");
  });
});
