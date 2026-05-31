// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { dateRangeFromTerminalFilter } from "./deals-list-section";
import { toDatePresetRange } from "../../lib/pipeline-terminal-filters";

// Codex finding 1 (deals list surface): the list date filter must resolve the wtd preset
// via the shared Sunday-anchored definition, not Number("wtd") -> NaN.
describe("deals-list-section dateRangeFromTerminalFilter wtd (no NaN)", () => {
  it("resolves wtd to the shared Sunday-anchored window", () => {
    expect(dateRangeFromTerminalFilter({ preset: "wtd" })).toEqual(toDatePresetRange("wtd"));
  });
});
