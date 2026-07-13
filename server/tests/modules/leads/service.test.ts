import {
  companies,
  contacts,
  deals,
  activities,
  auditLog,
  leadDueDiligenceApprovals,
  leadStageHistory,
  leadQuestionAnswerHistory,
  leadQuestionAnswers,
  leads,
  notificationRecipientAssignments,
  notificationRecipientGroups,
  projectTypeConfig,
  projectTypeQuestionNodes,
  properties,
  users,
} from "@trock-crm/shared/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../../../src/middleware/error-handler.js";
import { createLeadService } from "../../../src/modules/leads/service.js";
import { LeadStageTransitionError } from "../../../src/modules/leads/stage-transition-service.js";

const pipelineMocks = vi.hoisted(() => ({
  getAllStages: vi.fn(),
  getStageById: vi.fn(),
  getStageBySlug: vi.fn(),
  getActiveProjectTypes: vi.fn(),
}));
const assignmentTaskMocks = vi.hoisted(() => ({
  createAssignmentTaskIfNeeded: vi.fn(),
}));

vi.mock("../../../src/modules/pipeline/service.js", () => ({
  getAllStages: pipelineMocks.getAllStages,
  getStageById: pipelineMocks.getStageById,
  getStageBySlug: pipelineMocks.getStageBySlug,
  getActiveProjectTypes: pipelineMocks.getActiveProjectTypes,
}));
vi.mock("../../../src/modules/assignment-tasks/service.js", () => ({
  createAssignmentTaskIfNeeded: assignmentTaskMocks.createAssignmentTaskIfNeeded,
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
  salesRepId?: string | null;
  status: "open" | "converted" | "disqualified";
  officeCode?: string | null;
  office?: string | null;
  projectTypeId?: string | null;
  projectType?: string | null;
  qualificationPayload?: Record<string, string | boolean | number | null>;
  projectTypeQuestionPayload?: {
    projectTypeId: string | null;
    answers: Record<string, string | boolean | number | null>;
  };
  bidDueDate?: string | null;
  source: string | null;
  description: string | null;
  stageEnteredAt: Date;
  convertedAt: Date | null;
  disqualifiedAt?: Date | null;
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
        isActive: true,
      },
    ],
    properties: [
      {
        id: "property-1",
        companyId: "company-1",
        name: "Palm Villas North",
        address: "123 Palm Way",
        city: "Miami",
        state: "FL",
        zip: "33101",
        buildYear: 1998,
        unitCount: 120,
        isActive: true,
      },
    ],
    contacts: [
      {
        id: "contact-1",
        companyId: "company-1",
        isActive: true,
      },
    ],
    users: [
      {
        id: "rep-1",
        isActive: true,
        officeId: "office-1",
      },
    ],
    projectTypes: [],
    projectTypeQuestionNodes: [
      {
        id: "node-bid-due-date",
        projectTypeId: null,
        parentNodeId: null,
        parentOptionValue: null,
        nodeType: "question",
        key: "bid_due_date",
        label: "Bid Due Date",
        prompt: null,
        inputType: "date",
        options: [],
        isRequired: true,
        displayOrder: 10,
        isActive: true,
      },
    ],
    leads: [lead],
    deals: [],
    activities: [] as Array<Record<string, unknown>>,
    auditLog: [] as Array<Record<string, unknown>>,
    leadStageHistory: [] as Array<Record<string, unknown>>,
    leadQuestionAnswers: [] as Array<Record<string, unknown>>,
    leadQuestionAnswerHistory: [] as Array<Record<string, unknown>>,
    leadDueDiligenceApprovals: [] as Array<Record<string, unknown>>,
    notificationRecipientGroups: [] as Array<Record<string, unknown>>,
    notificationRecipientAssignments: [] as Array<Record<string, unknown>>,
  };

  const resolveTableName = (table: unknown) => (table as { _: { name?: string } })?._?.name;
  const resolveDrizzleTableName = (table: unknown) =>
    String(
      resolveTableName(table)
      ?? (table as Record<PropertyKey, unknown> | undefined)?.[Symbol.for("drizzle:Name")]
      ?? ""
    );

  const filterRows = (rows: Array<Record<string, unknown>>, condition: unknown) => {
    if (rows.length <= 1) {
      return rows;
    }

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
      innerJoin() {
        return this;
      },
      leftJoin() {
        return this;
      },
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
    execute: vi.fn(async () => ({
      rows: [],
    })),
    select(fields?: Record<string, unknown>) {
      return {
        from(table: unknown) {
          const tableName = resolveDrizzleTableName(table);

          if (table === leads || tableName === "leads") {
            return createQueryBuilder(state.leads as Array<Record<string, unknown>>, fields);
          }
          if (table === companies || tableName === "companies") {
            return createQueryBuilder(state.companies as Array<Record<string, unknown>>, fields);
          }
          if (table === properties || tableName === "properties") {
            return createQueryBuilder(state.properties as Array<Record<string, unknown>>, fields);
          }
          if (table === contacts || tableName === "contacts") {
            return createQueryBuilder(state.contacts as Array<Record<string, unknown>>, fields);
          }
          if (table === users || tableName === "users") {
            return createQueryBuilder(state.users as Array<Record<string, unknown>>, fields);
          }
          if (table === notificationRecipientGroups || tableName === "notification_recipient_groups") {
            return createQueryBuilder(state.notificationRecipientGroups, fields);
          }
          if (table === notificationRecipientAssignments || tableName === "notification_recipient_assignments") {
            return createQueryBuilder(state.notificationRecipientAssignments, fields);
          }
          if (table === projectTypeConfig || tableName === "project_type_config") {
            return createQueryBuilder(state.projectTypes as Array<Record<string, unknown>>, fields);
          }
          if (table === projectTypeQuestionNodes || tableName === "project_type_question_nodes") {
            return createQueryBuilder(state.projectTypeQuestionNodes as Array<Record<string, unknown>>, fields);
          }
          if (table === deals || tableName === "deals") {
            return createQueryBuilder(state.deals as Array<Record<string, unknown>>, fields);
          }
          if (table === activities || tableName === "activities") {
            return createQueryBuilder(state.activities, fields);
          }

          if (table === auditLog || tableName === "audit_log") {
            const insertedRow = {
              id: value.id ?? `audit-log-${state.auditLog.length + 1}`,
              ...value,
            };
            state.auditLog.push(insertedRow);
            return {
              returning() {
                return Promise.resolve([{ ...insertedRow }]);
              },
              then(onfulfilled: (value: unknown) => unknown) {
                return Promise.resolve(insertedRow).then(onfulfilled);
              },
            };
          }
          if (table === leadStageHistory || tableName === "lead_stage_history") {
            return createQueryBuilder(state.leadStageHistory, fields);
          }
          if (table === leadQuestionAnswers || tableName === "lead_question_answers") {
            return createQueryBuilder(state.leadQuestionAnswers, fields);
          }
          if (table === leadQuestionAnswerHistory || tableName === "lead_question_answer_history") {
            return createQueryBuilder(state.leadQuestionAnswerHistory, fields);
          }
          if (table === leadDueDiligenceApprovals || tableName === "lead_due_diligence_approvals") {
            return createQueryBuilder(state.leadDueDiligenceApprovals, fields);
          }

          throw new Error(`Unexpected table: ${String(tableName)}`);
        },
      };
    },
    insert(table: unknown) {
      return {
        values(value: Record<string, unknown>) {
          const tableName = resolveDrizzleTableName(table);

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

          if (table === activities || tableName === "activities") {
            const insertedRow = {
              id: value.id ?? `activity-${state.activities.length + 1}`,
              createdAt: value.createdAt ?? new Date("2026-04-15T15:00:00.000Z"),
              ...value,
            };
            state.activities.push(insertedRow);
            return {
              returning() {
                return Promise.resolve([{ ...insertedRow }]);
              },
              then(onfulfilled: (value: unknown) => unknown) {
                return Promise.resolve(insertedRow).then(onfulfilled);
              },
            };
          }

          if (table === auditLog || tableName === "audit_log") {
            const insertedRow = {
              id: value.id ?? `audit-log-${state.auditLog.length + 1}`,
              ...value,
            };
            state.auditLog.push(insertedRow);
            return {
              returning() {
                return Promise.resolve([{ ...insertedRow }]);
              },
              then(onfulfilled: (value: unknown) => unknown) {
                return Promise.resolve(insertedRow).then(onfulfilled);
              },
            };
          }

          if (table === leads || tableName === "leads") {
            const insertedRow = {
              id: value.id ?? `lead-${state.leads.length + 1}`,
              convertedAt: null,
              ...value,
            };
            state.leads.push(insertedRow as FakeLeadRow);
            return {
              returning() {
                return Promise.resolve([{ ...insertedRow }]);
              },
              then(onfulfilled: (value: unknown) => unknown) {
                return Promise.resolve(insertedRow).then(onfulfilled);
              },
            };
          }

          if (table === leadQuestionAnswers || tableName === "lead_question_answers") {
            const insertedRow = {
              id: value.id ?? `lead-question-answer-${state.leadQuestionAnswers.length + 1}`,
              ...value,
            };
            state.leadQuestionAnswers.push(insertedRow);
            return {
              returning() {
                return Promise.resolve([{ ...insertedRow }]);
              },
              then(onfulfilled: (value: unknown) => unknown) {
                return Promise.resolve(insertedRow).then(onfulfilled);
              },
            };
          }

          if (table === leadQuestionAnswerHistory || tableName === "lead_question_answer_history") {
            const insertedRow = {
              id: value.id ?? `lead-question-history-${state.leadQuestionAnswerHistory.length + 1}`,
              ...value,
            };
            state.leadQuestionAnswerHistory.push(insertedRow);
            return {
              returning() {
                return Promise.resolve([{ ...insertedRow }]);
              },
              then(onfulfilled: (value: unknown) => unknown) {
                return Promise.resolve(insertedRow).then(onfulfilled);
              },
            };
          }

          if (table === leadDueDiligenceApprovals || tableName === "lead_due_diligence_approvals") {
            const insertedRow = {
              id: value.id ?? `lead-due-diligence-approval-${state.leadDueDiligenceApprovals.length + 1}`,
              emailSentAt: null,
              emailMessageId: null,
              ...value,
            };
            state.leadDueDiligenceApprovals.push(insertedRow);
            return {
              returning() {
                return Promise.resolve([{ ...insertedRow }]);
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
  assignmentTaskMocks.createAssignmentTaskIfNeeded.mockReset();

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
  it("accepts officeCode update with same value in different casing", async () => {
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
      officeCode: "dfw",
      office: "dfw",
      projectTypeId: "project-type-commercial",
      qualificationPayload: {},
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
      { officeCode: "DFW" },
      "director",
      "director-1"
    );

    expect(lead.officeCode).toBe("dfw");
    expect(tenantDb.state.leads[0]?.officeCode).toBe("dfw");
  });

  it("accepts officeCode update with same value in different whitespace", async () => {
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
      officeCode: "dfw",
      office: "dfw",
      projectTypeId: "project-type-commercial",
      qualificationPayload: {},
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
      { officeCode: "dfw " },
      "director",
      "director-1"
    );

    expect(lead.officeCode).toBe("dfw");
    expect(tenantDb.state.leads[0]?.officeCode).toBe("dfw");
  });

  it("rejects invalid officeCode value with 400 not 422", async () => {
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
      officeCode: "dfw",
      office: "dfw",
      projectTypeId: "project-type-commercial",
      qualificationPayload: {},
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
        { officeCode: "atlanta" },
        "director",
        "director-1"
      )
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "INVALID_OFFICE_CODE",
    });

    expect(tenantDb.state.leads[0]?.officeCode).toBe("dfw");
  });

  it("still rejects valid-but-different officeCode with 422", async () => {
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
      officeCode: "dfw",
      office: "dfw",
      projectTypeId: "project-type-commercial",
      qualificationPayload: {},
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
        { officeCode: "atl" },
        "director",
        "director-1"
      )
    ).rejects.toMatchObject({
      statusCode: 422,
      code: "LEAD_OFFICE_IMMUTABLE",
      message: "office_code cannot be changed once set",
    });

    expect(tenantDb.state.leads[0]?.officeCode).toBe("dfw");
  });

  it("rejects office_code update with 422 not 500", async () => {
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
      officeCode: "dfw",
      office: "dfw",
      projectTypeId: "project-type-commercial",
      qualificationPayload: {},
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
        { officeCode: "atl" },
        "director",
        "director-1"
      )
    ).rejects.toMatchObject({
      statusCode: 422,
      message: "office_code cannot be changed once set",
    });

    expect(tenantDb.state.leads[0]?.officeCode).toBe("dfw");
  });

  it("rejects office update with 422 not 500", async () => {
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
      officeCode: "dfw",
      office: "dfw",
      projectTypeId: "project-type-commercial",
      qualificationPayload: {},
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
        { office: "atl" } as never,
        "director",
        "director-1"
      )
    ).rejects.toMatchObject({
      statusCode: 422,
      message: "office cannot be changed once set",
    });

    expect(tenantDb.state.leads[0]?.office).toBe("dfw");
  });

  it("allows moving from new_lead to qualified_lead when intake prerequisites are complete", async () => {
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
      projectTypeId: "project-type-commercial",
      qualificationPayload: {
        existing_customer_status: "existing",
      },
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
      { stageId: qualifiedLeadStage.id },
      "director",
      "director-1"
    );

    expect(lead.stageId).toBe(qualifiedLeadStage.id);
    expect(tenantDb.state.leadStageHistory).toEqual([
      expect.objectContaining({
        leadId: "lead-1",
        fromStageId: newLeadStage.id,
        toStageId: qualifiedLeadStage.id,
        changedBy: "director-1",
        isBackwardMove: false,
      }),
    ]);
    expect(tenantDb.state.activities).toEqual([
      expect.objectContaining({
        type: "note",
        outcome: "lead_stage_changed",
        responsibleUserId: "rep-1",
        performedByUserId: "director-1",
        sourceEntityType: "lead",
        sourceEntityId: "lead-1",
        leadId: "lead-1",
        companyId: "company-1",
        propertyId: "property-1",
        subject: "Stage changed from New Lead to Qualified Lead",
        body: "Moved this lead from New Lead to Qualified Lead.",
        occurredAt: new Date("2026-04-15T15:00:00.000Z"),
      }),
    ]);
  });

  it("stamps disqualifiedAt with the clock on the transition into disqualified", async () => {
    const FIXED_NOW = new Date("2026-04-15T15:00:00.000Z");
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
      officeCode: "dfw",
      office: "dfw",
      projectTypeId: "project-type-commercial",
      qualificationPayload: {},
      description: null,
      stageEnteredAt: new Date("2026-04-12T15:00:00.000Z"),
      convertedAt: null,
      disqualifiedAt: null,
      isActive: true,
      createdAt: new Date("2026-04-12T15:00:00.000Z"),
      updatedAt: new Date("2026-04-12T15:00:00.000Z"),
    });
    const service = createLeadService({
      now: () => FIXED_NOW,
      getStageById: pipelineMocks.getStageById as never,
      getActiveProjectTypes: pipelineMocks.getActiveProjectTypes as never,
    });

    const lead = await service.updateLead(
      tenantDb as never,
      "lead-1",
      { status: "disqualified" },
      "director",
      "director-1"
    );

    expect(lead.status).toBe("disqualified");
    expect(lead.isActive).toBe(false);
    expect(lead.disqualifiedAt).toEqual(FIXED_NOW);
    expect(tenantDb.state.leads[0]?.disqualifiedAt).toEqual(FIXED_NOW);
  });

  it("never re-stamps disqualifiedAt: a disqualified lead is inactive and read-only, so its date can't jump windows", async () => {
    // Reachability guard: disqualifying sets isActive=false, and updateLead
    // rejects inactive non-converted leads with a 409 read-only error BEFORE the
    // status block. So an already-disqualified lead can never be re-saved through
    // updateLead — the original disqualified date is permanent (the bug Codex
    // flagged: a Jan-disqualified lead must not re-stamp to a later month).
    const DISQUALIFY_NOW = new Date("2026-01-09T10:00:00.000Z");
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
      officeCode: "dfw",
      office: "dfw",
      projectTypeId: "project-type-commercial",
      qualificationPayload: {},
      description: null,
      stageEnteredAt: new Date("2026-01-08T15:00:00.000Z"),
      convertedAt: null,
      disqualifiedAt: null,
      isActive: true,
      createdAt: new Date("2026-01-08T15:00:00.000Z"),
      updatedAt: new Date("2026-01-08T15:00:00.000Z"),
    });
    const service = createLeadService({
      now: () => DISQUALIFY_NOW,
      getStageById: pipelineMocks.getStageById as never,
      getActiveProjectTypes: pipelineMocks.getActiveProjectTypes as never,
    });

    await service.updateLead(
      tenantDb as never,
      "lead-1",
      { status: "disqualified" },
      "director",
      "director-1"
    );
    expect(tenantDb.state.leads[0]?.disqualifiedAt).toEqual(DISQUALIFY_NOW);
    expect(tenantDb.state.leads[0]?.isActive).toBe(false);

    // A later edit (even one that re-submits status=disqualified) is blocked, so
    // the original January date stands — it never jumps into a later window.
    await expect(
      service.updateLead(
        tenantDb as never,
        "lead-1",
        { status: "disqualified", description: "added a note" },
        "director",
        "director-1"
      )
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(tenantDb.state.leads[0]?.disqualifiedAt).toEqual(DISQUALIFY_NOW);
  });

  it("preserves qualification payload when creating a lead with lead edit v2 enabled", async () => {
    const previousFlag = process.env.ENABLE_LEAD_EDIT_V2;
    process.env.ENABLE_LEAD_EDIT_V2 = "true";

    const insertedLeads: Array<Record<string, unknown>> = [];
    const tenantDb = {
      select() {
        return {
          from(table: unknown) {
            const rows =
              table === companies
                ? [{ id: "company-1", isActive: true }]
                : table === properties
                ? [{ id: "property-1", companyId: "company-1", isActive: true, address: "123 Main", city: "Dallas", state: "TX", zip: "75001", buildYear: 2001, unitCount: 80 }]
                  : table === contacts
                    ? [{ id: "contact-1", companyId: "company-1", isActive: true }]
                  : table === projectTypeQuestionNodes
                    ? [{ id: "node-bid-due-date", projectTypeId: null, parentNodeId: null, parentOptionValue: null, nodeType: "question", key: "bid_due_date", label: "Bid Due Date", prompt: null, inputType: "date", options: [], isRequired: true, displayOrder: 10, isActive: true }]
                  : table === leadQuestionAnswers
                    ? []
                  : table === users
                    ? [{ id: "rep-1", isActive: true, officeId: "office-1" }]
                  : table === notificationRecipientGroups || table === notificationRecipientAssignments
                    ? []
                    : [];

            return {
              innerJoin() {
                return this;
              },
              where() {
                return this;
              },
              limit() {
                return this;
              },
              then(onfulfilled: (value: unknown[]) => unknown) {
                return Promise.resolve(rows.map((row) => ({ ...row }))).then(onfulfilled);
              },
            };
          },
        };
      },
      insert(table: unknown) {
        if (table === leadDueDiligenceApprovals) {
          return {
            values(value: Record<string, unknown>) {
              return {
                returning() {
                  return Promise.resolve([{ id: "lead-dd-approval-1", ...value }]);
                },
              };
            },
          };
        }
        if (table === leadQuestionAnswerHistory || table === leadQuestionAnswers) {
          return {
            values(value: Record<string, unknown>) {
              return {
                returning() {
                  return Promise.resolve([{ id: "question-row-1", ...value }]);
                },
              };
            },
          };
        }
        if (table !== leads) {
          throw new Error(`Unexpected insert table: ${String((table as { _: { name?: string } })?._?.name)}`);
        }

        return {
          values(value: Record<string, unknown>) {
            const insertedRow = {
              id: "lead-created",
              convertedAt: null,
              ...value,
            };
            insertedLeads.push(insertedRow);
            return {
              returning() {
                return Promise.resolve([{ ...insertedRow }]);
              },
            };
          },
        };
      },
    };
    const service = createLeadService({
      getStageById: pipelineMocks.getStageById as never,
      getActiveProjectTypes: pipelineMocks.getActiveProjectTypes as never,
      now: () => new Date("2026-04-15T15:00:00.000Z"),
    });

    try {
      const lead = await service.createLead(tenantDb as never, {
        companyId: "company-1",
        propertyId: "property-1",
        stageId: newLeadStage.id,
        assignedRepId: "rep-1",
        salesRepId: "rep-1",
        officeId: "office-1",
        primaryContactId: "contact-1",
        primaryContactRole: "property_manager",
        name: "Created Lead",
        source: "Referral",
        officeCode: "dfw",
        projectType: "commercial",
        projectTypeId: "project-type-commercial",
        budgetStatus: "budgeted_q3",
        bidDueDate: "2026-06-01",
        qualificationPayload: {
          existing_customer_status: "existing",
          estimated_value: 125000,
          timeline_status: "Q3 2026",
        },
      });

      expect(lead.qualificationPayload).toEqual({
        existing_customer_status: "existing",
        estimated_value: 125000,
        timeline_status: "Q3 2026",
      });
      expect(insertedLeads[0]?.qualificationPayload).toEqual({
        existing_customer_status: "existing",
        estimated_value: 125000,
        timeline_status: "Q3 2026",
      });
      expect(lead.salesRepId).toBe("rep-1");
      expect(lead.stageId).toBe(newLeadStage.id);
      expect(insertedLeads[0]?.salesRepId).toBe("rep-1");
      expect(insertedLeads[0]?.stageId).toBe(newLeadStage.id);
    } finally {
      if (previousFlag === undefined) {
        delete process.env.ENABLE_LEAD_EDIT_V2;
      } else {
        process.env.ENABLE_LEAD_EDIT_V2 = previousFlag;
      }
    }
  });

  it("creates a lead assignment task when actorUserId is provided on create", async () => {
    const previousFlag = process.env.ENABLE_LEAD_EDIT_V2;
    process.env.ENABLE_LEAD_EDIT_V2 = "false";
    const tenantDb = createFakeTenantDb({
      id: "lead-existing",
      companyId: "company-1",
      propertyId: "property-1",
      primaryContactId: "contact-1",
      name: "Existing",
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
    tenantDb.state.projectTypes = [{ id: "project-type-commercial", name: "Commercial", slug: "commercial", parentId: null }];
    const service = createLeadService({
      getStageById: pipelineMocks.getStageById as never,
      getActiveProjectTypes: pipelineMocks.getActiveProjectTypes as never,
      now: () => new Date("2026-04-15T15:00:00.000Z"),
    });

    try {
      const lead = await service.createLead(tenantDb as never, {
        companyId: "company-1",
        propertyId: "property-1",
        stageId: newLeadStage.id,
        assignedRepId: "rep-1",
        actorUserId: "director-1",
        officeId: "office-1",
        primaryContactId: "contact-1",
        primaryContactRole: "property_manager",
        name: "Created Lead",
        source: "Referral",
        officeCode: "dfw",
        projectType: "commercial",
        projectTypeId: "project-type-commercial",
        budgetStatus: "budgeted_q3",
        bidDueDate: "2026-06-01",
      });

      expect(assignmentTaskMocks.createAssignmentTaskIfNeeded).toHaveBeenCalledWith(
        tenantDb,
        expect.objectContaining({
          entityType: "lead",
          entityId: lead.id,
          entityName: "Created Lead",
          previousAssignedRepId: null,
          nextAssignedRepId: "rep-1",
          actorUserId: "director-1",
          officeId: "office-1",
        })
      );
    } finally {
      if (previousFlag === undefined) delete process.env.ENABLE_LEAD_EDIT_V2;
      else process.env.ENABLE_LEAD_EDIT_V2 = previousFlag;
    }
  });

  it("creates a new-customer lead in new_lead with pending DD approval and post-commit email pending", async () => {
    const previousFlag = process.env.ENABLE_LEAD_EDIT_V2;
    process.env.ENABLE_LEAD_EDIT_V2 = "true";
    const tenantDb = createFakeTenantDb({
      id: "lead-existing",
      companyId: "company-1",
      propertyId: "property-1",
      primaryContactId: "contact-1",
      name: "Existing",
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
    tenantDb.state.projectTypes = [{ id: "project-type-commercial", name: "Commercial", slug: "commercial", parentId: null }];
    tenantDb.state.projectTypeQuestionNodes = [{
      id: "node-roof-scope",
      projectTypeId: null,
      parentNodeId: null,
      parentOptionValue: null,
      nodeType: "question",
      key: "roof_scope",
      label: "Roof Scope",
      prompt: null,
      inputType: "text",
      options: [],
      isRequired: false,
      displayOrder: 10,
      isActive: true,
    }];
    tenantDb.execute.mockResolvedValue({ rows: [] });
    const service = createLeadService({
      getStageById: pipelineMocks.getStageById as never,
      getActiveProjectTypes: pipelineMocks.getActiveProjectTypes as never,
      now: () => new Date("2026-04-15T15:00:00.000Z"),
    });

    try {
      const lead = await service.createLead(tenantDb as never, {
        companyId: "company-1",
        propertyId: "property-1",
        stageId: newLeadStage.id,
        assignedRepId: "rep-1",
        actorUserId: "director-1",
        officeId: "office-1",
        primaryContactId: "contact-1",
        primaryContactRole: "property_manager",
        name: "Created Lead",
        source: "Referral",
        officeCode: "dfw",
        projectType: "commercial",
        projectTypeId: "project-type-commercial",
        budgetStatus: "budgeted_q3",
        bidDueDate: "2026-06-01",
        leadQuestionAnswers: { roof_scope: "Full replacement" },
      });

      expect(lead.stageId).toBe(newLeadStage.id);
      expect(lead.verificationStatus).toBe("pending");
      expect(lead.verificationRequiredReason).toBe("new_company");
      expect(tenantDb.state.leadDueDiligenceApprovals).toEqual([
        expect.objectContaining({
          status: "pending",
          leadId: lead.id,
          requestedBy: "rep-1",
          detectionSignal: {
            source: "none",
            type: "no_recent_activity",
            occurredAt: null,
            detail: "No activity found on company, contact, or property in the last 12 months.",
          },
          emailSentAt: null,
          emailMessageId: null,
        }),
      ]);
      expect(assignmentTaskMocks.createAssignmentTaskIfNeeded).toHaveBeenCalledWith(
        tenantDb,
        expect.objectContaining({ entityId: lead.id, actorUserId: "director-1" })
      );
      expect(tenantDb.state.leadQuestionAnswers).toEqual([
        expect.objectContaining({
          leadId: lead.id,
          questionId: "node-roof-scope",
          valueJson: "Full replacement",
        }),
      ]);
      expect(tenantDb.state.leadQuestionAnswers).not.toEqual([
        expect.objectContaining({ questionId: "node-bid-due-date" }),
      ]);
    } finally {
      if (previousFlag === undefined) delete process.env.ENABLE_LEAD_EDIT_V2;
      else process.env.ENABLE_LEAD_EDIT_V2 = previousFlag;
    }
  });

  it("creates an existing-customer lead in qualified_lead without DD approval while preserving side effects", async () => {
    const previousFlag = process.env.ENABLE_LEAD_EDIT_V2;
    process.env.ENABLE_LEAD_EDIT_V2 = "true";
    const tenantDb = createFakeTenantDb({
      id: "lead-existing",
      companyId: "company-1",
      propertyId: "property-1",
      primaryContactId: "contact-1",
      name: "Existing",
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
    tenantDb.state.projectTypes = [{ id: "project-type-commercial", name: "Commercial", slug: "commercial", parentId: null }];
    tenantDb.execute.mockResolvedValue({
      rows: [{
        source: "company",
        type: "deal",
        occurred_at: new Date("2026-04-01T00:00:00.000Z"),
        detail: "Recent deal activity on company",
      }],
    });
    const getStageBySlugMock = vi.fn(async (slug: string) =>
      slug === "qualified_lead" ? qualifiedLeadStage : null
    );
    const service = createLeadService({
      getStageById: pipelineMocks.getStageById as never,
      getStageBySlug: getStageBySlugMock as never,
      getActiveProjectTypes: pipelineMocks.getActiveProjectTypes as never,
      now: () => new Date("2026-04-15T15:00:00.000Z"),
    });

    try {
      const lead = await service.createLead(tenantDb as never, {
        companyId: "company-1",
        propertyId: "property-1",
        stageId: newLeadStage.id,
        assignedRepId: "rep-1",
        actorUserId: "director-1",
        officeId: "office-1",
        primaryContactId: "contact-1",
        primaryContactRole: "property_manager",
        name: "Existing Customer Lead",
        source: "Referral",
        officeCode: "dfw",
        projectType: "commercial",
        projectTypeId: "project-type-commercial",
        budgetStatus: "budgeted_q3",
        bidDueDate: "2026-06-01",
      });

      expect(lead.stageId).toBe(qualifiedLeadStage.id);
      expect(lead.verificationStatus).toBe("not_required");
      expect(lead.verificationRequiredReason).toBeNull();
      expect(tenantDb.state.leadDueDiligenceApprovals).toEqual([]);
      expect(assignmentTaskMocks.createAssignmentTaskIfNeeded).toHaveBeenCalledWith(
        tenantDb,
        expect.objectContaining({ entityId: lead.id, actorUserId: "director-1" })
      );
      expect(tenantDb.state.leadQuestionAnswers).toEqual([
        expect.objectContaining({
          leadId: lead.id,
          questionId: "node-bid-due-date",
          valueJson: "2026-06-01",
        }),
      ]);
    } finally {
      if (previousFlag === undefined) delete process.env.ENABLE_LEAD_EDIT_V2;
      else process.env.ENABLE_LEAD_EDIT_V2 = previousFlag;
    }
  });

  it("creates a new-customer DD approval without V2 mirror writes when V2 is disabled", async () => {
    const previousFlag = process.env.ENABLE_LEAD_EDIT_V2;
    process.env.ENABLE_LEAD_EDIT_V2 = "false";
    const tenantDb = createFakeTenantDb({
      id: "lead-existing",
      companyId: "company-1",
      propertyId: "property-1",
      primaryContactId: "contact-1",
      name: "Existing",
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
    tenantDb.state.projectTypes = [{ id: "project-type-commercial", name: "Commercial", slug: "commercial", parentId: null }];
    tenantDb.execute.mockResolvedValue({ rows: [] });
    const service = createLeadService({
      getStageById: pipelineMocks.getStageById as never,
      getActiveProjectTypes: pipelineMocks.getActiveProjectTypes as never,
      now: () => new Date("2026-04-15T15:00:00.000Z"),
    });

    try {
      const lead = await service.createLead(tenantDb as never, {
        companyId: "company-1",
        propertyId: "property-1",
        stageId: newLeadStage.id,
        assignedRepId: "rep-1",
        actorUserId: "director-1",
        officeId: "office-1",
        primaryContactId: "contact-1",
        primaryContactRole: "property_manager",
        name: "New Customer Lead",
        source: "Referral",
        officeCode: "dfw",
        projectType: "commercial",
        projectTypeId: "project-type-commercial",
        budgetStatus: "budgeted_q3",
        bidDueDate: "2026-06-01",
        leadQuestionAnswers: { bid_due_date: "2026-06-01" },
      });

      expect(lead.stageId).toBe(newLeadStage.id);
      expect(lead.verificationStatus).toBe("pending");
      expect(tenantDb.state.leadDueDiligenceApprovals).toHaveLength(1);
      expect(assignmentTaskMocks.createAssignmentTaskIfNeeded).toHaveBeenCalled();
      expect(tenantDb.state.leadQuestionAnswers).toEqual([]);
      expect(tenantDb.state.leadQuestionAnswerHistory).toEqual([]);
    } finally {
      if (previousFlag === undefined) delete process.env.ENABLE_LEAD_EDIT_V2;
      else process.env.ENABLE_LEAD_EDIT_V2 = previousFlag;
    }
  });

  it("routes an existing customer to qualified_lead without DD approval or V2 writes when V2 is disabled", async () => {
    const previousFlag = process.env.ENABLE_LEAD_EDIT_V2;
    process.env.ENABLE_LEAD_EDIT_V2 = "false";
    const tenantDb = createFakeTenantDb({
      id: "lead-existing",
      companyId: "company-1",
      propertyId: "property-1",
      primaryContactId: "contact-1",
      name: "Existing",
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
    tenantDb.state.projectTypes = [{ id: "project-type-commercial", name: "Commercial", slug: "commercial", parentId: null }];
    tenantDb.execute.mockResolvedValue({
      rows: [{
        source: "company",
        type: "deal",
        occurred_at: new Date("2026-04-01T00:00:00.000Z"),
        detail: "Recent deal activity on company",
      }],
    });
    const getStageBySlugMock = vi.fn(async (slug: string) =>
      slug === "qualified_lead" ? qualifiedLeadStage : null
    );
    const service = createLeadService({
      getStageById: pipelineMocks.getStageById as never,
      getStageBySlug: getStageBySlugMock as never,
      getActiveProjectTypes: pipelineMocks.getActiveProjectTypes as never,
      now: () => new Date("2026-04-15T15:00:00.000Z"),
    });

    try {
      const lead = await service.createLead(tenantDb as never, {
        companyId: "company-1",
        propertyId: "property-1",
        stageId: newLeadStage.id,
        assignedRepId: "rep-1",
        actorUserId: "director-1",
        officeId: "office-1",
        primaryContactId: "contact-1",
        primaryContactRole: "property_manager",
        name: "Existing Customer Lead",
        source: "Referral",
        officeCode: "dfw",
        projectType: "commercial",
        projectTypeId: "project-type-commercial",
        budgetStatus: "budgeted_q3",
        bidDueDate: "2026-06-01",
        leadQuestionAnswers: { bid_due_date: "2026-06-01" },
      });

      expect(lead.stageId).toBe(qualifiedLeadStage.id);
      expect(lead.verificationStatus).toBe("not_required");
      expect(tenantDb.state.leadDueDiligenceApprovals).toEqual([]);
      expect(assignmentTaskMocks.createAssignmentTaskIfNeeded).toHaveBeenCalled();
      expect(tenantDb.state.leadQuestionAnswers).toEqual([]);
      expect(tenantDb.state.leadQuestionAnswerHistory).toEqual([]);
    } finally {
      if (previousFlag === undefined) delete process.env.ENABLE_LEAD_EDIT_V2;
      else process.env.ENABLE_LEAD_EDIT_V2 = previousFlag;
    }
  });

  it("writes bid_due_date to the V2 mirror when the active questionnaire still has that node", async () => {
    const previousFlag = process.env.ENABLE_LEAD_EDIT_V2;
    process.env.ENABLE_LEAD_EDIT_V2 = "true";
    const tenantDb = createFakeTenantDb({
      id: "lead-existing",
      companyId: "company-1",
      propertyId: "property-1",
      primaryContactId: "contact-1",
      name: "Existing",
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
    tenantDb.state.projectTypes = [{ id: "project-type-commercial", name: "Commercial", slug: "commercial", parentId: null }];
    const service = createLeadService({
      getStageById: pipelineMocks.getStageById as never,
      getActiveProjectTypes: pipelineMocks.getActiveProjectTypes as never,
      now: () => new Date("2026-04-15T15:00:00.000Z"),
    });

    try {
      await service.createLead(tenantDb as never, {
        companyId: "company-1",
        propertyId: "property-1",
        stageId: newLeadStage.id,
        assignedRepId: "rep-1",
        officeId: "office-1",
        primaryContactId: "contact-1",
        primaryContactRole: "property_manager",
        name: "Created Lead",
        source: "Referral",
        officeCode: "dfw",
        projectType: "commercial",
        projectTypeId: "project-type-commercial",
        budgetStatus: "budgeted_q3",
        bidDueDate: "2026-06-01",
      });

      expect(tenantDb.state.leadQuestionAnswers).toEqual([
        expect.objectContaining({
          leadId: "lead-2",
          questionId: "node-bid-due-date",
          valueJson: "2026-06-01",
        }),
      ]);
    } finally {
      if (previousFlag === undefined) delete process.env.ENABLE_LEAD_EDIT_V2;
      else process.env.ENABLE_LEAD_EDIT_V2 = previousFlag;
    }
  });

  it("skips the bid_due_date V2 mirror when that node is not active during create", async () => {
    const previousFlag = process.env.ENABLE_LEAD_EDIT_V2;
    process.env.ENABLE_LEAD_EDIT_V2 = "true";
    const tenantDb = createFakeTenantDb({
      id: "lead-existing",
      companyId: "company-1",
      propertyId: "property-1",
      primaryContactId: "contact-1",
      name: "Existing",
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
    tenantDb.state.projectTypes = [{ id: "project-type-commercial", name: "Commercial", slug: "commercial", parentId: null }];
    tenantDb.state.projectTypeQuestionNodes = [];
    const service = createLeadService({
      getStageById: pipelineMocks.getStageById as never,
      getActiveProjectTypes: pipelineMocks.getActiveProjectTypes as never,
      now: () => new Date("2026-04-15T15:00:00.000Z"),
    });

    try {
      const lead = await service.createLead(tenantDb as never, {
        companyId: "company-1",
        propertyId: "property-1",
        stageId: newLeadStage.id,
        assignedRepId: "rep-1",
        officeId: "office-1",
        primaryContactId: "contact-1",
        primaryContactRole: "property_manager",
        name: "Created Lead",
        source: "Referral",
        officeCode: "dfw",
        projectType: "commercial",
        projectTypeId: "project-type-commercial",
        budgetStatus: "budgeted_q3",
        bidDueDate: "2026-06-01",
      });

      expect(lead.bidDueDate).toBe("2026-06-01");
      expect(tenantDb.state.leadQuestionAnswers).toHaveLength(0);
      expect(tenantDb.state.leadQuestionAnswerHistory).toHaveLength(0);
    } finally {
      if (previousFlag === undefined) delete process.env.ENABLE_LEAD_EDIT_V2;
      else process.env.ENABLE_LEAD_EDIT_V2 = previousFlag;
    }
  });

  it("keeps other V2 answers when bid_due_date is not an active node during create", async () => {
    const previousFlag = process.env.ENABLE_LEAD_EDIT_V2;
    process.env.ENABLE_LEAD_EDIT_V2 = "true";
    const tenantDb = createFakeTenantDb({
      id: "lead-existing",
      companyId: "company-1",
      propertyId: "property-1",
      primaryContactId: "contact-1",
      name: "Existing",
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
    tenantDb.state.projectTypes = [{ id: "project-type-commercial", name: "Commercial", slug: "commercial", parentId: null }];
    tenantDb.state.projectTypeQuestionNodes = [{
      id: "node-market-type",
      projectTypeId: null,
      parentNodeId: null,
      parentOptionValue: null,
      nodeType: "question",
      key: "market_type",
      label: "Market Type",
      prompt: null,
      inputType: "select",
      options: [],
      isRequired: false,
      displayOrder: 20,
      isActive: true,
    }];
    const service = createLeadService({
      getStageById: pipelineMocks.getStageById as never,
      getActiveProjectTypes: pipelineMocks.getActiveProjectTypes as never,
      now: () => new Date("2026-04-15T15:00:00.000Z"),
    });

    try {
      await service.createLead(tenantDb as never, {
        companyId: "company-1",
        propertyId: "property-1",
        stageId: newLeadStage.id,
        assignedRepId: "rep-1",
        officeId: "office-1",
        primaryContactId: "contact-1",
        primaryContactRole: "property_manager",
        name: "Created Lead",
        source: "Referral",
        officeCode: "dfw",
        projectType: "commercial",
        projectTypeId: "project-type-commercial",
        budgetStatus: "budgeted_q3",
        bidDueDate: "2026-06-01",
        leadQuestionAnswers: { market_type: "multifamily" },
      });

      expect(tenantDb.state.leadQuestionAnswers).toEqual([
        expect.objectContaining({
          questionId: "node-market-type",
          valueJson: "multifamily",
        }),
      ]);
      expect(tenantDb.state.leadQuestionAnswers).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ questionId: "node-bid-due-date" })])
      );
    } finally {
      if (previousFlag === undefined) delete process.env.ENABLE_LEAD_EDIT_V2;
      else process.env.ENABLE_LEAD_EDIT_V2 = previousFlag;
    }
  });

  it("rejects unknown project type when creating a lead", async () => {
    const tenantDb = {
      select() {
        return {
          from(table: unknown) {
            const rows =
              table === companies
                ? [{ id: "company-1", isActive: true }]
                : table === properties
                  ? [{ id: "property-1", companyId: "company-1", isActive: true, address: "123 Main", city: "Dallas", state: "TX", zip: "75001", buildYear: 2001, unitCount: 80 }]
                  : table === contacts
                    ? [{ id: "contact-1", companyId: "company-1", isActive: true }]
                  : table === projectTypeQuestionNodes
                    ? [{ id: "node-bid-due-date", projectTypeId: null, parentNodeId: null, parentOptionValue: null, nodeType: "question", key: "bid_due_date", label: "Bid Due Date", prompt: null, inputType: "date", options: [], isRequired: true, displayOrder: 10, isActive: true }]
                  : table === leadQuestionAnswers
                    ? []
                  : table === users
                    ? [{ id: "rep-1", isActive: true, officeId: "office-1" }]
                    : [];

            return {
              where() {
                return this;
              },
              limit() {
                return this;
              },
              then(onfulfilled: (value: unknown[]) => unknown) {
                return Promise.resolve(rows.map((row) => ({ ...row }))).then(onfulfilled);
              },
            };
          },
        };
      },
      insert() {
        throw new Error("Lead insert should not run when projectType is invalid");
      },
    };
    const service = createLeadService({
      getStageById: pipelineMocks.getStageById as never,
      getActiveProjectTypes: pipelineMocks.getActiveProjectTypes as never,
      now: () => new Date("2026-04-15T15:00:00.000Z"),
    });

    await expect(
      service.createLead(tenantDb as never, {
        companyId: "company-1",
        propertyId: "property-1",
        stageId: newLeadStage.id,
        assignedRepId: "rep-1",
        officeId: "office-1",
        primaryContactId: "contact-1",
        primaryContactRole: "property_manager",
        name: "Created Lead",
        source: "Referral",
        officeCode: "dfw",
        projectType: "casino",
        projectTypeId: "project-type-casino",
        budgetStatus: "budgeted_q1",
        bidDueDate: "2026-06-01",
      })
    ).rejects.toMatchObject<AppError>({
      statusCode: 400,
      message: "Project type not found",
    });
  });

  it("rejects missing office code when creating a lead", async () => {
    const tenantDb = {
      select() {
        return {
          from(table: unknown) {
            const rows =
              table === companies
                ? [{ id: "company-1", isActive: true }]
                : table === properties
                  ? [{ id: "property-1", companyId: "company-1", isActive: true, address: "123 Main", city: "Dallas", state: "TX", zip: "75001", buildYear: 2001, unitCount: 80 }]
                  : table === contacts
                    ? [{ id: "contact-1", companyId: "company-1", isActive: true }]
                  : table === projectTypeQuestionNodes
                    ? [{ id: "node-bid-due-date", projectTypeId: null, parentNodeId: null, parentOptionValue: null, nodeType: "question", key: "bid_due_date", label: "Bid Due Date", prompt: null, inputType: "date", options: [], isRequired: true, displayOrder: 10, isActive: true }]
                  : table === leadQuestionAnswers
                    ? []
                  : table === users
                    ? [{ id: "rep-1", isActive: true, officeId: "office-1" }]
                    : [];

            return {
              where() {
                return this;
              },
              limit() {
                return this;
              },
              then(onfulfilled: (value: unknown[]) => unknown) {
                return Promise.resolve(rows.map((row) => ({ ...row }))).then(onfulfilled);
              },
            };
          },
        };
      },
      insert() {
        throw new Error("Lead insert should not run when officeCode is missing");
      },
    };
    const service = createLeadService({
      getStageById: pipelineMocks.getStageById as never,
      getActiveProjectTypes: pipelineMocks.getActiveProjectTypes as never,
      now: () => new Date("2026-04-15T15:00:00.000Z"),
    });

    await expect(
      service.createLead(tenantDb as never, {
        companyId: "company-1",
        propertyId: "property-1",
        stageId: newLeadStage.id,
        assignedRepId: "rep-1",
        officeId: "office-1",
        name: "Created Lead",
        source: "Referral",
        projectType: "commercial",
      } as never)
    ).rejects.toMatchObject<AppError>({
      statusCode: 400,
      message: "officeCode must be 'dfw' or 'atl'",
    });
  });

  it.each([
    ["property.address", (db: any, input: any) => { db.state.properties[0].address = ""; }],
    ["property.city", (db: any, input: any) => { db.state.properties[0].city = ""; }],
    ["property.state", (db: any, input: any) => { db.state.properties[0].state = "Texas"; }],
    ["property.zip", (db: any, input: any) => { db.state.properties[0].zip = "7500"; }],
    ["property.buildYear", (db: any, input: any) => { db.state.properties[0].buildYear = 1700; }],
    ["property.unitCount", (db: any, input: any) => { db.state.properties[0].unitCount = 0; }],
    ["primaryContactId", (_db: any, input: any) => { input.primaryContactId = null; }],
    ["primaryContactRole", (_db: any, input: any) => { input.primaryContactRole = null; }],
    ["budgetStatus", (_db: any, input: any) => { input.budgetStatus = null; }],
    ["projectTypeId", (_db: any, input: any) => { input.projectTypeId = null; }],
    ["bidDueDate", (_db: any, input: any) => { input.bidDueDate = ""; }],
  ])("rejects missing lead create prerequisite %s before insert", async (fieldKey, mutate) => {
    const tenantDb = createFakeTenantDb({} as FakeLeadRow);
    tenantDb.state.leads = [];
    const service = createLeadService({
      getStageById: pipelineMocks.getStageById as never,
      getActiveProjectTypes: pipelineMocks.getActiveProjectTypes as never,
      now: () => new Date("2026-04-15T15:00:00.000Z"),
    });
    const input = {
      companyId: "company-1",
      propertyId: "property-1",
      stageId: newLeadStage.id,
      assignedRepId: "rep-1",
      officeId: "office-1",
      primaryContactId: "contact-1",
      primaryContactRole: "property_manager",
      name: "Created Lead",
      source: "Referral",
      officeCode: "dfw",
      projectTypeId: "project-type-commercial",
      budgetStatus: "budgeted_q1",
      bidDueDate: "2026-06-01",
    };
    mutate(tenantDb, input);

    await expect(service.createLead(tenantDb as never, input as never)).rejects.toMatchObject({
      statusCode: 400,
      code: "LEAD_CREATE_REQUIREMENTS_UNMET",
      missingRequirements: {
        fields: expect.arrayContaining([expect.objectContaining({ key: fieldKey })]),
      },
    });
    expect(tenantDb.state.leads).toHaveLength(0);
  });

  it("requires an other_label when POC role is other", async () => {
    const tenantDb = createFakeTenantDb({} as FakeLeadRow);
    tenantDb.state.leads = [];
    const service = createLeadService({
      getStageById: pipelineMocks.getStageById as never,
      getActiveProjectTypes: pipelineMocks.getActiveProjectTypes as never,
      now: () => new Date("2026-04-15T15:00:00.000Z"),
    });

    await expect(
      service.createLead(tenantDb as never, {
        companyId: "company-1",
        propertyId: "property-1",
        stageId: newLeadStage.id,
        assignedRepId: "rep-1",
        officeId: "office-1",
        primaryContactId: "contact-1",
        primaryContactRole: "other",
        primaryContactRoleOtherLabel: "",
        name: "Created Lead",
        source: "Referral",
        officeCode: "dfw",
        projectTypeId: "project-type-commercial",
        budgetStatus: "budgeted_q1",
        bidDueDate: "2026-06-01",
      } as never)
    ).rejects.toMatchObject({
      code: "LEAD_CREATE_REQUIREMENTS_UNMET",
      missingRequirements: {
        fields: expect.arrayContaining([expect.objectContaining({ key: "primaryContactRoleOtherLabel" })]),
      },
    });
  });

  it("rejects invalid bidDueDate before insert", async () => {
    const tenantDb = createFakeTenantDb({} as FakeLeadRow);
    tenantDb.state.leads = [];
    const service = createLeadService({
      getStageById: pipelineMocks.getStageById as never,
      getActiveProjectTypes: pipelineMocks.getActiveProjectTypes as never,
      now: () => new Date("2026-04-15T15:00:00.000Z"),
    });

    await expect(
      service.createLead(tenantDb as never, {
        companyId: "company-1",
        propertyId: "property-1",
        stageId: newLeadStage.id,
        assignedRepId: "rep-1",
        officeId: "office-1",
        primaryContactId: "contact-1",
        primaryContactRole: "property_manager",
        name: "Created Lead",
        source: "Referral",
        officeCode: "dfw",
        projectTypeId: "project-type-commercial",
        budgetStatus: "budgeted_q1",
        bidDueDate: "2026-02-31",
      } as never)
    ).rejects.toMatchObject({
      code: "LEAD_CREATE_REQUIREMENTS_UNMET",
      missingRequirements: {
        fields: expect.arrayContaining([expect.objectContaining({ key: "bidDueDate" })]),
      },
    });
    expect(tenantDb.state.leads).toHaveLength(0);
  });

  it("creates a lead with bidDueDate when lead edit v2 is disabled without writing V2 answers", async () => {
    const previousFlag = process.env.ENABLE_LEAD_EDIT_V2;
    process.env.ENABLE_LEAD_EDIT_V2 = "false";
    const tenantDb = createFakeTenantDb({} as FakeLeadRow);
    tenantDb.state.leads = [];
    const service = createLeadService({
      getStageById: pipelineMocks.getStageById as never,
      getActiveProjectTypes: pipelineMocks.getActiveProjectTypes as never,
      now: () => new Date("2026-04-15T15:00:00.000Z"),
    });

    try {
      const lead = await service.createLead(tenantDb as never, {
        companyId: "company-1",
        propertyId: "property-1",
        stageId: newLeadStage.id,
        assignedRepId: "rep-1",
        officeId: "office-1",
        primaryContactId: "contact-1",
        primaryContactRole: "property_manager",
        name: "Created Lead",
        source: "Referral",
        officeCode: "dfw",
        projectTypeId: "project-type-commercial",
        budgetStatus: "budgeted_q1",
        bidDueDate: "2026-06-01",
      } as never);

      expect(lead.bidDueDate).toBe("2026-06-01");
      expect(tenantDb.state.leads[0]?.bidDueDate).toBe("2026-06-01");
      expect(tenantDb.state.leadQuestionAnswers).toHaveLength(0);
      expect(tenantDb.state.leadQuestionAnswerHistory).toHaveLength(0);
    } finally {
      if (previousFlag === undefined) delete process.env.ENABLE_LEAD_EDIT_V2;
      else process.env.ENABLE_LEAD_EDIT_V2 = previousFlag;
    }
  });

  it("mirrors bidDueDate to V2 lead_question_answers when lead edit v2 is enabled", async () => {
    const previousFlag = process.env.ENABLE_LEAD_EDIT_V2;
    process.env.ENABLE_LEAD_EDIT_V2 = "true";
    const tenantDb = createFakeTenantDb({} as FakeLeadRow);
    tenantDb.state.leads = [];
    const service = createLeadService({
      getStageById: pipelineMocks.getStageById as never,
      getActiveProjectTypes: pipelineMocks.getActiveProjectTypes as never,
      now: () => new Date("2026-04-15T15:00:00.000Z"),
    });

    try {
      const lead = await service.createLead(tenantDb as never, {
        companyId: "company-1",
        propertyId: "property-1",
        stageId: newLeadStage.id,
        assignedRepId: "rep-1",
        officeId: "office-1",
        primaryContactId: "contact-1",
        primaryContactRole: "property_manager",
        name: "Created Lead",
        source: "Referral",
        officeCode: "dfw",
        projectTypeId: "project-type-commercial",
        budgetStatus: "budgeted_q1",
        bidDueDate: "2026-06-01",
      } as never);

      expect(lead.bidDueDate).toBe("2026-06-01");
      expect(tenantDb.state.leadQuestionAnswers).toEqual([
        expect.objectContaining({
          leadId: lead.id,
          questionId: "node-bid-due-date",
          valueJson: "2026-06-01",
        }),
      ]);
      expect(tenantDb.state.leadQuestionAnswerHistory).toEqual([
        expect.objectContaining({
          leadId: lead.id,
          questionId: "node-bid-due-date",
          oldValueJson: null,
          newValueJson: "2026-06-01",
        }),
      ]);
    } finally {
      if (previousFlag === undefined) delete process.env.ENABLE_LEAD_EDIT_V2;
      else process.env.ENABLE_LEAD_EDIT_V2 = previousFlag;
    }
  });

  it("persists qualification payload updates when lead edit v2 is enabled", async () => {
    const previousFlag = process.env.ENABLE_LEAD_EDIT_V2;
    process.env.ENABLE_LEAD_EDIT_V2 = "true";

    const tenantDb = createFakeTenantDb({
      id: "lead-1",
      companyId: "company-1",
      propertyId: "property-1",
      primaryContactId: null,
      name: "Palm Villas repaint",
      stageId: newLeadStage.id,
      assignedRepId: "rep-1",
      status: "open",
      projectTypeId: "project-type-commercial",
      qualificationPayload: {
        existing_customer_status: "existing",
        estimated_value: 50000,
        timeline_status: "Q1 2026",
      },
      projectTypeQuestionPayload: {
        projectTypeId: "project-type-commercial",
        answers: {},
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

    try {
      const lead = await service.updateLead(
        tenantDb as never,
        "lead-1",
        {
          qualificationPayload: {
            existing_customer_status: "existing",
            estimated_value: 175000,
            timeline_status: "2026-09-15",
          },
        },
        "director",
        "director-1"
      );

      expect(lead.qualificationPayload).toEqual({
        existing_customer_status: "existing",
        estimated_value: 175000,
        timeline_status: "2026-09-15",
      });
      expect(tenantDb.state.leads[0]?.qualificationPayload).toEqual({
        existing_customer_status: "existing",
        estimated_value: 175000,
        timeline_status: "2026-09-15",
      });
    } finally {
      if (previousFlag === undefined) {
        delete process.env.ENABLE_LEAD_EDIT_V2;
      } else {
        process.env.ENABLE_LEAD_EDIT_V2 = previousFlag;
      }
    }
  });

  it("persists nullable salesRepId updates separately from assignedRepId", async () => {
    const tenantDb = createFakeTenantDb({
      id: "lead-1",
      companyId: "company-1",
      propertyId: "property-1",
      primaryContactId: null,
      name: "Palm Villas repaint",
      stageId: newLeadStage.id,
      assignedRepId: "rep-1",
      salesRepId: "rep-1",
      status: "open",
      projectTypeId: "project-type-commercial",
      qualificationPayload: {},
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
      { salesRepId: null },
      "director",
      "director-1"
    );

    expect(lead.salesRepId).toBeNull();
    expect(lead.assignedRepId).toBe("rep-1");
  });

  it("skips the bid_due_date V2 mirror when that node is not active during update", async () => {
    const previousFlag = process.env.ENABLE_LEAD_EDIT_V2;
    process.env.ENABLE_LEAD_EDIT_V2 = "true";
    const tenantDb = createFakeTenantDb({
      id: "lead-1",
      companyId: "company-1",
      propertyId: "property-1",
      primaryContactId: "contact-1",
      name: "Palm Villas repaint",
      stageId: newLeadStage.id,
      assignedRepId: "rep-1",
      salesRepId: "rep-1",
      status: "open",
      source: "Referral",
      projectTypeId: "project-type-commercial",
      bidDueDate: "2026-06-01",
      qualificationPayload: {},
      description: null,
      stageEnteredAt: new Date("2026-04-12T15:00:00.000Z"),
      convertedAt: null,
      isActive: true,
      createdAt: new Date("2026-04-12T15:00:00.000Z"),
      updatedAt: new Date("2026-04-12T15:00:00.000Z"),
    });
    tenantDb.state.projectTypes = [{ id: "project-type-commercial", name: "Commercial", slug: "commercial", parentId: null }];
    tenantDb.state.projectTypeQuestionNodes = [];
    const service = createLeadService({
      getStageById: pipelineMocks.getStageById as never,
      getActiveProjectTypes: pipelineMocks.getActiveProjectTypes as never,
      now: () => new Date("2026-04-15T15:00:00.000Z"),
    });

    try {
      const lead = await service.updateLead(
        tenantDb as never,
        "lead-1",
        { bidDueDate: "2026-07-15" },
        "director",
        "director-1"
      );

      expect(lead.bidDueDate).toBe("2026-07-15");
      expect(tenantDb.state.leadQuestionAnswers).toHaveLength(0);
      expect(tenantDb.state.leadQuestionAnswerHistory).toHaveLength(0);
    } finally {
      if (previousFlag === undefined) delete process.env.ENABLE_LEAD_EDIT_V2;
      else process.env.ENABLE_LEAD_EDIT_V2 = previousFlag;
    }
  });

  it("routes an existing-customer lead to qualified_lead during creation", async () => {
    const previousFlag = process.env.ENABLE_LEAD_EDIT_V2;
    process.env.ENABLE_LEAD_EDIT_V2 = "true";

    const insertedLeads: Array<Record<string, unknown>> = [];
    const insertedHistory: Array<Record<string, unknown>> = [];
    const tenantDb = {
      execute: vi.fn(async () => ({
        rows: [{
          source: "company",
          type: "deal",
          occurred_at: new Date("2026-04-01T00:00:00.000Z"),
          detail: "Recent deal activity on company",
        }],
      })),
      select() {
        return {
          from(table: unknown) {
            const rows =
              table === companies
                ? [{ id: "company-1", isActive: true }]
                : table === properties
                  ? [{ id: "property-1", companyId: "company-1", isActive: true, address: "123 Main", city: "Dallas", state: "TX", zip: "75001", buildYear: 2001, unitCount: 80 }]
                  : table === contacts
                    ? [{ id: "contact-1", companyId: "company-1", isActive: true }]
                  : table === projectTypeQuestionNodes
                    ? [{ id: "node-bid-due-date", projectTypeId: null, parentNodeId: null, parentOptionValue: null, nodeType: "question", key: "bid_due_date", label: "Bid Due Date", prompt: null, inputType: "date", options: [], isRequired: true, displayOrder: 10, isActive: true }]
                  : table === leadQuestionAnswers
                    ? []
                  : table === users
                    ? [{ id: "rep-1", isActive: true, officeId: "office-1" }]
                  : table === notificationRecipientGroups || table === notificationRecipientAssignments
                    ? []
                    : [];
            return {
              innerJoin() { return this; },
              where() { return this; },
              limit() { return this; },
              then(onfulfilled: (value: unknown[]) => unknown) {
                return Promise.resolve(rows.map((row) => ({ ...row }))).then(onfulfilled);
              },
            };
          },
        };
      },
      insert(table: unknown) {
        return {
          values(value: Record<string, unknown>) {
            if (table === leadDueDiligenceApprovals) {
              return { returning: () => Promise.resolve([{ id: "lead-dd-approval-1", ...value }]) };
            }
            if (table === leads) {
              const insertedRow = { id: "lead-created", convertedAt: null, ...value };
              insertedLeads.push(insertedRow);
              return { returning: () => Promise.resolve([{ ...insertedRow }]) };
            }
            if (table === leadStageHistory) {
              insertedHistory.push(value);
              return { returning: () => Promise.resolve([{ id: "lsh-1", ...value }]) };
            }
            if (table === leadQuestionAnswerHistory || table === leadQuestionAnswers) {
              return { returning: () => Promise.resolve([{ id: "question-row-1", ...value }]) };
            }
            throw new Error(`Unexpected insert table: ${String((table as { _: { name?: string } })?._?.name)}`);
          },
        };
      },
    };

    const getStageBySlugMock = vi.fn(async (slug: string) =>
      slug === "qualified_lead" ? qualifiedLeadStage : null
    );
    const service = createLeadService({
      getStageById: pipelineMocks.getStageById as never,
      getStageBySlug: getStageBySlugMock as never,
      getActiveProjectTypes: pipelineMocks.getActiveProjectTypes as never,
      now: () => new Date("2026-04-27T12:00:00.000Z"),
    });

    try {
      const lead = await service.createLead(tenantDb as never, {
        companyId: "company-1",
        propertyId: "property-1",
        stageId: newLeadStage.id,
        assignedRepId: "rep-1",
        officeId: "office-1",
        primaryContactId: "contact-1",
        primaryContactRole: "property_manager",
        name: "Active-customer Lead",
        source: "Referral",
        officeCode: "dfw",
        projectType: "commercial",
        projectTypeId: "project-type-commercial",
        budgetStatus: "budgeted_q1",
        bidDueDate: "2026-06-01",
        qualificationPayload: {},
      });

      expect(lead.stageId).toBe(qualifiedLeadStage.id);
      expect(lead.verificationStatus).toBe("not_required");
      expect(lead.verificationRequiredReason).toBeNull();
      expect(insertedHistory).toHaveLength(0);
      expect(getStageBySlugMock).toHaveBeenCalledWith("qualified_lead", "lead");
    } finally {
      if (previousFlag === undefined) delete process.env.ENABLE_LEAD_EDIT_V2;
      else process.env.ENABLE_LEAD_EDIT_V2 = previousFlag;
    }
  });

  it("flags a new lead as pending verification when the company has no recent activity", async () => {
    const previousFlag = process.env.ENABLE_LEAD_EDIT_V2;
    process.env.ENABLE_LEAD_EDIT_V2 = "true";

    const insertedLeads: Array<Record<string, unknown>> = [];
    const insertedHistory: Array<Record<string, unknown>> = [];
    const tenantDb = {
      execute: vi.fn(async () => ({ rows: [] })),
      select() {
        return {
          from(table: unknown) {
            const rows =
              table === companies
                ? [{ id: "company-1", isActive: true }]
                : table === properties
                  ? [{ id: "property-1", companyId: "company-1", isActive: true, address: "123 Main", city: "Dallas", state: "TX", zip: "75001", buildYear: 2001, unitCount: 80 }]
                  : table === contacts
                    ? [{ id: "contact-1", companyId: "company-1", isActive: true }]
                  : table === projectTypeQuestionNodes
                    ? [{ id: "node-bid-due-date", projectTypeId: null, parentNodeId: null, parentOptionValue: null, nodeType: "question", key: "bid_due_date", label: "Bid Due Date", prompt: null, inputType: "date", options: [], isRequired: true, displayOrder: 10, isActive: true }]
                  : table === leadQuestionAnswers
                    ? []
                  : table === users
                    ? [{ id: "rep-1", isActive: true, officeId: "office-1" }]
                  : table === notificationRecipientGroups || table === notificationRecipientAssignments
                    ? []
                    : [];
            return {
              innerJoin() { return this; },
              where() { return this; },
              limit() { return this; },
              then(onfulfilled: (value: unknown[]) => unknown) {
                return Promise.resolve(rows.map((row) => ({ ...row }))).then(onfulfilled);
              },
            };
          },
        };
      },
      insert(table: unknown) {
        return {
          values(value: Record<string, unknown>) {
            if (table === leadDueDiligenceApprovals) {
              return { returning: () => Promise.resolve([{ id: "lead-dd-approval-1", ...value }]) };
            }
            if (table === leads) {
              const insertedRow = { id: "lead-created", convertedAt: null, ...value };
              insertedLeads.push(insertedRow);
              return { returning: () => Promise.resolve([{ ...insertedRow }]) };
            }
            if (table === leadStageHistory) {
              insertedHistory.push(value);
              return { returning: () => Promise.resolve([{ id: "lsh-1", ...value }]) };
            }
            if (table === leadQuestionAnswerHistory || table === leadQuestionAnswers) {
              return { returning: () => Promise.resolve([{ id: "question-row-1", ...value }]) };
            }
            throw new Error(`Unexpected insert table: ${String((table as { _: { name?: string } })?._?.name)}`);
          },
        };
      },
    };

    const getStageBySlugMock = vi.fn(async () => qualifiedLeadStage);
    const service = createLeadService({
      getStageById: pipelineMocks.getStageById as never,
      getStageBySlug: getStageBySlugMock as never,
      getActiveProjectTypes: pipelineMocks.getActiveProjectTypes as never,
      now: () => new Date("2026-04-27T12:00:00.000Z"),
    });

    try {
      const lead = await service.createLead(tenantDb as never, {
        companyId: "company-1",
        propertyId: "property-1",
        stageId: newLeadStage.id,
        assignedRepId: "rep-1",
        officeId: "office-1",
        primaryContactId: "contact-1",
        primaryContactRole: "property_manager",
        name: "Brand-new Company Lead",
        source: "Data Mine",
        officeCode: "dfw",
        projectType: "commercial",
        projectTypeId: "project-type-commercial",
        budgetStatus: "not_budgeted",
        bidDueDate: "2026-06-01",
        qualificationPayload: {},
      });

      expect(lead.stageId).toBe(newLeadStage.id);
      expect(lead.verificationStatus).toBe("pending");
      expect(lead.verificationRequiredReason).toBe("new_company");
      expect(insertedHistory).toHaveLength(0);
      expect(getStageBySlugMock).not.toHaveBeenCalled();
    } finally {
      if (previousFlag === undefined) delete process.env.ENABLE_LEAD_EDIT_V2;
      else process.env.ENABLE_LEAD_EDIT_V2 = previousFlag;
    }
  });

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

  it("allows moving into Qualified Lead when source, project type, and existing customer status were already saved", async () => {
    const tenantDb = createFakeTenantDb({
      id: "lead-1",
      companyId: "company-1",
      propertyId: "property-1",
      primaryContactId: null,
      name: "Palm Villas repaint",
      stageId: newLeadStage.id,
      assignedRepId: "rep-1",
      status: "open",
      projectTypeId: "project-type-commercial",
      qualificationPayload: {
        existing_customer_status: "existing",
      },
      projectTypeQuestionPayload: {
        projectTypeId: "project-type-commercial",
        answers: {},
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
      { stageId: qualifiedLeadStage.id },
      "director",
      "director-1"
    );

    expect(lead.stageId).toBe(qualifiedLeadStage.id);
    expect(tenantDb.state.leadStageHistory).toEqual([
      expect.objectContaining({
        leadId: "lead-1",
        fromStageId: newLeadStage.id,
        toStageId: qualifiedLeadStage.id,
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

  it("writes a rich audit_log entry for lead create when audit context is present", async () => {
    const tenantDb = createFakeTenantDb({} as FakeLeadRow);
    tenantDb.state.leads = [];
    const service = createLeadService({
      getStageById: pipelineMocks.getStageById as never,
      getActiveProjectTypes: pipelineMocks.getActiveProjectTypes as never,
      now: () => new Date("2026-04-15T15:00:00.000Z"),
    });

    const lead = await service.createLead(tenantDb as never, {
      companyId: "company-1",
      propertyId: "property-1",
      stageId: newLeadStage.id,
      assignedRepId: "rep-1",
      officeId: "office-1",
      primaryContactId: "contact-1",
      primaryContactRole: "property_manager",
      name: "Created Lead",
      source: "Referral",
      officeCode: "dfw",
      projectTypeId: "project-type-commercial",
      budgetStatus: "budgeted_q1",
      bidDueDate: "2026-06-01",
      auditContext: {
        actor: {
          type: "user",
          userId: "admin-1",
          name: "Admin User",
          role: "admin",
        },
      },
    } as never);

    expect(lead.id).toBeTruthy();
    expect(tenantDb.state.auditLog).toEqual([
      expect.objectContaining({
        tableName: "leads",
        recordId: lead.id,
        action: "insert",
        actorName: "Admin User",
        entityType: "lead",
        entityNameSnapshot: "Created Lead for Palm Villas",
        fieldChangesJsonb: expect.arrayContaining([
          expect.objectContaining({ key: "name", toDisplay: "Created Lead" }),
          expect.objectContaining({ key: "status", toDisplay: "Open" }),
        ]),
      }),
    ]);
  });

  it("writes a rich audit_log entry for lead updates when audit context is present", async () => {
    const tenantDb = createFakeTenantDb({
      id: "lead-1",
      companyId: "company-1",
      propertyId: "property-1",
      primaryContactId: null,
      name: "Palm Villas repaint",
      stageId: newLeadStage.id,
      assignedRepId: "rep-1",
      status: "open",
      projectTypeId: "project-type-commercial",
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

    await service.updateLead(
      tenantDb as never,
      "lead-1",
      {
        description: "Updated lead note",
        auditContext: {
          actor: {
            type: "user",
            userId: "director-1",
            name: "Director User",
            role: "director",
          },
        },
      },
      "director",
      "director-1"
    );

    expect(tenantDb.state.auditLog).toEqual([
      expect.objectContaining({
        tableName: "leads",
        recordId: "lead-1",
        action: "update",
        actorName: "Director User",
        entityNameSnapshot: "Palm Villas repaint for Palm Villas",
        fieldChangesJsonb: [
          expect.objectContaining({
            key: "description",
            fromDisplay: null,
            toDisplay: "Updated lead note",
          }),
        ],
      }),
    ]);
  });
});
