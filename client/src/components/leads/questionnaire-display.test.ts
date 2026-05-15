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
    expect(formatQuestionAnswerValue("true")).toBe("Yes");
    expect(formatQuestionAnswerValue("false")).toBe("No");
    expect(formatQuestionAnswerValue(null)).toBe("Unanswered");
  });

  it("formats option-backed enum-style stored values when requested", () => {
    expect(formatQuestionAnswerValue("senior_living", { formatStringEnums: true })).toBe("Senior Living");
    expect(formatQuestionAnswerValue("highrise", { formatStringEnums: true })).toBe("Highrise");
    expect(formatQuestionAnswerValue(["garden_style", "highrise"])).toBe("Garden Style, Highrise");
  });

  it("preserves free-text strings by default", () => {
    expect(formatQuestionAnswerValue("May-June")).toBe("May-June");
    expect(formatQuestionAnswerValue("DFW-Phase-2")).toBe("DFW-Phase-2");
    expect(formatQuestionAnswerValue("john_smith")).toBe("john_smith");
    expect(formatQuestionAnswerValue("__unanswered__")).toBe("__unanswered__");
  });

  it("preserves ISO date answers instead of treating them as hyphenated enums", () => {
    expect(formatQuestionAnswerValue("2026-05-01")).toBe("2026-05-01");
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
