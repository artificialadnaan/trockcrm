// @vitest-environment jsdom

import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ScopeToggle, type ScopeToggleOption } from "./scope-toggle";

/**
 * CI-executed (*.runtime.test) component test for the Watched scope pill. The deals dashboard adds
 * { value: "watched", label: "Watched" } to its SCOPE_OPTIONS; this guards that the toggle renders a
 * Watched pill and reflects its active state. (The page wiring getScope->useDealBoard("watched") is
 * covered by deal-list-page.test.tsx + the watched-scope coercer tests.)
 */
const OPTIONS = [
  { value: "mine", label: "Mine" },
  { value: "all", label: "All" },
  { value: "watched", label: "Watched" },
] as const satisfies readonly ScopeToggleOption<"mine" | "all" | "watched">[];

describe("ScopeToggle — Watched pill", () => {
  it("renders the Watched pill and marks it active when selected", () => {
    const html = renderToStaticMarkup(
      <ScopeToggle options={OPTIONS} value="watched" onChange={() => {}} ariaLabel="Deal scope" />
    );
    expect(html).toContain('aria-pressed="true">Watched');
    expect(html).toContain('aria-pressed="false">Mine');
    expect(html).toContain('aria-pressed="false">All');
  });

  it("does not mark Watched active for a different selection", () => {
    const html = renderToStaticMarkup(
      <ScopeToggle options={OPTIONS} value="mine" onChange={() => {}} ariaLabel="Deal scope" />
    );
    expect(html).toContain('aria-pressed="false">Watched');
    expect(html).toContain('aria-pressed="true">Mine');
  });
});
