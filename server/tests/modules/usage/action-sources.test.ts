import { describe, expect, it } from "vitest";
import { USAGE_ACTION_SOURCES } from "../../../src/modules/usage/action-sources.js";
import { AUDIT_ACTIONS, ACTIVITY_TYPES } from "@trock-crm/shared/types";

describe("USAGE_ACTION_SOURCES registry contract", () => {
  it("auditLog-backed keys reference real audit actions", () => {
    expect(AUDIT_ACTIONS).toContain(USAGE_ACTION_SOURCES.creates.auditAction);
    expect(AUDIT_ACTIONS).toContain(USAGE_ACTION_SOURCES.edits.auditAction);
  });

  it("only creates/edits are auditLog-sourced (carry impersonator exclusion)", () => {
    const auditKeys = Object.entries(USAGE_ACTION_SOURCES)
      .filter(([, s]) => s.table === "audit_log")
      .map(([k]) => k)
      .sort();
    expect(auditKeys).toEqual(["creates", "edits"]);
  });

  it("declares the non-audit sources with no impersonator exclusion", () => {
    expect(USAGE_ACTION_SOURCES.stage_moves.table).toBe("deal_stage_history");
    expect(USAGE_ACTION_SOURCES.stage_moves.impersonationExcluded).toBe(false);
    expect(USAGE_ACTION_SOURCES.uploads.table).toBe("files");
    expect(USAGE_ACTION_SOURCES.activities.table).toBe("activities");
  });

  it("activity sub-keys are all real ACTIVITY_TYPES", () => {
    for (const t of USAGE_ACTION_SOURCES.activities.types) {
      expect(ACTIVITY_TYPES).toContain(t);
    }
  });
});
