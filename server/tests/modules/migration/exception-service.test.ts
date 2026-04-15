import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  select: vi.fn(),
  from: vi.fn(),
  where: vi.fn(),
  limit: vi.fn(),
  offset: vi.fn(),
  update: vi.fn(),
  set: vi.fn(),
  execute: vi.fn(),
}));

vi.mock("../../../src/db.js", () => ({
  db: dbMock,
}));

import {
  assertNoUnresolvedMigrationBucket,
  classifyActivityException,
  classifyCompanyException,
  classifyContactException,
  classifyLeadException,
  classifyOwnerAssignmentException,
  classifyPropertyException,
} from "../../../src/modules/migration/exception-service.js";
import { getMigrationSummary } from "../../../src/modules/migration/service.js";

describe("migration exception classifiers", () => {
  it("flags an unknown company when both name and domain are missing", () => {
    const result = classifyCompanyException({ mappedName: null, mappedDomain: null });
    expect(result?.bucket).toBe("unknown_company");
  });

  it("flags an ambiguous property when more than one company candidate exists", () => {
    const result = classifyPropertyException({
      mappedName: "Main Office",
      mappedCompanyName: "Acme",
      candidateCompanyCount: 2,
    });
    expect(result?.bucket).toBe("ambiguous_property");
  });

  it("flags an ambiguous contact when there is no unique identity", () => {
    const result = classifyContactException({
      mappedEmail: null,
      mappedPhone: null,
      duplicateOfStagedId: null,
      duplicateOfLiveId: null,
      candidateContactCount: 2,
    });
    expect(result?.bucket).toBe("ambiguous_contact");
  });

  it("flags lead-versus-deal conflict when multiple successor targets exist", () => {
    const result = classifyLeadException({
      mappedName: "New Lead",
      mappedOwnerEmail: "rep@trock.com",
      mappedCompanyName: "Acme",
      mappedPropertyName: "Site A",
      mappedDealName: "Future Deal",
      candidateDealCount: 2,
      candidatePropertyCount: 1,
    });
    expect(result?.bucket).toBe("lead_vs_deal_conflict");
  });

  it("flags ambiguous activity attribution when the activity cannot be uniquely assigned", () => {
    const result = classifyActivityException({
      hubspotDealId: null,
      hubspotContactId: null,
      candidateCount: 2,
    });
    expect(result?.bucket).toBe("ambiguous_email_activity_attribution");
  });

  it("flags missing owner assignment when no owner is resolved", () => {
    const result = classifyOwnerAssignmentException({
      mappedOwnerEmail: null,
      mappedOwnerId: null,
    });
    expect(result?.bucket).toBe("missing_owner_assignment");
  });
});

describe("migration promotion guards", () => {
  it("blocks unresolved records from promotion", () => {
    expect(() =>
      assertNoUnresolvedMigrationBucket({
        entityType: "lead",
        validationStatus: "approved",
        exceptionBucket: "lead_vs_deal_conflict",
        exceptionReason: "Lead points at conflicting deal/property matches.",
      })
    ).toThrow(/lead vs deal conflict/i);
  });

  it("allows clean approved records through promotion", () => {
    expect(() =>
      assertNoUnresolvedMigrationBucket({
        entityType: "company",
        validationStatus: "approved",
        exceptionBucket: null,
        exceptionReason: null,
      })
    ).not.toThrow();
  });
});

describe("migration summary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns company, property, and lead validation counts alongside the legacy summary cards", async () => {
    dbMock.execute
      .mockResolvedValueOnce({ rows: [{ validation_status: "valid", count: 4 }] })
      .mockResolvedValueOnce({ rows: [{ validation_status: "valid", count: 6 }] })
      .mockResolvedValueOnce({ rows: [{ validation_status: "invalid", count: 5 }] })
      .mockResolvedValueOnce({ rows: [{ validation_status: "valid", count: 4 }] })
      .mockResolvedValueOnce({ rows: [{ validation_status: "needs_review", count: 3 }] })
      .mockResolvedValueOnce({ rows: [{ validation_status: "invalid", count: 2 }] });

    dbMock.select.mockImplementation(() => ({
      from: vi.fn().mockReturnValue({
        orderBy: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([
            {
              id: "run-1",
              type: "validate",
              status: "completed",
              stats: {},
              errorLog: null,
              startedAt: new Date("2026-04-15T12:00:00.000Z"),
              completedAt: new Date("2026-04-15T12:05:00.000Z"),
            },
          ]),
        }),
      }),
    }));

    const summary = await getMigrationSummary();

    expect(summary.companies).toEqual({ valid: 4 });
    expect(summary.properties).toEqual({ needs_review: 3 });
    expect(summary.leads).toEqual({ invalid: 2 });
    expect(summary.deals).toEqual({ valid: 4 });
    expect(summary.contacts).toEqual({ valid: 6 });
    expect(summary.activities).toEqual({ invalid: 5 });
    expect(summary.recentRuns).toHaveLength(1);
  });
});
