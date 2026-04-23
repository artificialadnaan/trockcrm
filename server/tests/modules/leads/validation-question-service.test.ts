import { describe, expect, it } from "vitest";
import {
  getLeadValidationQuestionSet,
  listRequiredLeadQuestionIds,
} from "../../../src/modules/leads/validation-question-service.js";

describe("validation-question-service", () => {
  it("returns different Top 5 question sets for service and normal project types", () => {
    const serviceSet = getLeadValidationQuestionSet("service");
    const commercialSet = getLeadValidationQuestionSet("commercial");

    expect(serviceSet.title).toBe("Top 5 Questions");
    expect(commercialSet.title).toBe("Top 5 Questions");
    expect(serviceSet.questions).toHaveLength(5);
    expect(commercialSet.questions).toHaveLength(5);
    expect(serviceSet.questions.map((question) => question.id)).not.toEqual(
      commercialSet.questions.map((question) => question.id)
    );
    expect(serviceSet.questions.map((question) => question.id)).toEqual([
      "service_line",
      "service_urgency",
      "site_contact_available",
      "active_issue_summary",
      "service_request_value",
    ]);
    expect(commercialSet.questions.map((question) => question.id)).toEqual([
      "project_scope",
      "decision_maker",
      "budget_status",
      "timeline_target",
      "incumbent_vendor",
    ]);
  });

  it("falls back to the parent project type set for child slugs", () => {
    expect(listRequiredLeadQuestionIds("new_construction")).toEqual([
      "project_scope",
      "decision_maker",
      "budget_status",
      "timeline_target",
      "incumbent_vendor",
    ]);
  });

  it("defaults unknown or missing project types to the normal qualification set", () => {
    expect(listRequiredLeadQuestionIds(null)).toEqual([
      "project_scope",
      "decision_maker",
      "budget_status",
      "timeline_target",
      "incumbent_vendor",
    ]);
    expect(listRequiredLeadQuestionIds("unknown-type")).toEqual([
      "project_scope",
      "decision_maker",
      "budget_status",
      "timeline_target",
      "incumbent_vendor",
    ]);
  });
});
