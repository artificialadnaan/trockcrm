import { describe, it, expect, vi } from "vitest";

vi.mock("../../../src/db.js", () => {
  const db = {
    select: vi.fn(() => {
      return {
        from() { return this; },
        where() {
          return this;
        },
        limit() {
          return this;
        },
        then(resolve: (value: unknown) => void) {
          resolve([
            {
              validationStatus: "approved",
              exceptionBucket: "ambiguous_deal_association",
            },
          ]);
        },
      };
    }),
    update: vi.fn(() => ({
      set() {
        return this;
      },
      where() {
        return this;
      },
    })),
  };
  return { db };
});

import { approveStagedLead } from "../../../src/modules/migration/service.js";

describe("migration review flow", () => {
  it("blocks lead approval when the lead still has an ambiguous deal association", async () => {
    await expect(approveStagedLead("lead-1", "reviewer-1")).rejects.toThrow(
      /ambiguous deal association/i
    );
  });
});
