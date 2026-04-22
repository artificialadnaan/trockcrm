import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  InterventionConclusionForm,
  canSubmitInterventionConclusion,
} from "./intervention-conclusion-form";

describe("InterventionConclusionForm", () => {
  it("keeps resolve submit disabled until required structured fields are complete", () => {
    expect(
      canSubmitInterventionConclusion("resolve", {
        kind: "resolve",
        outcomeCategory: "",
        reasonCode: "",
        effectiveness: "",
        notes: null,
      })
    ).toBe(false);
  });

  it("renders taxonomy-backed snooze fields in static markup", () => {
    const html = renderToStaticMarkup(
      <InterventionConclusionForm mode="snooze" submitLabel="Snooze" onSubmit={vi.fn()} />
    );

    expect(html).toContain("Snooze reason");
    expect(html).toContain("Expected owner");
  });
});
