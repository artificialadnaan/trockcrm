import { describe, expect, it } from "vitest";
import {
  getValidationQuestionSetForProjectType,
  getValidationQuestionSetQuestionIds,
  getVisibleValidationQuestions,
} from "./validation-question-sets";

describe("validation-question-sets", () => {
  it("returns deterministic ordered questions for each project type family", () => {
    expect(getValidationQuestionSetQuestionIds("service")).toEqual([
      "service_line",
      "service_urgency",
      "site_contact_available",
      "active_issue_summary",
      "service_request_value",
    ]);
    expect(getValidationQuestionSetQuestionIds("commercial")).toEqual([
      "project_scope",
      "decision_maker",
      "budget_status",
      "timeline_target",
      "incumbent_vendor",
    ]);
  });

  it("uses the parent question set for child project types and defaults to normal when unknown", () => {
    expect(getValidationQuestionSetQuestionIds("new_construction")).toEqual([
      "project_scope",
      "decision_maker",
      "budget_status",
      "timeline_target",
      "incumbent_vendor",
    ]);
    expect(getValidationQuestionSetQuestionIds("unknown")).toEqual([
      "project_scope",
      "decision_maker",
      "budget_status",
      "timeline_target",
      "incumbent_vendor",
    ]);
  });

  it("exposes prompt metadata for client rendering without changing order", () => {
    const set = getValidationQuestionSetForProjectType("service");
    const visible = getVisibleValidationQuestions("service");

    expect(set.title).toBe("Top 5 Questions");
    expect(visible).toHaveLength(5);
    expect(visible[0]).toMatchObject({
      id: "service_line",
      input: "text",
    });
    expect(visible.map((question) => question.id)).toEqual(
      set.questions.map((question) => question.id)
    );
  });
});
