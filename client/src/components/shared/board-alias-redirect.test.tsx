// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { BoardAliasRedirect } from "./board-alias-redirect";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Render BoardAliasRedirect at an alias path and report where it lands (path + query), so the
// query-forwarding contract — bookmarked /pipeline?scope=... params survive onto /deals — is locked
// behaviorally, not just by source assertion.
function landingFrom(path: string): string {
  let captured = "";
  function Probe() {
    const loc = useLocation();
    captured = loc.pathname + loc.search;
    return null;
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/pipeline" element={<BoardAliasRedirect entity="deals" />} />
          <Route path="/deals" element={<Probe />} />
        </Routes>
      </MemoryRouter>
    );
  });
  act(() => root.unmount());
  return captured;
}

describe("BoardAliasRedirect", () => {
  it("forwards the full query string onto the alias target (bookmarked params survive)", () => {
    expect(landingFrom("/pipeline?scope=all&assignedRepId=r1")).toBe("/deals?scope=all&assignedRepId=r1");
  });

  it("redirects to the bare target when there is no query string", () => {
    expect(landingFrom("/pipeline")).toBe("/deals");
  });
});
