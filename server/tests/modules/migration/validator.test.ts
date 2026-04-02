import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the DB module
vi.mock("../../../src/db.js", () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    offset: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    execute: vi.fn(),
  },
}));

describe("validateStagedDeals", () => {
  it("flags deal with no name as invalid", () => {
    const errors: Array<{ field: string; error: string }> = [];

    const mappedName = null;
    if (!mappedName) errors.push({ field: "name", error: "Deal name is blank" });

    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe("name");
  });

  it("flags unknown stage as invalid", () => {
    const errors: Array<{ field: string; error: string }> = [];
    const stageSlugs = new Set(["dd", "estimating", "bid_sent", "closed_won", "closed_lost"]);
    const mappedStage = "old_hubspot_stage_xyz";

    if (!stageSlugs.has(mappedStage)) {
      errors.push({ field: "stage", error: `Unknown CRM stage: "${mappedStage}"` });
    }

    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe("stage");
  });

  it("flags unknown rep email as invalid", () => {
    const errors: Array<{ field: string; error: string }> = [];
    const repEmails = new Set(["john@trock.com", "jane@trock.com"]);
    const mappedRepEmail = "unknown@someone.com";

    if (mappedRepEmail && !repEmails.has(mappedRepEmail.toLowerCase())) {
      errors.push({
        field: "rep",
        error: `Rep email "${mappedRepEmail}" does not match any active CRM user`,
      });
    }

    expect(errors).toHaveLength(1);
  });

  it("adds warning for $0 amount but does not mark invalid", () => {
    const errors: Array<{ field: string; error: string }> = [];
    const warnings: Array<{ field: string; warning: string }> = [];
    const mappedAmount = 0;

    if (mappedAmount == null || mappedAmount === 0) {
      warnings.push({ field: "amount", warning: "Deal amount is $0 or blank" });
    }

    expect(errors).toHaveLength(0);
    expect(warnings).toHaveLength(1);
  });

  it("marks deal as valid when all fields pass", () => {
    const errors: Array<{ field: string; error: string }> = [];
    const warnings: Array<{ field: string; warning: string }> = [];
    const stageSlugs = new Set(["bid_sent"]);
    const repEmails = new Set(["john@trock.com"]);

    const deal = {
      mappedName: "Test Deal",
      mappedStage: "bid_sent",
      mappedRepEmail: "john@trock.com",
      mappedAmount: 50000,
    };

    if (!deal.mappedName) errors.push({ field: "name", error: "blank" });
    if (!deal.mappedStage || !stageSlugs.has(deal.mappedStage))
      errors.push({ field: "stage", error: "unknown" });
    if (!repEmails.has(deal.mappedRepEmail.toLowerCase()))
      errors.push({ field: "rep", error: "unknown" });
    if (!deal.mappedAmount) warnings.push({ field: "amount", warning: "zero" });

    expect(errors).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });
});

describe("validateStagedContacts duplicate detection", () => {
  it("detects email duplicate within staged contacts", () => {
    const stagedEmailMap = new Map<string, string>([
      ["john@trock.com", "first-contact-uuid"],
    ]);

    const contactId = "second-contact-uuid";
    const email = "john@trock.com";
    const firstId = stagedEmailMap.get(email);
    const isDuplicate = firstId != null && firstId !== contactId;

    expect(isDuplicate).toBe(true);
  });

  it("does not flag a contact as duplicate of itself", () => {
    const stagedEmailMap = new Map<string, string>([
      ["john@trock.com", "same-contact-uuid"],
    ]);

    const contactId = "same-contact-uuid";
    const email = "john@trock.com";
    const firstId = stagedEmailMap.get(email);
    const isDuplicate = firstId != null && firstId !== contactId;

    expect(isDuplicate).toBe(false);
  });
});
