import {
  companies,
  deals,
  leadStageHistory,
  leads,
  projectTypeConfig,
  properties,
} from "@trock-crm/shared/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../../../src/middleware/error-handler.js";
import { createLeadService } from "../../../src/modules/leads/service.js";
import { LeadStageTransitionError } from "../../../src/modules/leads/stage-transition-service.js";

const pipelineMocks = vi.hoisted(() => ({
  getStageById: vi.fn(),
  getActiveProjectTypes: vi.fn(),
}));

vi.mock("../../../src/modules/pipeline/service.js", () => ({
  getStageById: pipelineMocks.getStageById,
  getActiveProjectTypes: pipelineMocks.getActiveProjectTypes,
}));

vi.mock("@trock-crm/shared/schema", async () => import("../../../../shared/src/schema/index.js"));
vi.mock("@trock-crm/shared/types", async () => import("../../../../shared/src/types/index.js"));

type FakeLeadRow = {
  id: string;
  companyId: string;
  propertyId: string;
  primaryContactId: string | null;
  name: string;
  stageId: string;
  assignedRepId: string;
  status: "open" | "converted" | "disqualified";
  projectTypeId?: string | null;
  qualificationPayload?: Record<string, string | boolean | number | null>;
  projectTypeQuestionPayload?: {
    projectTypeId: string | null;
    answers: Record<string, string | boolean | number | null>;
  };
  source: string | null;
  description: string | null;
  stageEnteredAt: Date;
  convertedAt: Date | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
};

function createFakeTenantDb(lead: FakeLeadRow) {
  const state = {
    companies: [
      {
        id: "company-1",
        name: "Palm Villas",
      },
    ],
    properties: [
      {
        id: "property-1",
        name: "Palm Villas North",
        address: "123 Palm Way",
        city: "Miami",
        state: "FL",
        zip: "33101",
      },
    ],
    projectTypes: [],
    leads: [lead],
    deals: [],
    leadStageHistory: [] as Array<Record<string, unknown>>,
  };

  const resolveTableName = (table: unknown) => (table as { _: { name?: string } })?._?.name;

  const filterRows = (rows: Array<Record<string, unknown>>, condition: unknown) => {
    const sqlCondition = condition as { queryChunks?: unknown[] } | undefined;
    const queryChunks = sqlCondition?.queryChunks ?? [];
    const column = queryChunks.find(
      (chunk): chunk is { name: string } =>
        Boolean(chunk) && typeof chunk === "object" && typeof (chunk as { name?: unknown }).name === "string"
    );
    const param = queryChunks.find(
      (chunk): chunk is { value: unknown } =>
        Boolean(chunk) && typeof chunk === "object" && "encoder" in (chunk as Record<string, unknown>)
    );

    if (!column || !param) {
      return rows;
    }

    const propertyName = column.name.replace(/_([a-z])/g, (_match, char: string) => char.toUpperCase());
    return rows.filter((row) => row[propertyName] === param.value);
  };

  const createQueryBuilder = (
    rows: Array<Record<string, unknown>>,
    fields?: Record<string, unknown>
  ) => {
    let filteredRows = rows;

    const materialize = () => {
      if (!fields) {
        return filteredRows.map((row) => ({ ...row }));
      }

      return filteredRows.map((row) => {
        const projection: Record<string, unknown> = {};
        for (const [key, field] of Object.entries(fields)) {
          const fieldName = (field as { name?: string }).name;
          if (!fieldName) {
            continue;
          }
          const propertyName = fieldName.replace(/_([a-z])/g, (_match, char: string) => char.toUpperCase());
          projection[key] = row[propertyName];
        }
        return projection;
      });
    };

    return {
      where(condition: unknown) {
        filteredRows = filterRows(rows, condition);
        return this;
      },
      orderBy() {
        return this;
      },
      limit(limit: number) {
        filteredRows = filteredRows.slice(0, limit);
        return this;
      },
      then(onfulfilled: (value: unknown[]) => unknown) {
        return Promise.resolve(materialize()).then(onfulfilled);
      },
    };
  };

  return {
    state,
    select(fields?: Record<string, unknown>) {
      return {
        from(table: unknown) {
          const tableName = resolveTableName(table);

          if (table === leads || tableName === "leads") {
            return createQueryBuilder(state.leads as Array<Record<string, unknown>>, fields);
          }
          if (table === companies || tableName === "companies") {
            return createQueryBuilder(state.companies as Array<Record<string, unknown>>, fields);
          }
          if (table === properties || tableName === "properties") {
            return createQueryBuilder(state.properties as Array<Record<string, unknown>>, fields);
          }
          if (table === projectTypeConfig || tableName === "project_type_config") {
            return createQueryBuilder(state.projectTypes as Array<Record<string, unknown>>, fields);
          }
          if (table === deals || tableName === "deals") {
            return createQueryBuilder(state.deals as Array<Record<string, unknown>>, fields);
          }
          if (table === leadStageHistory || tableName === "lead_stage_history") {
            return createQueryBuilder(state.leadStageHistory, fields);
          }

          throw new Error(`Unexpected table: ${String(tableName)}`);
        },
      };
    },
    insert(table: unknown) {
      return {
        values(value: Record<string, unknown>) {
          const tableName = resolveTableName(table);

          if (table === leadStageHistory || tableName === "lead_stage_history") {
            const insertedRow = {
              id: value.id ?? `lead-stage-history-${state.leadStageHistory.length + 1}`,
              ...value,
            };
            state.leadStageHistory.push(insertedRow);
            return {
              returning() {
                return Promise.resolve([insertedRow]);
              },
              then(onfulfilled: (value: unknown) => unknown) {
                return Promise.resolve(insertedRow).then(onfulfilled);
              },
            };
          }

          throw new Error(`Unexpected insert table: ${String(tableName)}`);
        },
      };
    },
    update(table: unknown) {
      if (table !== leads && resolveTableName(table) !== "leads") {
        throw new Error("Unexpected update table");
      }

      return {
        set(values: Record<string, unknown>) {
          return {
            where(condition: unknown) {
              const rows = filterRows(state.leads as Array<Record<string, unknown>>, condition);
              rows.forEach((row) => Object.assign(row, values));
              return {
                returning() {
                  return Promise.resolve(rows.map((row) => ({ ...row })));
                },
              };
            },
          };
        },
      };
    },
  };
}

