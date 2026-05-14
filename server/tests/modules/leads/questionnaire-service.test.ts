import {
  leadQuestionAnswerHistory,
  leadQuestionAnswers,
  projectTypeConfig,
  projectTypeQuestionNodes,
} from "@trock-crm/shared/schema";
import { describe, expect, it, vi } from "vitest";
import {
  evaluateLeadQuestionGate,
  getLeadQuestionnaireSnapshot,
  getQuestionnaireTemplateSnapshot,
  listMissingRequiredQuestionKeys,
  listQuestionnaireNodes,
  upsertLeadQuestionAnswerSet,
} from "../../../src/modules/leads/questionnaire-service.js";

vi.mock("@trock-crm/shared/schema", async () => import("../../../../shared/src/schema/index.js"));

function node(overrides: Partial<typeof projectTypeQuestionNodes.$inferSelect>) {
  return {
    id: "node-id",
    projectTypeId: null,
    parentNodeId: null,
    parentOptionValue: null,
    nodeType: "question",
    key: "question",
    label: "Question",
    prompt: null,
    inputType: "text",
    options: [],
    isRequired: false,
    displayOrder: 0,
    sectionKey: "baseline",
    groupKey: "baseline",
    groupLabel: "Universal Baseline",
    groupOrder: 0,
    isActive: true,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function createReadDb(input: {
  nodes: Array<typeof projectTypeQuestionNodes.$inferSelect>;
  answers?: Array<typeof leadQuestionAnswers.$inferSelect>;
}) {
  return {
    select() {
      return {
        from(table: unknown) {
          const rows =
            table === projectTypeConfig
              ? []
              : table === projectTypeQuestionNodes
                ? input.nodes
                : table === leadQuestionAnswers
                  ? input.answers ?? []
                  : [];
          const promise = Promise.resolve(rows);
          return {
            where() {
              return promise;
            },
            then: promise.then.bind(promise),
            catch: promise.catch.bind(promise),
            finally: promise.finally.bind(promise),
          };
        },
      };
    },
  };
}

function createMutationDb(input: {
  nodes: Array<typeof projectTypeQuestionNodes.$inferSelect>;
  answers?: Array<typeof leadQuestionAnswers.$inferSelect>;
}) {
  const answers = [...(input.answers ?? [])];
  const history: Array<Record<string, unknown>> = [];
  return {
    answers,
    history,
    select() {
      return {
        from(table: unknown) {
          const rows =
            table === projectTypeConfig
              ? []
              : table === projectTypeQuestionNodes
                ? input.nodes
                : table === leadQuestionAnswers
                  ? answers
                  : [];
          const promise = Promise.resolve(rows);
          return {
            where() {
              return promise;
            },
            then: promise.then.bind(promise),
            catch: promise.catch.bind(promise),
            finally: promise.finally.bind(promise),
          };
        },
      };
    },
    insert(table: unknown) {
      return {
        async values(value: Record<string, unknown>) {
          if (table === leadQuestionAnswerHistory) {
            history.push(value);
            return;
          }
          if (table === leadQuestionAnswers) {
            answers.push({
              id: `answer-${answers.length + 1}`,
              leadId: value.leadId as string,
              questionId: value.questionId as string,
              valueJson: value.valueJson,
              updatedBy: (value.updatedBy as string | null) ?? null,
              createdAt: value.createdAt as Date,
              updatedAt: value.updatedAt as Date,
            });
          }
        },
      };
    },
    update() {
      return {
        set() {
          return {
            async where() {
              return;
            },
          };
        },
      };
    },
  };
}

describe("questionnaire-service create template", () => {
  it("suppresses superseded create-gate nodes and makes number of bidders optional", async () => {
    const tenantDb = {
      select() {
        return {
          from(table: unknown) {
            const rows =
              table === projectTypeConfig
                ? []
                : table === projectTypeQuestionNodes
                  ? [
                      {
                        id: "node-poc",
                        projectTypeId: null,
                        parentNodeId: null,
                        parentOptionValue: null,
                        nodeType: "question",
                        key: "poc",
                        label: "POC",
                        prompt: null,
                        inputType: "text",
                        options: [],
                        isRequired: true,
                        displayOrder: 10,
                        isActive: true,
                      },
                      {
                        id: "node-number-of-bidders",
                        projectTypeId: null,
                        parentNodeId: null,
                        parentOptionValue: null,
                        nodeType: "question",
                        key: "number_of_bidders",
                        label: "Number of Bidders",
                        prompt: null,
                        inputType: "number",
                        options: [],
                        isRequired: true,
                        displayOrder: 20,
                        isActive: true,
                      },
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
                        displayOrder: 30,
                        isActive: true,
                      },
                    ]
                  : [];
            return Promise.resolve(rows);
          },
        };
      },
    };

    const template = await getQuestionnaireTemplateSnapshot(tenantDb as never, null);

    expect(template.nodes.map((node) => node.key)).toEqual(["number_of_bidders"]);
    expect(template.nodes.find((node) => node.key === "number_of_bidders")).toMatchObject({
      isRequired: false,
    });
    expect(template.allNodes.map((node) => node.key)).toEqual(["number_of_bidders"]);
  });
});

describe("questionnaire-service universal questionnaire", () => {
  it("returns only active universal nodes with section and group metadata", async () => {
    const tenantDb = createReadDb({
      nodes: [
        node({ id: "baseline", key: "budget", sectionKey: "baseline", displayOrder: 200 }),
        node({
          id: "scope",
          key: "roofing_applies",
          sectionKey: "scope",
          groupKey: "roofing",
          groupLabel: "Roofing",
          groupOrder: 1,
          displayOrder: 0,
        }),
        node({ id: "inactive", key: "legacy", isActive: false }),
        node({ id: "typed", key: "legacy_roof", projectTypeId: "type-1" }),
      ],
    });

    const nodes = await listQuestionnaireNodes(tenantDb as never);

    expect(nodes.map((entry) => entry.key)).toEqual(["budget", "roofing_applies"]);
    expect(nodes[1]).toMatchObject({
      sectionKey: "scope",
      groupKey: "roofing",
      groupLabel: "Roofing",
      groupOrder: 1,
    });
  });

  it("returns legacy answers separately from active universal answers", async () => {
    const tenantDb = createReadDb({
      nodes: [
        node({ id: "active-budget", key: "budget", isActive: true, projectTypeId: null }),
        node({
          id: "legacy-roof",
          key: "roof_age_years",
          label: "Roof Age Years",
          isActive: false,
          projectTypeId: "type-1",
        }),
      ],
      answers: [
        {
          id: "answer-active",
          leadId: "lead-1",
          questionId: "active-budget",
          valueJson: 150000,
          updatedBy: null,
          createdAt: new Date("2026-01-01T00:00:00Z"),
          updatedAt: new Date("2026-01-01T00:00:00Z"),
        },
        {
          id: "answer-legacy",
          leadId: "lead-1",
          questionId: "legacy-roof",
          valueJson: "15",
          updatedBy: null,
          createdAt: new Date("2026-01-01T00:00:00Z"),
          updatedAt: new Date("2026-01-01T00:00:00Z"),
        },
      ],
    });

    const snapshot = await getLeadQuestionnaireSnapshot(tenantDb as never, {
      leadId: "lead-1",
      projectTypeId: "type-1",
    });

    expect(snapshot.answers).toEqual({ budget: 150000 });
    expect(snapshot.legacyAnswers).toEqual([
      expect.objectContaining({
        key: "roof_age_years",
        label: "Roof Age Years",
        value: "15",
      }),
    ]);
  });

  it("treats multi-select arrays as answered only when they contain a value", () => {
    const nodes = [
      node({
        id: "parking-applies",
        key: "parking_lot_applies",
        inputType: "boolean",
        sectionKey: "scope",
        groupKey: "parking_lot",
      }),
      node({
        id: "parking-surface",
        key: "parking_surface_type",
        inputType: "multiselect",
        isRequired: true,
        parentNodeId: "parking-applies",
        parentOptionValue: "true",
        sectionKey: "scope",
        groupKey: "parking_lot",
      }),
    ];

    expect(
      listMissingRequiredQuestionKeys(nodes, {
        parking_lot_applies: true,
        parking_surface_type: [],
      })
    ).toEqual(["parking_surface_type"]);
    expect(
      listMissingRequiredQuestionKeys(nodes, {
        parking_lot_applies: true,
        parking_surface_type: ["concrete"],
      })
    ).toEqual([]);
  });

  it("flags no satisfied scope accordion until one applies group is complete", async () => {
    const tenantDb = createReadDb({
      nodes: [
        node({ id: "budget", key: "budget", isRequired: true, sectionKey: "baseline" }),
        node({
          id: "roofing-applies",
          key: "roofing_applies",
          inputType: "boolean",
          sectionKey: "scope",
          groupKey: "roofing",
          groupOrder: 1,
          displayOrder: 0,
        }),
        node({
          id: "roof-type",
          key: "roof_type",
          isRequired: true,
          parentNodeId: "roofing-applies",
          parentOptionValue: "true",
          sectionKey: "scope",
          groupKey: "roofing",
          groupOrder: 1,
          displayOrder: 1,
        }),
      ],
      answers: [],
    });

    const missing = await evaluateLeadQuestionGate(tenantDb as never, {
      leadId: "lead-1",
      projectTypeId: null,
      qualificationPayload: {
        estimated_value: 100000,
        timeline_status: "2026-08-01",
      },
      existingCustomerStatus: "Existing",
      leadQuestionAnswers: {
        budget: 50000,
        roofing_applies: true,
        roof_type: "TPO",
      },
    });

    expect(missing.projectTypeQuestionIds).toEqual([]);
    expect(missing.missingScopeSelection).toBe(false);
  });

  it("saves and loads multi-select array answers through valueJson", async () => {
    const tenantDb = createMutationDb({
      nodes: [
        node({
          id: "parking-surface",
          key: "parking_surface_type",
          inputType: "multiselect",
          isRequired: true,
          sectionKey: "scope",
          groupKey: "parking_lot",
        }),
      ],
    });

    const wrote = await upsertLeadQuestionAnswerSet(tenantDb as never, {
      leadId: "lead-1",
      projectTypeId: null,
      changedBy: "user-1",
      changedAt: new Date("2026-01-02T00:00:00Z"),
      answers: {
        parking_surface_type: ["concrete", "asphalt"],
      },
    });
    const snapshot = await getLeadQuestionnaireSnapshot(tenantDb as never, {
      leadId: "lead-1",
      projectTypeId: null,
    });

    expect(wrote).toBe(true);
    expect(snapshot.answers).toEqual({
      parking_surface_type: ["concrete", "asphalt"],
    });
    expect(tenantDb.history).toHaveLength(1);
  });

  it("saves empty multi-select arrays as an unanswered value", async () => {
    const tenantDb = createMutationDb({
      nodes: [
        node({
          id: "parking-surface",
          key: "parking_surface_type",
          inputType: "multiselect",
          isRequired: true,
          sectionKey: "scope",
          groupKey: "parking_lot",
        }),
      ],
    });

    await expect(
      upsertLeadQuestionAnswerSet(tenantDb as never, {
        leadId: "lead-1",
        projectTypeId: null,
        changedBy: "user-1",
        changedAt: new Date("2026-01-02T00:00:00Z"),
        answers: {
          parking_surface_type: [],
        },
      })
    ).resolves.toBe(true);

    expect(tenantDb.answers[0]?.valueJson).toEqual([]);
  });

  it("rejects string values for boolean questionnaire answers", async () => {
    const tenantDb = createMutationDb({
      nodes: [
        node({
          id: "life-safety",
          key: "life_safety",
          inputType: "boolean",
          isRequired: true,
        }),
      ],
    });

    await expect(
      upsertLeadQuestionAnswerSet(tenantDb as never, {
        leadId: "lead-1",
        projectTypeId: null,
        changedBy: "user-1",
        changedAt: new Date("2026-01-02T00:00:00Z"),
        answers: {
          life_safety: "true" as never,
        },
      })
    ).rejects.toMatchObject({
      statusCode: 400,
      message: "Boolean answer life_safety must be true or false.",
    });

    expect(tenantDb.answers).toHaveLength(0);
  });

  it("rejects malformed multi-select array answers", async () => {
    const tenantDb = createMutationDb({
      nodes: [
        node({
          id: "parking-surface",
          key: "parking_surface_type",
          inputType: "multiselect",
          isRequired: true,
          sectionKey: "scope",
          groupKey: "parking_lot",
        }),
      ],
    });

    await expect(
      upsertLeadQuestionAnswerSet(tenantDb as never, {
        leadId: "lead-1",
        projectTypeId: null,
        changedBy: "user-1",
        changedAt: new Date("2026-01-02T00:00:00Z"),
        answers: {
          parking_surface_type: [["concrete"]] as never,
        },
      })
    ).rejects.toMatchObject({
      statusCode: 400,
      message: "Multi-select answer parking_surface_type must be an array of strings.",
    });

    await expect(
      upsertLeadQuestionAnswerSet(tenantDb as never, {
        leadId: "lead-1",
        projectTypeId: null,
        changedBy: "user-1",
        changedAt: new Date("2026-01-02T00:00:00Z"),
        answers: {
          parking_surface_type: [1, 2] as never,
        },
      })
    ).rejects.toMatchObject({
      statusCode: 400,
      message: "Multi-select answer parking_surface_type must be an array of strings.",
    });

    expect(tenantDb.answers).toHaveLength(0);
  });
});
