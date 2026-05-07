import { describe, expect, it } from "vitest";
import { buildPropertyLastActivityAt } from "../../../src/modules/properties/service.js";

describe("property lastActivityAt derivation", () => {
  it("uses newer deal-linked activity instead of stale persisted property activity", () => {
    const directPropertyActivity = "2026-05-01T12:00:00.000Z";
    const dealLinkedActivity = "2026-05-07T12:00:00.000Z";

    expect(buildPropertyLastActivityAt({
      persistedLastActivityAt: directPropertyActivity,
      leadActivityAt: null,
      dealActivityAt: dealLinkedActivity,
    })).toBe(dealLinkedActivity);
  });
});
