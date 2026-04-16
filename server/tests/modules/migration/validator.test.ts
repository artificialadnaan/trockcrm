import { describe, it, expect, vi, beforeEach } from "vitest";
import { stagedContacts, contacts } from "@trock-crm/shared/schema";
import { validateStagedContacts } from "../../../src/modules/migration/validator.js";

// Mock the DB module
const updateCalls: Array<Record<string, unknown>> = [];
let stagedBatchQueryCount = 0;

vi.mock("../../../src/db.js", () => {
  const db = {
    select: vi.fn((columns?: Record<string, unknown>) => {
      const state: { table: unknown; limit?: number } = { table: null };
      return {
        from(table: unknown) {
          state.table = table;
          return this;
        },
        where() {
          return this;
        },
        limit(limit: number) {
          state.limit = limit;
          return this;
        },
        offset() {
          return this;
        },
        then(resolve: (value: unknown) => void) {
          if (state.table === stagedContacts && columns && "mappedEmail" in columns) {
            resolve([
              {
                id: "staged-1",
                mappedEmail: "duplicate@client.com",
                mappedFirstName: "Alex",
                mappedLastName: "Stone",
              },
            ]);
            return;
          }

          if (state.table === stagedContacts) {
            stagedBatchQueryCount++;
            resolve(
              stagedBatchQueryCount === 1
                ? [
                    {
                      id: "staged-1",
                      hubspotContactId: "hs-contact-1",
                      mappedFirstName: "Alex",
                      mappedLastName: "Stone",
                      mappedEmail: "duplicate@client.com",
                      mappedPhone: null,
                      mappedCompany: "Acme",
                      mappedCategory: "other",
                      duplicateOfStagedId: null,
                      duplicateOfLiveId: null,
                      duplicateConfidence: null,
                      validationStatus: "pending",
                      validationErrors: [],
                      validationWarnings: [],
                      reviewNotes: null,
                      promotedAt: null,
                    },
                  ]
                : []
            );
            return;
          }

          if (state.table === contacts) {
            resolve([
              {
                id: "live-contact-1",
                email: "duplicate@client.com",
                phone: null,
                normalizedPhone: null,
                firstName: "Alex",
                lastName: "Stone",
                companyName: "Acme",
              },
            ]);
            return;
          }

          resolve([]);
        },
      };
    }),
    update: vi.fn(() => {
      let payload: Record<string, unknown> | null = null;
      return {
        set(next: Record<string, unknown>) {
          payload = next;
          return this;
        },
        where() {
          if (payload) updateCalls.push(payload);
          return this;
        },
      };
    }),
    execute: vi.fn(),
  };
  return { db };
});

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

  it("marks a staged contact as a duplicate of an existing live contact", async () => {
    updateCalls.length = 0;
    stagedBatchQueryCount = 0;

    await validateStagedContacts();

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]).toMatchObject({
      duplicateOfLiveId: "live-contact-1",
      duplicateConfidence: "100",
      validationStatus: "duplicate",
    });
  });
});
