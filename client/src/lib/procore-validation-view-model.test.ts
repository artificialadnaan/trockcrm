import { describe, expect, it } from "vitest";
import {
  buildValidationSummary,
  formatValidationMatchReason,
  getProcoreConnectionBanner,
} from "./procore-validation-view-model";

describe("procore validation view model", () => {
  it("counts matched, ambiguous, and unmatched projects correctly", () => {
    expect(
      buildValidationSummary([
        { status: "matched" },
        { status: "matched" },
        { status: "unmatched" },
        { status: "ambiguous" },
      ])
    ).toEqual({
      matched: 2,
      ambiguous: 1,
      unmatched: 1,
      total: 4,
    });
  });

  it("formats match reasons into readable labels", () => {
    expect(formatValidationMatchReason("procore_project_id")).toBe("Linked by Procore project ID");
    expect(formatValidationMatchReason("duplicate_project_number")).toBe(
      "Ambiguous project number match"
    );
    expect(formatValidationMatchReason("none")).toBe("No CRM match");
  });

  it("returns a connect banner when procore oauth is disconnected", () => {
    expect(
      getProcoreConnectionBanner({ connected: false, authMode: "client_credentials" })
    ).toMatchObject({ tone: "warning" });
  });

  it("returns an auth-error banner when procore oauth needs reauthorization", () => {
    expect(
      getProcoreConnectionBanner({
        connected: false,
        authMode: "oauth",
        status: "reauth_needed",
        errorMessage: "refresh failed",
      })
    ).toMatchObject({ tone: "destructive" });
  });
});
