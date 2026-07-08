import { describe, expect, it, vi } from "vitest";

import { deleteCompany } from "../../src/modules/companies/service.js";
import { deleteProperty } from "../../src/modules/properties/service.js";
import { createLeadService } from "../../src/modules/leads/service.js";

function updateDb(returningRows: unknown[]) {
  const calls: Array<Record<string, unknown>> = [];
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        leftJoin: vi.fn(function leftJoin() {
          return this;
        }),
        where: vi.fn(() => ({
          limit: vi.fn(async () => returningRows),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        calls.push(values);
        return {
          where: vi.fn(() => ({
            returning: vi.fn(async () => returningRows),
          })),
        };
      }),
    })),
  };
  return { db, calls };
}

describe("delete policy services", () => {
  // NOTE: deal archiving is no longer admin-only — reps can archive opportunity-stage deals they own.
  // The full archive policy (reason required, rep→opportunity 403, admin any-stage) is covered by
  // tests/modules/deals/archive-deal.runtime.test.ts. Leads remain admin-only (below).

  it("rejects non-admin lead deletes before touching the database", async () => {
    const service = createLeadService();

    await expect(service.deleteLead({} as never, "lead-1", "rep", "rep-1")).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it("soft-deletes active companies and returns null for already inactive companies", async () => {
    const active = updateDb([{ id: "company-1", isActive: true }]);
    await expect(deleteCompany(active.db as never, "company-1")).resolves.toEqual(
      expect.objectContaining({ id: "company-1" })
    );
    expect(active.calls[0]).toMatchObject({ isActive: false });

    const inactive = updateDb([{ id: "company-1", isActive: false }]);
    await expect(deleteCompany(inactive.db as never, "company-1")).resolves.toBeNull();
    expect(inactive.db.update).not.toHaveBeenCalled();
  });

  it("soft-deletes active properties and returns null for already inactive properties", async () => {
    const active = updateDb([{ id: "property-1", isActive: true }]);
    await expect(deleteProperty(active.db as never, "property-1")).resolves.toEqual(
      expect.objectContaining({ id: "property-1" })
    );
    expect(active.calls[0]).toMatchObject({ isActive: false });

    const inactive = updateDb([{ id: "property-1", isActive: false }]);
    await expect(deleteProperty(inactive.db as never, "property-1")).resolves.toBeNull();
    expect(inactive.db.update).not.toHaveBeenCalled();
  });
});
