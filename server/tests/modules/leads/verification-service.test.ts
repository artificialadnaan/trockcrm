import { describe, expect, it, vi } from "vitest";
import { isExistingCustomer } from "../../../src/modules/leads/verification-service.js";

const NOW = new Date("2026-04-27T12:00:00.000Z");

function queryTextFromExecuteMock(execute: ReturnType<typeof vi.fn>) {
  const queryArg = execute.mock.calls[0][0] as unknown;
  return JSON.stringify((queryArg as { queryChunks?: unknown[] })?.queryChunks ?? queryArg);
}

describe("isExistingCustomer", () => {
  it("returns isExisting=false when no signals match", async () => {
    const tenantDb = { execute: vi.fn(async () => ({ rows: [] })) };

    const decision = await isExistingCustomer(
      tenantDb as never,
      "company-1",
      "contact-1",
      "property-1",
      NOW
    );

    expect(decision).toEqual({ isExisting: false, signal: null });
    expect(tenantDb.execute).toHaveBeenCalledTimes(1);
  });

  it("returns a company lead signal", async () => {
    const occurredAt = new Date("2026-04-01T00:00:00.000Z");
    const tenantDb = {
      execute: vi.fn(async () => ({
        rows: [{
          source: "company",
          type: "lead",
          occurred_at: occurredAt,
          detail: "Recent lead activity on company",
        }],
      })),
    };

    const decision = await isExistingCustomer(
      tenantDb as never,
      "company-1",
      "contact-1",
      "property-1",
      NOW
    );

    expect(decision.isExisting).toBe(true);
    expect(decision.signal).toEqual({
      source: "company",
      type: "lead",
      occurredAt,
      detail: "Recent lead activity on company",
    });
  });

  it("returns a contact lead signal without treating contact creation as activity", async () => {
    const tenantDb = {
      execute: vi.fn(async () => ({
        rows: [{
          source: "contact",
          type: "lead",
          occurred_at: "2026-04-02T00:00:00.000Z",
          detail: "Recent lead activity on primary contact",
        }],
      })),
    };

    const decision = await isExistingCustomer(
      tenantDb as never,
      "company-1",
      "contact-1",
      "property-1",
      NOW
    );

    expect(decision.isExisting).toBe(true);
    expect(decision.signal?.source).toBe("contact");
    expect(decision.signal?.type).toBe("lead");
    const queryText = queryTextFromExecuteMock(tenantDb.execute);
    expect(queryText).not.toContain("Primary contact was created recently");
    expect(queryText).not.toContain("SELECT 'contact', 'contact'");
  });

  it("returns a property deal signal", async () => {
    const occurredAt = new Date("2026-04-03T00:00:00.000Z");
    const tenantDb = {
      execute: vi.fn(async () => ({
        rows: [{
          source: "property",
          type: "deal",
          occurred_at: occurredAt,
          detail: "Recent deal activity on property",
        }],
      })),
    };

    const decision = await isExistingCustomer(
      tenantDb as never,
      "company-1",
      "contact-1",
      "property-1",
      NOW
    );

    expect(decision.isExisting).toBe(true);
    expect(decision.signal?.source).toBe("property");
    expect(decision.signal?.type).toBe("deal");
  });

  it("uses SQL INTERVAL '12 months' for the activity window", async () => {
    const tenantDb = { execute: vi.fn(async () => ({ rows: [] })) };

    await isExistingCustomer(tenantDb as never, "company-1", "contact-1", "property-1", NOW);

    const queryText = queryTextFromExecuteMock(tenantDb.execute);
    // This mocked-query assertion is a stand-in until the project has a
    // lightweight real-DB tenant fixture for boundary-date verification.
    expect(queryText).toContain("INTERVAL '12 months'");
    expect(queryText).toContain("cutoff_at");
    expect(queryText).toContain("occurred_at >= cutoff.cutoff_at");
  });

  it("includes the excludeLeadId predicate for lead-sourced signals", async () => {
    const tenantDb = { execute: vi.fn(async () => ({ rows: [] })) };

    await isExistingCustomer(tenantDb as never, "company-1", "contact-1", "property-1", NOW, {
      excludeLeadId: "lead-just-created",
    });

    const queryText = queryTextFromExecuteMock(tenantDb.execute);
    expect(queryText).toContain("l.id <>");
  });

  it("guards contact and property predicates when ids are null", async () => {
    const tenantDb = { execute: vi.fn(async () => ({ rows: [] })) };

    await expect(
      isExistingCustomer(tenantDb as never, "company-1", null, null, NOW)
    ).resolves.toEqual({ isExisting: false, signal: null });

    const queryText = queryTextFromExecuteMock(tenantDb.execute);
    expect(queryText).toContain("::uuid IS NOT NULL");
    expect(queryText).toContain("primary contact");
    expect(queryText).toContain("property");
  });

  it("orders same-timestamp ties deterministically in SQL", async () => {
    const tenantDb = {
      execute: vi.fn(async () => ({
        rows: [{
          source: "company",
          type: "activity",
          occurred_at: "2026-04-01T00:00:00.000Z",
          detail: "Recent activity on company",
        }],
      })),
    };

    await isExistingCustomer(tenantDb as never, "company-1", "contact-1", "property-1", NOW);

    const queryText = queryTextFromExecuteMock(tenantDb.execute);
    // The mocked execute returns the database's first row; this assertion
    // guards the SQL ordering until real-DB tie fixtures are available.
    expect(queryText).toContain("ORDER BY occurred_at DESC, source ASC, type ASC");
  });

  it("returns isExisting=false defensively when tenantDb has no execute", async () => {
    const decision = await isExistingCustomer({} as never, "company-1", "contact-1", "property-1", NOW);

    expect(decision).toEqual({ isExisting: false, signal: null });
  });
});
