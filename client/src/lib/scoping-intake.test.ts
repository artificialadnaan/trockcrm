import { describe, expect, it } from "vitest";
import {
  formatScopingAttachmentLabel,
  formatScopingFieldLabel,
  getScopingCompletionCounts,
  summarizeScopingRoute,
} from "./scoping-intake";

describe("scoping intake helpers", () => {
  it("formats nested field labels into readable checklist text", () => {
    expect(formatScopingFieldLabel("projectOverview.bidDueDate")).toBe("Project Overview: Bid Due Date");
    expect(formatScopingFieldLabel("propertyDetails.propertyAddress")).toBe("Property Details: Property Address");
  });

  it("formats attachment keys and route badges for the workspace", () => {
    expect(formatScopingAttachmentLabel("scope_docs")).toBe("Scope docs");
    expect(formatScopingAttachmentLabel("site_photos")).toBe("Site photos");
    expect(summarizeScopingRoute("estimating")).toBe("Ready for Estimating");
    expect(summarizeScopingRoute("service")).toBe("Ready for Service");
  });

  it("counts completed sections from readiness state", () => {
    expect(
      getScopingCompletionCounts({
        projectOverview: {
          isComplete: true,
          missingFields: [],
          missingAttachments: [],
        },
        propertyDetails: {
          isComplete: false,
          missingFields: ["propertyAddress"],
          missingAttachments: [],
        },
        attachments: {
          isComplete: true,
          missingFields: [],
          missingAttachments: [],
        },
      })
    ).toEqual({ completed: 2, total: 3 });
  });
});
