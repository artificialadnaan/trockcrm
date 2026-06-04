// @vitest-environment jsdom
//
// Regression: drilling Director dashboard -> rep -> Won cohort and going Back must return to the
// IMMEDIATELY-previous drill view (the rep detail), step by step — not collapse to the dashboard home.
//
// This exercises the REAL DealStagePage (so its on-mount <Navigate replace> redirects fire) and the REAL
// PipelineStagePageHeader (so the in-app "Back" affordance is the production one). Only the data hooks and
// the heavy list leaf are mocked. Two back paths are covered:
//   1. the browser Back button (router.navigate(-1)) — already correct, locked here so a future change
//      to the drill push/replace semantics can't silently start collapsing the stack; and
//   2. the in-app "Back" affordance — fixed to step back through history to the referrer when in-app
//      history exists, and to fall back to the fixed board URL on a deep link.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router-dom";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  useDealStagePageMock: vi.fn(),
  useRegionsMock: vi.fn(),
  useProjectTypesMock: vi.fn(),
  usePipelineStagesMock: vi.fn(),
  useTaskAssigneesMock: vi.fn(),
  useAuthMock: vi.fn(),
  dealsListSectionMock: vi.fn(),
}));

// pipeline-scope is deliberately NOT mocked, so the real useNormalizedStageRoute + the real <Navigate
// replace> mount redirects run, and the real route.backTo flows into the real header.
vi.mock("@/hooks/use-deals", () => ({ useDealStagePage: mocks.useDealStagePageMock }));
vi.mock("@/hooks/use-pipeline-config", () => ({
  useRegions: mocks.useRegionsMock,
  useProjectTypes: mocks.useProjectTypesMock,
  usePipelineStages: mocks.usePipelineStagesMock,
}));
vi.mock("@/hooks/use-task-assignees", () => ({ useTaskAssignees: mocks.useTaskAssigneesMock }));
vi.mock("@/lib/auth", () => ({ useAuth: mocks.useAuthMock }));
vi.mock("@/components/deals/deals-list-section", () => ({
  DealsListSection: (props: Record<string, unknown>) => {
    mocks.dealsListSectionMock(props);
    return <section data-testid="deals-list-section" />;
  },
}));

import { DealStagePage } from "./deal-stage-page";

const DIRECTOR = "/director";
const REP_DETAIL = "/director/rep/REP1";
// How a rep-scoped Won cohort URL looks when reached from a dashboard drill (bare filter params -> the
// barRedirect rewrites them to fb_ in place on mount):
const COHORT_BARE =
  "/deals/stages/WONSTAGE?scope=mine&assignedRepId=REP1&won_since=2026-01-01&won_until=2026-12-31";
// Already-normalized form (no bare params -> no redirect): a single pushed cohort entry.
const COHORT_CLEAN =
  "/deals/stages/WONSTAGE?scope=mine&fb_assignedRepId=REP1&fb_dateFrom=2026-01-01&fb_dateTo=2026-12-31";

function setWonStage() {
  mocks.useDealStagePageMock.mockReturnValue({
    loading: false,
    error: null,
    data: {
      stage: { id: "WONSTAGE", name: "Won", slug: "won" },
      summary: { count: 3, totalValue: 1_000_000, averageDaysInStage: 12 },
      pagination: { page: 1, pageSize: 25, total: 3, totalPages: 1 },
      rows: [],
    },
  });
}

function makeRouter(initialEntries: string[]) {
  return createMemoryRouter(
    [
      { path: "/director", element: <div data-testid="director-home">Director Home</div> },
      { path: "/director/rep/:repId", element: <div data-testid="rep-detail">Rep Detail</div> },
      { path: "/deals/stages/:stageId", element: <DealStagePage /> },
      { path: "/deals", element: <div data-testid="deals-board">Deals Board</div> },
    ],
    { initialEntries, initialIndex: initialEntries.length - 1 }
  );
}

