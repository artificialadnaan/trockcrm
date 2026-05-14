import { describe, expect, it } from "vitest";
import {
  INTERNAL_ONLY_AUDIT_FIELDS,
  formatAuditFieldChange,
  redactAuditFieldChangesForRole,
} from "../../../src/modules/audit/field-formatters.js";

describe("audit field formatters", () => {
  it("formats currency fields with dollars and commas", () => {
    expect(
      formatAuditFieldChange("budget", { from: "20000", to: "35000" })
    ).toMatchObject({
      label: "Budget",
      fromDisplay: "$20,000",
      toDisplay: "$35,000",
    });
  });

  it("formats dates as human-readable labels", () => {
    expect(
      formatAuditFieldChange("bidDueDate", { from: null, to: "2026-05-14" })
    ).toMatchObject({
      label: "Bid Due Date",
      fromDisplay: null,
      toDisplay: "May 14, 2026",
    });
  });

  it("formats enum values to display labels", () => {
    expect(
      formatAuditFieldChange("status", { from: "open", to: "converted" })
    ).toMatchObject({
      label: "Status",
      fromDisplay: "Open",
      toDisplay: "Converted",
    });
  });

  it("truncates long text fields in the compact display", () => {
    const change = formatAuditFieldChange("description", {
      from: "A".repeat(70),
      to: "B".repeat(71),
    });

    expect(change.fromDisplay?.endsWith("...")).toBe(true);
    expect(change.toDisplay?.endsWith("...")).toBe(true);
    expect(change.fromFull).toHaveLength(70);
    expect(change.toFull).toHaveLength(71);
  });

  it("handles null transitions as set and cleared states", () => {
    expect(
      formatAuditFieldChange("assignedRepId", { from: null, to: "user-1" })
    ).toMatchObject({
      transition: "set",
    });
    expect(
      formatAuditFieldChange("assignedRepId", { from: "user-1", to: null })
    ).toMatchObject({
      transition: "cleared",
    });
  });

  it("keeps the internal-only denylist as a single source of truth", () => {
    expect(INTERNAL_ONLY_AUDIT_FIELDS).toContain("rowVersion");
    expect(INTERNAL_ONLY_AUDIT_FIELDS).toContain("lastSyncedAt");
    expect(INTERNAL_ONLY_AUDIT_FIELDS).toContain("internalStatus");
  });

  it("masks sensitive fields for low-permission roles", () => {
    const result = redactAuditFieldChangesForRole(
      [
        formatAuditFieldChange("awardedAmount", { from: "1000000", to: "1275000" }),
        formatAuditFieldChange("name", { from: "Palm Villas", to: "Palm Villas East" }),
      ],
      "rep"
    );

    expect(result[0]).toMatchObject({
      label: "Awarded Amount",
      masked: true,
      fromDisplay: "Restricted",
      toDisplay: "Restricted",
    });
    expect(result[1]).toMatchObject({
      label: "Name",
      masked: false,
      fromDisplay: "Palm Villas",
      toDisplay: "Palm Villas East",
    });
  });
});
