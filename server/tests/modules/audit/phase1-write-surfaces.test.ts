import { beforeEach, describe, expect, it, vi } from "vitest";
import { companies, deals, files, leads } from "@trock-crm/shared/schema";
import { createLeadConversionService } from "../../../src/modules/leads/conversion-service.js";
import { PHASE_1_AUDIT_WRITE_SURFACES } from "../../../src/modules/audit/phase1-write-surface-registry.js";

const pipelineMocks = vi.hoisted(() => ({
  getStageById: vi.fn(),
  getStageBySlug: vi.fn(),
}));

vi.mock("../../../src/modules/pipeline/service.js", () => ({
  getStageById: pipelineMocks.getStageById,
  getStageBySlug: pipelineMocks.getStageBySlug,
}));

describe("Phase 1 audit write surfaces", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pipelineMocks.getStageById.mockResolvedValue({
      id: "lead-stage-sales-validation",
      name: "Sales Validation",
      slug: "sales_validation",
      isTerminal: false,
      displayOrder: 3,
    });
    pipelineMocks.getStageBySlug.mockResolvedValue({
      id: "deal-stage-opportunity",
      name: "Opportunity",
      slug: "opportunity",
      isTerminal: false,
      displayOrder: 1,
    });
  });

  it("keeps the Phase 1 lead/deal write coverage registry explicit", () => {
    expect(PHASE_1_AUDIT_WRITE_SURFACES).toEqual([
      "lead.create",
      "lead.update",
      "lead.convert",
      "lead.soft_delete",
      "deal.create",
      "deal.update",
      "deal.stage_transition",
      "deal.proposal_draft",
      "deal.contract_signed_date",
      "deal.soft_delete",
    ]);
  });

  it("writes a rich audit_log entry for lead conversion when audit context is present", async () => {
    const auditRows: Array<Record<string, unknown>> = [];
    const state = {
      leads: [
        {
          id: "lead-1",
          companyId: "company-1",
          propertyId: "property-1",
          primaryContactId: "contact-1",
          name: "Palm Villas Repaint",
          stageId: "lead-stage-sales-validation",
          assignedRepId: "rep-1",
          salesRepId: null,
          status: "open",
          source: "Referral",
          description: null,
          officeCode: "dfw",
          projectType: "multifamily",
          projectTypeId: "project-type-multifamily",
          preQualValue: 150000,
          pipelineType: "normal",
          isActive: true,
          createdAt: new Date("2026-04-01T00:00:00.000Z"),
          updatedAt: new Date("2026-04-01T00:00:00.000Z"),
          stageEnteredAt: new Date("2026-04-01T00:00:00.000Z"),
          convertedAt: null,
        },
      ],
      deals: [] as Array<Record<string, unknown>>,
      companies: [{ id: "company-1", name: "Palm Villas" }],
      files: [] as Array<Record<string, unknown>>,
    };

    const tenantDb: any = {
      select() {
        return {
          from(table: unknown) {
            const name = String(
              (table as { _?: { name?: string } })?._?.name
              ?? (table as Record<PropertyKey, unknown> | undefined)?.[Symbol.for("drizzle:Name")]
              ?? ""
            );
            const rows =
              table === leads || name === "leads"
                ? state.leads
                : table === deals || name === "deals"
                  ? state.deals
                  : table === companies || name === "companies"
                    ? state.companies
                    : table === files || name === "files"
                      ? state.files
                    : [];
            return {
              where() {
                const chain = {
                  limit() {
                    return Promise.resolve(rows.slice(0, 1));
                  },
                  for() {
                    return {
                      limit() {
                        return Promise.resolve(rows.slice(0, 1));
                      },
                    };
                  },
                  then(resolve: (value: typeof rows) => unknown, reject?: (reason: unknown) => unknown) {
                    return Promise.resolve(rows).then(resolve, reject);
                  },
                };
                return chain;
              },
            };
          },
        };
      },
      update(table: unknown) {
        return {
          set(values: Record<string, unknown>) {
            return {
              where() {
                if (table === leads) {
                  state.leads[0] = { ...state.leads[0], ...values };
                  return {
                    returning() {
                      return Promise.resolve([state.leads[0]]);
                    },
                  };
                }
                throw new Error("Unexpected update table");
              },
            };
          },
        };
      },
      insert() {
        return {
          values(value: Record<string, unknown>) {
            auditRows.push(value);
            return Promise.resolve([]);
          },
        };
      },
    };

    const createDealMock = vi.fn(async (_tenantDb: unknown, input: Record<string, unknown>) => ({
      id: "deal-1",
      name: input.name,
      dealNumber: "DFW-1-12345-AA",
      projectNumber: "DFW-1-12345-AA",
    }));

    const service = createLeadConversionService({
      createDeal: createDealMock as never,
      getStageById: pipelineMocks.getStageById as never,
      getStageBySlug: pipelineMocks.getStageBySlug as never,
      now: () => new Date("2026-04-15T15:00:00.000Z"),
    });

    await service.convertLead(tenantDb, {
      leadId: "lead-1",
      userId: "director-1",
      userRole: "director",
      officeId: "office-1",
      auditContext: {
        actor: {
          type: "user",
          userId: "director-1",
          name: "Director User",
          role: "director",
        },
      },
    });

    expect(createDealMock).toHaveBeenCalledWith(
      tenantDb,
      expect.objectContaining({
        sourceLeadId: "lead-1",
        auditContext: expect.objectContaining({
          actor: expect.objectContaining({ name: "Director User" }),
        }),
      })
    );
    expect(auditRows).toEqual([
      expect.objectContaining({
        tableName: "leads",
        recordId: "lead-1",
        action: "update",
        actorName: "Director User",
        entityNameSnapshot: "Palm Villas Repaint for Palm Villas",
        fieldChangesJsonb: expect.arrayContaining([
          expect.objectContaining({
            key: "status",
            fromDisplay: "Open",
            toDisplay: "Converted",
          }),
        ]),
      }),
    ]);
  });
});
