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
  // tests/modules/deals/archive-deal.runtime.test.ts. Leads use the same owner/admin soft-archive model.

  it("rejects a non-owner lead archive", async () => {
    const lead = updateDb([{
      id: "lead-1",
      name: "Lead One",
      assignedRepId: "rep-1",
      isActive: true,
      description: null,
    }]);
    const service = createLeadService({ now: () => new Date("2026-07-13T12:00:00.000Z") });

    await expect(
      service.deleteLead(lead.db as never, "lead-1", {
        actorRole: "rep",
        actorId: "rep-2",
        reason: "Duplicate",
      })
    ).rejects.toMatchObject({ statusCode: 403, code: "LEAD_ARCHIVE_FORBIDDEN" });
    expect(lead.db.update).not.toHaveBeenCalled();
  });

  it("requires a reason and archives an owned lead with active task cleanup", async () => {
    const service = createLeadService({ now: () => new Date("2026-07-13T12:00:00.000Z") });

    await expect(
      service.deleteLead({} as never, "lead-1", {
        actorRole: "rep",
        actorId: "rep-1",
        reason: "  ",
      })
    ).rejects.toMatchObject({ statusCode: 400, code: "LEAD_ARCHIVE_REASON_REQUIRED" });

    const lead = updateDb([{
      id: "lead-1",
      name: "Lead One",
      assignedRepId: "rep-1",
      isActive: true,
      description: "Original lead notes.",
    }]);
    const archived = await service.deleteLead(lead.db as never, "lead-1", {
      actorRole: "rep",
      actorId: "rep-1",
      reason: "Duplicate request",
    });

    expect(archived).toMatchObject({ id: "lead-1" });
    expect(lead.calls[0]).toMatchObject({
      isActive: false,
      description: "[Archived 2026-07-13 — Duplicate request]\n\nOriginal lead notes.",
    });
    expect(lead.calls[1]).toMatchObject({
      status: "superseded",
      decidedBy: "rep-1",
      decisionReason: "Lead archived: Duplicate request",
    });
    expect(lead.calls[2]).toMatchObject({ status: "dismissed", isOverdue: false });
  });

  it("reconciles pending approvals and tasks on a legacy inactive-open archive", async () => {
    const legacy = updateDb([{
      id: "lead-1",
      name: "Lead One",
      assignedRepId: "rep-1",
      isActive: false,
      status: "open",
      description: "[Archived 2026-01-01 — Legacy archive]",
    }]);
    const service = createLeadService({ now: () => new Date("2026-07-13T12:00:00.000Z") });

    await expect(
      service.deleteLead(legacy.db as never, "lead-1", {
        actorRole: "rep",
        actorId: "rep-1",
        reason: "Retry cleanup",
      }),
    ).resolves.toBeNull();

    expect(legacy.calls).toHaveLength(2);
    expect(legacy.calls[0]).toMatchObject({ status: "superseded" });
    expect(legacy.calls[1]).toMatchObject({ status: "dismissed", isOverdue: false });
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
