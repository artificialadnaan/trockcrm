import { describe, expect, it } from "vitest";
import { displayNameOrFallback, isUuidLike, sanitizeVisibleUuidText, stripVisibleUuidFallback } from "./display-identifiers";

describe("display identifier helpers", () => {
  it("detects UUID-like strings", () => {
    expect(isUuidLike("c90ed33e-041b-4ddb-8cb6-ea28eb67679f")).toBe(true);
    expect(isUuidLike("Brett Rios")).toBe(false);
  });

  it("replaces visible user-id fallbacks with human text", () => {
    expect(displayNameOrFallback("c90ed33e-041b-4ddb-8cb6-ea28eb67679f")).toBe("Unknown user");
    expect(displayNameOrFallback("Brett Rios")).toBe("Brett Rios");
  });

  it("replaces visible entity-id fallbacks with neutral text", () => {
    expect(stripVisibleUuidFallback("c90ed33e-041b-4ddb-8cb6-ea28eb67679f")).toBe("Linked internally");
    expect(stripVisibleUuidFallback("Northstar Expansion")).toBe("Northstar Expansion");
  });

  it("sanitizes UUIDs embedded in generated visible text", () => {
    expect(
      sanitizeVisibleUuidText(
        "e0ddca73-d24f-4189-80d8-88c83df8d971 is carrying 2 open cases",
        "Unknown assignee"
      )
    ).toBe("Unknown assignee is carrying 2 open cases");
  });
});
