import { describe, expect, it } from "vitest";
import dealTeamTabSource from "./deal-team-tab.tsx?raw";

// Source-string assertions (the App.test.tsx / deal-form.test.tsx pattern) — there is no render harness for
// this component, so we assert the estimator-is-user-only wiring is present in the source instead of driving
// the DOM. The server rejects a contact-backed estimator (400), so the role picker must not offer Estimator
// in contact mode, and switching to contact mode must clear an already-picked estimator role.
function normalize(source: string) {
  return source.replace(/\s+/g, " ").trim();
}

describe("DealTeamTab role picker (Estimator is user-only)", () => {
  const source = normalize(dealTeamTabSource);

  it("filters Estimator out of the role options in contact mode", () => {
    // The picker maps over rolesForMode(mode), not the raw ROLE_LABELS keys.
    expect(source).toContain("rolesForMode(mode).map((r) =>");
    // rolesForMode drops estimator when the assign mode is contact.
    expect(source).toContain('return mode === "contact" ? roles.filter((r) => r !== "estimator") : roles;');
  });

  it("clears a now-invalid role when switching away from user mode (estimator in contact, non-super/PM in email)", () => {
    // Switching to contact OR email mode re-validates the picked role against rolesForMode(m) and clears it
    // if the mode no longer offers it — so a picked estimator can't survive into contact mode.
    expect(source).toContain('if (m !== "user") {');
    expect(source).toContain('setRole((prev) => (prev && rolesForMode(m).includes(prev) ? prev : ""));');
  });

  it("still offers Estimator (keeps it in ROLE_LABELS for user mode)", () => {
    expect(source).toContain('estimator: "Estimator"');
  });

  it("makes re-selecting the already-active mode a no-op (no reset of in-progress fields)", () => {
    // The onClick short-circuits before any setMode/clear when the clicked mode equals the current mode, so
    // tapping the active segment never wipes what the user is entering.
    expect(source).toContain("if (m === mode) return;");
  });
});
