import { describe, expect, it } from "vitest";
import {
  CLEAR_SELECTION_VALUE,
  normalizeStoredQuestionAnswers,
  sanitizeQuestionAnswerForSave,
} from "./questionnaire-answer-normalization";
import type { LeadQuestionnaireNode } from "@/hooks/use-leads";

function makeQuestionNode(
  overrides: Partial<LeadQuestionnaireNode> & Pick<LeadQuestionnaireNode, "id" | "key" | "label">
): LeadQuestionnaireNode {
  return {
    projectTypeId: null,
    parentNodeId: null,
    parentOptionValue: null,
    nodeType: "question",
    prompt: null,
    inputType: "text",
    options: [],
    isRequired: false,
    displayOrder: 0,
    sectionKey: "baseline",
    groupKey: null,
    groupLabel: null,
    groupOrder: null,
    isActive: true,
    ...overrides,
  };
}

describe("questionnaire answer normalization", () => {
  it("normalizes stored __unanswered__ values only for typed dropdown and boolean questions", () => {
    const dropdownNode = makeQuestionNode({
      id: "market-type",
      key: "market_type",
      label: "Market Type",
      inputType: "select",
      options: [{ value: "conventional", label: "Conventional" }],
    });
    const textNode = makeQuestionNode({
      id: "project-notes",
      key: "project_notes",
      label: "Project Notes",
      inputType: "textarea",
    });

    const normalized = normalizeStoredQuestionAnswers(
      {
        market_type: "__unanswered__",
        project_notes: "__unanswered__",
      },
      [dropdownNode, textNode]
    );

    expect(normalized.market_type).toBeNull();
    expect(normalized.project_notes).toBe("__unanswered__");
  });

  it("maps clear sentinel values to null for optional selects and booleans", () => {
    const selectNode = makeQuestionNode({
      id: "building-type",
      key: "building_type",
      label: "Building Type",
      inputType: "select",
      options: [{ value: "garden", label: "Garden" }],
    });
    const booleanNode = makeQuestionNode({
      id: "life-safety",
      key: "life_safety",
      label: "Life Safety",
      inputType: "boolean",
    });

    expect(sanitizeQuestionAnswerForSave(selectNode, CLEAR_SELECTION_VALUE)).toBeNull();
    expect(sanitizeQuestionAnswerForSave(booleanNode, CLEAR_SELECTION_VALUE)).toBeNull();
  });

  it("preserves literal __unanswered__ in free-text answers", () => {
    const textNode = makeQuestionNode({
      id: "project-notes",
      key: "project_notes",
      label: "Project Notes",
      inputType: "textarea",
    });

    expect(sanitizeQuestionAnswerForSave(textNode, "__unanswered__")).toBe("__unanswered__");
  });
});
