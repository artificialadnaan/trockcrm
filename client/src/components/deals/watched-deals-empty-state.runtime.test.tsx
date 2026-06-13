// @vitest-environment jsdom

import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { WatchedDealsEmptyState } from "./deals-list-section";

/**
 * CI-executed (*.runtime.test) component test for the Watched-scope empty state.
 * The condition (scope==="watched" && deals.length===0 -> render this) is covered by
 * deals-list-section.test.tsx; this guards the rendered copy + a11y in CI.
 */
describe("WatchedDealsEmptyState", () => {
  it("renders the neutral, honest copy + the a11y label", () => {
    const html = renderToStaticMarkup(<WatchedDealsEmptyState />);
    expect(html).toContain("No watched deals to show here");
    expect(html).toContain('aria-label="No watched deals"');
    expect(html).toContain("Watch this deal");
    // Honest on stage/drill-down mounts: must NOT claim the user watches nothing.
    expect(html).not.toContain("not watching any deals");
  });
});