const newLeadStage = {
  id: "lead-stage-new",
  name: "New Lead",
  slug: "new_lead",
  displayOrder: 1,
  isTerminal: false,
};

const qualifiedLeadStage = {
  id: "lead-stage-qualified",
  name: "Qualified Lead",
  slug: "qualified_lead",
  displayOrder: 2,
  isTerminal: false,
};

const salesValidationStage = {
  id: "lead-stage-sales-validation",
  name: "Sales Validation",
  slug: "sales_validation",
  displayOrder: 3,
  isTerminal: false,
};

const opportunityStage = {
  id: "lead-stage-opportunity",
  name: "Opportunity",
  slug: "opportunity",
  displayOrder: 4,
  isTerminal: false,
};

const customCurrentStage = {
  id: "lead-stage-custom-current",
  name: "Legacy Site Walk",
  slug: "site_walk",
  displayOrder: 5,
  isTerminal: false,
};

const customTargetStage = {
  id: "lead-stage-custom-target",
  name: "Legacy Proposal Prep",
  slug: "proposal_prep",
  displayOrder: 6,
  isTerminal: false,
};

beforeEach(() => {
  pipelineMocks.getStageById.mockReset();
  pipelineMocks.getActiveProjectTypes.mockReset();

  pipelineMocks.getActiveProjectTypes.mockResolvedValue([
    {
      id: "project-type-commercial",
      name: "Commercial",
      slug: "commercial",
    },
  ]);

  pipelineMocks.getStageById.mockImplementation(async (id: string) => {
    switch (id) {
      case newLeadStage.id:
        return newLeadStage;
      case qualifiedLeadStage.id:
        return qualifiedLeadStage;
      case salesValidationStage.id:
        return salesValidationStage;
      case opportunityStage.id:
        return opportunityStage;
      case customCurrentStage.id:
        return customCurrentStage;
      case customTargetStage.id:
        return customTargetStage;
      default:
        return null;
    }
  });
});

