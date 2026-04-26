import { describe, expect, it } from "vitest";
import {
  formatQuestionAnswerValue,
  normalizeQuestionOptions,
  questionnaireRevealMatches,
} from "./questionnaire-display";

describe("questionnaire display helpers", () => {
  it("separates boolean storage from user-facing labels", () => {
    expect(formatQuestionAnswerValue(true)).toBe("Yes");
    expect(formatQuestionAnswerValue(false)).toBe("No");
    expect(formatQuestionAnswerValue(null)).toBe("Unanswered");
  });

  it("matches boolean parent answers against string seed reveal metadata", () => {
    expect(questionnaireRevealMatches(true, "true")).toBe(true);
    expect(questionnaireRevealMatches(false, "false")).toBe(true);
    expect(questionnaireRevealMatches(false, "true")).toBe(false);
  });

  it("normalizes string and object select options", () => {
    expect(normalizeQuestionOptions(["Closed", "Open Air"])).toEqual([
      { value: "Closed", label: "Closed" },
      { value: "Open Air", label: "Open Air" },
    ]);
    expect(
      normalizeQuestionOptions([
        { value: "closed", label: "Closed" },
        { value: "open_air", label: "Open Air" },
      ])
    ).toEqual([
      { value: "closed", label: "Closed" },
      { value: "open_air", label: "Open Air" },
    ]);
  });
});