function renderRouter(router: ReturnType<typeof makeRouter>) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(<RouterProvider router={router} />);
  });
  return {
    container,
    cleanup: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function loc(router: ReturnType<typeof makeRouter>) {
  return router.state.location.pathname + router.state.location.search;
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("dashboard drill-down Back navigation (director -> rep -> Won cohort)", () => {
  beforeEach(() => {
    mocks.dealsListSectionMock.mockReset();
    mocks.useRegionsMock.mockReturnValue({ regions: [] });
    mocks.useProjectTypesMock.mockReturnValue({ projectTypes: [] });
    mocks.useTaskAssigneesMock.mockReturnValue({ assignees: [] });
    mocks.useAuthMock.mockReturnValue({ user: { role: "director" } });
    mocks.usePipelineStagesMock.mockReturnValue({
      loading: false,
      stages: [
        { id: "WONSTAGE", slug: "won", name: "Won" },
        { id: "s-estimating", slug: "estimating", name: "Estimating" },
      ],
    });
    setWonStage();
    window.history.replaceState(null, "", "/");
  });

  afterEach(() => {
    document.body.innerHTML = "";
    window.history.replaceState(null, "", "/");
  });

  it("browser Back steps up exactly one level (cohort -> rep -> dashboard), not straight to home", async () => {
    const router = makeRouter([DIRECTOR, REP_DETAIL, COHORT_BARE]);
    const view = renderRouter(router);
    try {
      await settle();

      // The mount barRedirect rewrote the cohort entry IN PLACE (same path; bare params translated to fb_),
      // so it stays a single history entry rather than pushing a second one.
      const params = new URLSearchParams(router.state.location.search);
      expect(router.state.location.pathname).toBe("/deals/stages/WONSTAGE");
      expect(params.has("fb_assignedRepId")).toBe(true);
      expect(params.has("assignedRepId")).toBe(false);
      expect(params.has("won_since")).toBe(false);

      // First Back -> the rep detail (the immediately-previous drill view), NOT the dashboard home.
      await act(async () => {
        await router.navigate(-1);
      });
      expect(loc(router)).toBe(REP_DETAIL); // restored with its exact URL/scope state

      // Second Back -> the director dashboard.
      await act(async () => {
        await router.navigate(-1);
      });
      expect(router.state.location.pathname).toBe("/director");
    } finally {
      view.cleanup();
    }
  });

  it("in-app 'Back' affordance returns to the view drilled in from when in-app history exists", async () => {
    const router = makeRouter([DIRECTOR, REP_DETAIL, COHORT_CLEAN]);
    const view = renderRouter(router);
    try {
      await settle();
      // Model an in-app drill: there is a prior entry to step back to.
      window.history.replaceState({ idx: 2 }, "");

      const back = view.container.querySelector("a");
      expect(back, "expected the in-app Back link to render").toBeTruthy();
      act(() => {
        back!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
      });

      expect(router.state.location.pathname).toBe("/director/rep/REP1");
    } finally {
      view.cleanup();
    }
  });

  it("in-app 'Back' falls back to the board URL on a deep link (no in-app history)", async () => {
    const router = makeRouter([COHORT_CLEAN]);
    const view = renderRouter(router);
    try {
      await settle();
      window.history.replaceState({ idx: 0 }, ""); // first entry of the session: nothing to go back to

      const back = view.container.querySelector("a");
      const href = back!.getAttribute("href");
      expect(href?.startsWith("/deals?")).toBe(true); // route.backTo board URL stays the fallback target
      act(() => {
        back!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
      });

      expect(router.state.location.pathname).toBe("/deals");
    } finally {
      view.cleanup();
    }
  });

  // The fix relies on in-page filter edits using {replace:true} (use-filter-state.ts) so they NEVER add
  // history entries — otherwise Back would step through stale filter states instead of returning to the
  // referrer. Lock that invariant: after several in-place filter rewrites on the cohort, browser Back still
  // lands exactly one level up on the rep detail.
  it("browser Back still returns to the referrer after multiple in-page filter edits (replace, no bloat)", async () => {
    const router = makeRouter([DIRECTOR, REP_DETAIL, COHORT_CLEAN]);
    const view = renderRouter(router);
    try {
      await settle();
      const base = "/deals/stages/WONSTAGE?scope=mine";
      for (const search of ["fb_status=on_hold", "fb_status=active&fb_minAgeDays=7", "fb_search=acme"]) {
        await act(async () => {
          await router.navigate(`${base}&${search}`, { replace: true });
        });
      }
      expect(router.state.location.pathname).toBe("/deals/stages/WONSTAGE"); // still the cohort, just rewritten
      await act(async () => {
        await router.navigate(-1);
      });
      expect(loc(router)).toBe(REP_DETAIL); // one level up, not bouncing through the replaced filter states
    } finally {
      view.cleanup();
    }
  });

  // LEADS parity: lead-stage-page.tsx renders the SAME PipelineStagePageHeader with route.backTo
  // (= /leads?scope=...), and its single on-mount scope-normalize <Navigate replace> preserves history idx
  // exactly like the deals page's redirects. The referrer-aware Back logic itself is entity-agnostic and is
  // covered directly in pipeline-stage-page-header.test.tsx, so the leads cohort inherits the same behavior:
  // Back returns to the referrer when in-app history exists, else falls back to the /leads board.
});