describe("lead service canonical progression", () => {
  it("rejects skipping directly from new_lead to opportunity", async () => {
    const tenantDb = createFakeTenantDb({
      id: "lead-1",
      companyId: "company-1",
      propertyId: "property-1",
      primaryContactId: null,
      name: "Palm Villas repaint",
      stageId: newLeadStage.id,
      assignedRepId: "rep-1",
      status: "open",
      source: "Referral",
      description: null,
      stageEnteredAt: new Date("2026-04-12T15:00:00.000Z"),
      convertedAt: null,
      isActive: true,
      createdAt: new Date("2026-04-12T15:00:00.000Z"),
      updatedAt: new Date("2026-04-12T15:00:00.000Z"),
    });
    const service = createLeadService({
      getStageById: pipelineMocks.getStageById as never,
      getActiveProjectTypes: pipelineMocks.getActiveProjectTypes as never,
      now: () => new Date("2026-04-15T15:00:00.000Z"),
    });

    await expect(
      service.updateLead(
        tenantDb as never,
        "lead-1",
        { stageId: opportunityStage.id },
        "director",
        "director-1"
      )
    ).rejects.toMatchObject<AppError>({
      statusCode: 409,
      message: "Lead stage progression must move one canonical stage at a time",
      code: "LEAD_STAGE_PROGRESSION_GAP",
    });
  });

  it("rejects skipping directly from qualified_lead to opportunity", async () => {
    const tenantDb = createFakeTenantDb({
      id: "lead-1",
      companyId: "company-1",
      propertyId: "property-1",
      primaryContactId: null,
      name: "Palm Villas repaint",
      stageId: qualifiedLeadStage.id,
      assignedRepId: "rep-1",
      status: "open",
      source: "Referral",
      description: null,
      stageEnteredAt: new Date("2026-04-12T15:00:00.000Z"),
      convertedAt: null,
      isActive: true,
      createdAt: new Date("2026-04-12T15:00:00.000Z"),
      updatedAt: new Date("2026-04-12T15:00:00.000Z"),
    });
    const service = createLeadService({
      getStageById: pipelineMocks.getStageById as never,
      getActiveProjectTypes: pipelineMocks.getActiveProjectTypes as never,
      now: () => new Date("2026-04-15T15:00:00.000Z"),
    });

    await expect(
      service.updateLead(
        tenantDb as never,
        "lead-1",
        { stageId: opportunityStage.id },
        "director",
        "director-1"
      )
    ).rejects.toMatchObject<AppError>({
      statusCode: 409,
      message: "Lead stage progression must move one canonical stage at a time",
      code: "LEAD_STAGE_PROGRESSION_GAP",
    });
  });

  it("enforces qualification requirements before moving canonical sales_validation leads into opportunity", async () => {
    const tenantDb = createFakeTenantDb({
      id: "lead-1",
      companyId: "company-1",
      propertyId: "property-1",
      primaryContactId: null,
      name: "Palm Villas repaint",
      stageId: salesValidationStage.id,
      assignedRepId: "rep-1",
      status: "open",
      projectTypeId: "project-type-commercial",
      qualificationPayload: {
        existing_customer_status: "existing",
      },
      projectTypeQuestionPayload: {
        projectTypeId: "project-type-commercial",
        answers: {
          project_scope: "Exterior repaint",
          decision_maker: "",
        },
      },
      source: "Referral",
      description: null,
      stageEnteredAt: new Date("2026-04-12T15:00:00.000Z"),
      convertedAt: null,
      isActive: true,
      createdAt: new Date("2026-04-12T15:00:00.000Z"),
      updatedAt: new Date("2026-04-12T15:00:00.000Z"),
    });
    const service = createLeadService({
      getStageById: pipelineMocks.getStageById as never,
      getActiveProjectTypes: pipelineMocks.getActiveProjectTypes as never,
      now: () => new Date("2026-04-15T15:00:00.000Z"),
    });

    await expect(
      service.updateLead(
        tenantDb as never,
        "lead-1",
        { stageId: opportunityStage.id },
        "director",
        "director-1"
      )
    ).rejects.toMatchObject<LeadStageTransitionError>({
      code: "LEAD_STAGE_REQUIREMENTS_UNMET",
      result: {
        missingRequirements: {
          qualificationFields: ["estimated_value", "timeline_status"],
          projectTypeQuestionIds: [
            "decision_maker",
            "budget_status",
            "timeline_target",
            "incumbent_vendor",
          ],
        },
      },
    });
  });

  it("records lead stage history when advancing from sales_validation to opportunity", async () => {
    const tenantDb = createFakeTenantDb({
      id: "lead-1",
      companyId: "company-1",
      propertyId: "property-1",
      primaryContactId: null,
      name: "Palm Villas repaint",
      stageId: salesValidationStage.id,
      assignedRepId: "rep-1",
      status: "open",
      projectTypeId: "project-type-commercial",
      qualificationPayload: {
        existing_customer_status: "existing",
        estimated_value: 120000,
        timeline_status: "this_quarter",
      },
      projectTypeQuestionPayload: {
        projectTypeId: "project-type-commercial",
        answers: {
          project_scope: "Exterior repaint",
          decision_maker: "Facilities director",
          budget_status: "Approved",
          timeline_target: "Q3 2026",
          incumbent_vendor: "None",
        },
      },
      source: "Referral",
      description: null,
      stageEnteredAt: new Date("2026-04-12T15:00:00.000Z"),
      convertedAt: null,
      isActive: true,
      createdAt: new Date("2026-04-12T15:00:00.000Z"),
      updatedAt: new Date("2026-04-12T15:00:00.000Z"),
    });
    const service = createLeadService({
      getStageById: pipelineMocks.getStageById as never,
      getActiveProjectTypes: pipelineMocks.getActiveProjectTypes as never,
      now: () => new Date("2026-04-15T15:00:00.000Z"),
    });

    const lead = await service.updateLead(
      tenantDb as never,
      "lead-1",
      { stageId: opportunityStage.id },
      "director",
      "director-1"
    );

    expect(lead.stageId).toBe(opportunityStage.id);
    expect(tenantDb.state.leadStageHistory).toEqual([
      expect.objectContaining({
        leadId: "lead-1",
        fromStageId: salesValidationStage.id,
        toStageId: opportunityStage.id,
        changedBy: "director-1",
        isBackwardMove: false,
      }),
    ]);
  });

  it("allows mixed-config tenants to move between custom lead stages without canonical invalid-stage errors", async () => {
    const tenantDb = createFakeTenantDb({
      id: "lead-1",
      companyId: "company-1",
      propertyId: "property-1",
      primaryContactId: null,
      name: "Palm Villas repaint",
      stageId: customCurrentStage.id,
      assignedRepId: "rep-1",
      status: "open",
      source: "Referral",
      description: null,
      stageEnteredAt: new Date("2026-04-12T15:00:00.000Z"),
      convertedAt: null,
      isActive: true,
      createdAt: new Date("2026-04-12T15:00:00.000Z"),
      updatedAt: new Date("2026-04-12T15:00:00.000Z"),
    });
    const service = createLeadService({
      getStageById: pipelineMocks.getStageById as never,
      getActiveProjectTypes: pipelineMocks.getActiveProjectTypes as never,
      now: () => new Date("2026-04-15T15:00:00.000Z"),
    });

    const lead = await service.updateLead(
      tenantDb as never,
      "lead-1",
      { stageId: customTargetStage.id },
      "director",
      "director-1"
    );

    expect(lead.stageId).toBe(customTargetStage.id);
  });

  it("allows mixed-config tenants to move from a custom lead stage into opportunity", async () => {
    const tenantDb = createFakeTenantDb({
      id: "lead-1",
      companyId: "company-1",
      propertyId: "property-1",
      primaryContactId: null,
      name: "Palm Villas repaint",
      stageId: customCurrentStage.id,
      assignedRepId: "rep-1",
      status: "open",
      source: "Referral",
      description: null,
      stageEnteredAt: new Date("2026-04-12T15:00:00.000Z"),
      convertedAt: null,
      isActive: true,
      createdAt: new Date("2026-04-12T15:00:00.000Z"),
      updatedAt: new Date("2026-04-12T15:00:00.000Z"),
    });
    const service = createLeadService({
      getStageById: pipelineMocks.getStageById as never,
      getActiveProjectTypes: pipelineMocks.getActiveProjectTypes as never,
      now: () => new Date("2026-04-15T15:00:00.000Z"),
    });

    const lead = await service.updateLead(
      tenantDb as never,
      "lead-1",
      { stageId: opportunityStage.id },
      "director",
      "director-1"
    );

    expect(lead.stageId).toBe(opportunityStage.id);
  });
});
