// @vitest-environment jsdom
//
// The stage/cohort page's "Back" affordance must return the user to the view they DRILLED IN FROM
// (rep detail, director dashboard, pipeline, the board, …) — i.e. behave like the browser Back button —
// instead of always jumping to the fixed `backTo` board URL. When there is no in-app history to return
// to (a deep link / fresh load / hard refresh), it must fall back to `backTo` so the control always has
// a sane destination (and so open-in-new-tab works).
//
// react-router (v7) stamps a monotonic `idx` into window.history.state; a fresh session starts at idx 0
// and an in-place <Navigate replace> preserves it, so idx>0 means "navigated here from within the app".
// These tests drive a real createMemoryRouter for reliable, synchronous navigate(-1), and set
// window.history.state.idx directly to model "has in-app history" vs "deep link".

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { PipelineStagePageHeader } from "./pipeline-stage-page-header";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BACK_TO = "/deals?scope=mine";
const REP_DETAIL = "/director/rep/REP1";
const COHORT = "/deals/stages/WONSTAGE?scope=mine&fb_assignedRepId=REP1";

function StageHeaderRoute() {
  return (
    <PipelineStagePageHeader backTo={BACK_TO} title="Won" subtitle="cohort">
      <div data-testid="cohort-list">list</div>
    </PipelineStagePageHeader>
  );
}

const routes = [
  { path: "/director/rep/:repId", element: <div data-testid="rep-detail">REP DETAIL</div> },
  { path: "/deals/stages/:stageId", element: <StageHeaderRoute /> },
  { path: "/deals", element: <div data-testid="deals-board">DEALS BOARD</div> },
];

function renderAt(initialEntries: string[]) {
  const router = createMemoryRouter(routes, {
    initialEntries,
    initialIndex: initialEntries.length - 1,
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(<RouterProvider router={router} />);
  });
  return {
    router,
    container,
    cleanup: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function locationOf(router: ReturnType<typeof createMemoryRouter>) {
  return router.state.location.pathname + router.state.location.search;
}

function backLink(container: HTMLElement): HTMLAnchorElement {
  const anchor = container.querySelector("a");
  if (!anchor) throw new Error("expected a Back link anchor in the stage header");
  return anchor as HTMLAnchorElement;
}

function clickBack(container: HTMLElement, init: MouseEventInit = {}) {
  const anchor = backLink(container);
  // When the production handler intentionally lets the browser handle a click (a modified click → open in
  // new tab), jsdom can't perform that real-document navigation and logs a noisy "Not implemented:
  // navigation". Silence ONLY that browser default with a DOCUMENT-level BUBBLE listener: React (createRoot)
  // delegates at the root container, which is BELOW document, so this fires AFTER the production handler has
  // fully run (including its modifier-key guard). That keeps the output clean WITHOUT short-circuiting the
  // handler — so a regression that drops the modifier guard would let navigate(-1) fire and fail the test.
  const silenceBrowserDefault = (event: Event) => event.preventDefault();
  document.addEventListener("click", silenceBrowserDefault);
  try {
    act(() => {
      anchor.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init })
      );
    });
  } finally {
    document.removeEventListener("click", silenceBrowserDefault);
  }
}

describe("PipelineStagePageHeader — referrer-aware Back affordance", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/");
  });

  afterEach(() => {
    document.body.innerHTML = "";
    window.history.replaceState(null, "", "/");
  });

  // A plain primary-button click is also what the browser synthesizes for keyboard Enter on a focused
  // anchor (button 0, no modifiers), so this case covers keyboard activation as well as mouse.
  it("returns to the view the user drilled in from (history back) when in-app history exists", () => {
    const view = renderAt([REP_DETAIL, COHORT]);
    try {
      // Model an in-app drill: there is a prior entry to go back to.
      window.history.replaceState({ idx: 1 }, "");
      clickBack(view.container);
      expect(view.router.state.location.pathname).toBe("/director/rep/REP1");
      // The restored view keeps its full URL state (filters/scope) intact, since it is the real prior entry.
      expect(locationOf(view.router)).toBe(REP_DETAIL);
    } finally {
      view.cleanup();
    }
  });

  it("falls back to the fixed board URL on a deep link / fresh load (no in-app history)", () => {
    const view = renderAt([COHORT]);
    try {
      window.history.replaceState({ idx: 0 }, "");
      clickBack(view.container);
      expect(view.router.state.location.pathname).toBe("/deals");
    } finally {
      view.cleanup();
    }
  });

  it("always exposes the board URL as the anchor href (open-in-new-tab / accessibility)", () => {
    const view = renderAt([REP_DETAIL, COHORT]);
    try {
      expect(backLink(view.container).getAttribute("href")).toBe(BACK_TO);
    } finally {
      view.cleanup();
    }
  });

  it("does not hijack modified clicks (cmd/ctrl-click) so open-in-new-tab still works", () => {
    const view = renderAt([REP_DETAIL, COHORT]);
    try {
      window.history.replaceState({ idx: 1 }, "");
      clickBack(view.container, { metaKey: true });
      // Modified click must not trigger an SPA navigation (browser would open a new tab to href).
      expect(view.router.state.location.pathname).toBe("/deals/stages/WONSTAGE");
    } finally {
      view.cleanup();
    }
  });
});
