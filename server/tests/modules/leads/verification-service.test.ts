import { describe, expect, it, vi } from "vitest";
import { companyNeedsVerification } from "../../../src/modules/leads/verification-service.js";

const NOW = new Date("2026-04-27T12:00:00.000Z");
const SECONDS_PER_DAY = 86_400_000;

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * SECONDS_PER_DAY);
}

function execMock(maxTimestamp: Date | null) {
  return vi.fn(async () => ({
    rows: [{ last_activity_at: maxTimestamp }],
  }));
}

describe("companyNeedsVerification", () => {
  it("returns new_company when the company has zero historical activity", async () => {
    const tenantDb = { execute: execMock(null) };

    const decision = await companyNeedsVerification(tenantDb as never, "company-1", { now: NOW });

    expect(decision).toEqual({
      needsVerification: true,
      reason: "new_company",
      lastActivityAt: null,
    });
    expect(tenantDb.execute).toHaveBeenCalledTimes(1);
  });

  it("returns active_company when last activity was 30 days ago", async () => {
    const last = daysAgo(30);
    const tenantDb = { execute: execMock(last) };

    const decision = await companyNeedsVerification(tenantDb as never, "company-1", { now: NOW });

    expect(decision).toEqual({
      needsVerification: false,
      reason: "active_company",
      lastActivityAt: last,
    });
  });

  it("returns dormant_company when last activity was 400 days ago", async () => {
    const last = daysAgo(400);
    const tenantDb = { execute: execMock(last) };

    const decision = await companyNeedsVerification(tenantDb as never, "company-1", { now: NOW });

    expect(decision).toEqual({
      needsVerification: true,
      reason: "dormant_company",
      lastActivityAt: last,
    });
  });

  it("treats exactly 365 days ago as still active (boundary inclusive)", async () => {
    const last = daysAgo(365);
    const tenantDb = { execute: execMock(last) };

    const decision = await companyNeedsVerification(tenantDb as never, "company-1", { now: NOW });

    expect(decision.reason).toBe("active_company");
    expect(decision.needsVerification).toBe(false);
  });

  it("issues a single round-trip query that unions every activity source", async () => {
    const tenantDb = { execute: execMock(null) };

    await companyNeedsVerification(tenantDb as never, "company-1", { now: NOW });

    expect(tenantDb.execute).toHaveBeenCalledTimes(1);
    const queryArg = tenantDb.execute.mock.calls[0][0] as unknown;
    const queryText = JSON.stringify(
      (queryArg as { queryChunks?: unknown[] })?.queryChunks ?? queryArg
    );
    expect(queryText).toContain("FROM leads");
    expect(queryText).toContain("FROM deals");
    expect(queryText).toContain("FROM contacts");
    expect(queryText).toContain("FROM activities");
    expect(queryText).toContain("FROM emails");
    // Must read created_at + last_activity_at, NOT updated_at, on leads/deals.
    // updated_at is touched by Procore/HubSpot sync and would falsely keep
    // dormant companies looking active.
    expect(queryText).toContain("last_activity_at");
    expect(queryText).not.toMatch(/updated_at/);
  });

  it("excludes the lead being created from the activity scan", async () => {
    const tenantDb = { execute: execMock(null) };

    await companyNeedsVerification(tenantDb as never, "company-1", {
      now: NOW,
      excludeLeadId: "lead-just-created",
    });

    const queryArg = tenantDb.execute.mock.calls[0][0] as unknown;
    const queryText = JSON.stringify(
      (queryArg as { queryChunks?: unknown[] })?.queryChunks ?? queryArg
    );
    expect(queryText).toContain("id <>");
  });

  it("captures emails routed to a company without a contact via assigned_entity_type='company'", async () => {
    // Regression guard: the emails subquery must UNION two paths — the
    // contact-joined path AND the assigned_entity_type='company' path.
    // Without the latter, generic info@ / system mail tied directly to the
    // company would silently drop, falsely marking the company as no-activity.
    const tenantDb = { execute: execMock(null) };

    await companyNeedsVerification(tenantDb as never, "company-1", { now: NOW });

    const queryArg = tenantDb.execute.mock.calls[0][0] as unknown;
    const queryText = JSON.stringify(
      (queryArg as { queryChunks?: unknown[] })?.queryChunks ?? queryArg
    );
    expect(queryText).toContain("assigned_entity_type");
    expect(queryText).toContain("'company'");
    expect(queryText).toContain("UNION ALL");
  });

  it("returns new_company defensively when tenantDb has no execute (mocked stubs)", async () => {
    const decision = await companyNeedsVerification({} as never, "company-1", { now: NOW });

    expect(decision).toEqual({
      needsVerification: true,
      reason: "new_company",
      lastActivityAt: null,
    });
  });
});
