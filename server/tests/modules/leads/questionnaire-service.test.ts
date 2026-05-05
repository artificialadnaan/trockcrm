import { projectTypeConfig, projectTypeQuestionNodes } from "@trock-crm/shared/schema";
import { describe, expect, it, vi } from "vitest";
import { getQuestionnaireTemplateSnapshot } from "../../../src/modules/leads/questionnaire-service.js";

vi.mock("@trock-crm/shared/schema", async () => import("../../../../shared/src/schema/index.js"));

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
