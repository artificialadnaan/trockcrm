import { describe, expect, it } from "vitest";
import {
  buildValidationSummary,
  canLoadProcoreValidation,
  formatValidationMatchReason,
  getProcoreRedirectBanner,
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

  it("allows validation to load when disconnected in client credentials mode", () => {
    expect(
      canLoadProcoreValidation({
        connected: false,
        authMode: "client_credentials",
      })
    ).toBe(true);
  });

  it("allows validation to load when disconnected in dev mode", () => {
    expect(
      canLoadProcoreValidation({
        connected: false,
        authMode: "dev",
      })
    ).toBe(true);
  });

  it("blocks validation when oauth is disconnected and reauthorization is required", () => {
    expect(
      canLoadProcoreValidation({
        connected: false,
        authMode: "oauth",
        status: "reauth_needed",
        errorMessage: "refresh failed",
      })
    ).toBe(false);
  });

  it("returns a success banner for a completed oauth callback", () => {
    expect(
      getProcoreRedirectBanner({
        procore: "connected",
        reason: null,
      })
    ).toMatchObject({ tone: "success" });
  });

  it("returns an error banner for an oauth callback failure reason", () => {
    expect(
      getProcoreRedirectBanner({
        procore: "error",
        reason: "token_exchange_failed",
      })
    ).toMatchObject({
      tone: "destructive",
      description: expect.stringContaining("token exchange failed"),
    });
  });
});
