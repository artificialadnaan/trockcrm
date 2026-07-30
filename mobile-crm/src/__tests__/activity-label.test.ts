import { activityTypeLabel } from "../activity-label";

describe("an activity type, in the rep's words", () => {
  it("phrases the types a field capture can write", () => {
    // These five are also the chip labels on the capture screen, which now reads them from here —
    // they were two lists, and the deal feed's was the raw database column.
    expect(activityTypeLabel("site_visit")).toBe("Site visit");
    expect(activityTypeLabel("call")).toBe("Call");
    expect(activityTypeLabel("meeting")).toBe("Meeting");
    expect(activityTypeLabel("voicemail")).toBe("Voicemail");
    expect(activityTypeLabel("note")).toBe("Note");
  });

  it("phrases the types the feed receives but cannot write", () => {
    expect(activityTypeLabel("email")).toBe("Email");
    expect(activityTypeLabel("stage_change")).toBe("Stage change");
    expect(activityTypeLabel("task")).toBe("Task");
  });

  it("humanises an UNKNOWN type rather than showing the column or hiding the row", () => {
    // The actual contract. api-spec.ts documents six types and the server emits at least nine, so the
    // map will always be behind something. A feed that hides an activity it does not recognise is
    // worse than one that says "Contract signed".
    expect(activityTypeLabel("contract_signed")).toBe("Contract signed");
    expect(activityTypeLabel("siteWalk")).toBe("Site walk");
  });

  it("keeps sentence case, not title case", () => {
    // "Stage Change" makes a feed read like a spreadsheet header.
    expect(activityTypeLabel("stage_change")).toBe("Stage change");
    expect(activityTypeLabel("some_new_thing")).toBe("Some new thing");
  });

  it("never renders an empty or missing type as a blank line", () => {
    expect(activityTypeLabel(null)).toBe("Activity");
    expect(activityTypeLabel(undefined)).toBe("Activity");
    expect(activityTypeLabel("")).toBe("Activity");
    expect(activityTypeLabel("   ")).toBe("Activity");
    expect(activityTypeLabel("_")).toBe("Activity");
  });
});
