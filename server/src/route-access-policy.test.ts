import { describe, expect, it } from "vitest";
import { PUBLIC_ROUTE_MOUNTS } from "./route-access-policy.js";

describe("route access policy", () => {
  it("treats the SyncHub Procore relay as a public signed integration route", () => {
    expect(PUBLIC_ROUTE_MOUNTS).toContain("/api/webhooks/synchub");
  });

  it("documents internal SyncHub RFP relay routes as public signed integration routes", () => {
    expect(PUBLIC_ROUTE_MOUNTS).toContain("/api/internal");
  });
});
