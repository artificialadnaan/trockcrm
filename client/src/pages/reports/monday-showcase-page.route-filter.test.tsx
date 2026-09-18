// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import {
  UNFILTERED_ROUTE_FILTER,
  type EvidenceRequest,
  type MondayShowcaseData,
  type RouteBucket,
} from "./monday-showcase/types";
import { emptyEstimatingReport } from "./monday-showcase/test-fixtures";
import { DEFAULT_WEEK_MODE, WEEK_MODE_LABELS, type WeekMode } from "./week-mode";

/**
 * The Monday-showcase Service / Other chips, at the PAGE level: what the page asks the server for, and
 * what it renders in the two states that have no honest numbers.
 *
 * The load-bearing assertions are about the REQUEST (`useMondayShowcase` args) and about the ABSENCE of
 * numbers in the empty/invalid states. A filter that looks right but requests the unfiltered report, or
 * that renders zeros when nothing is selected, is exactly the failure this suite exists to catch.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Every call the page makes to the showcase hook, in order — the request contract under test.
const calls: Array<{ mode: string; routes: readonly RouteBucket[] | undefined; enabled: boolean }> = [];

// Every call the OPEN EVIDENCE DRAWER makes, in order. `metric: null` = the drawer is mounted but closed
// (the page renders it unconditionally), so the assertions below look only at the calls with a request.
const evidenceCalls: Array<{
  metric: string | null;
  mode: string;
  routes: readonly RouteBucket[] | undefined;
}> = [];

/** When set, the mocked hook returns this instead — used to stage an in-flight refetch holding the
 *  PREVIOUS payload, which is the exact window where a stale caveat can contradict the chips. */
let hookOverride: {
  data: MondayShowcaseData | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
} | null = null;

const payload: MondayShowcaseData = {
  period: { from: "2026-06-08", to: "2026-06-12", mode: DEFAULT_WEEK_MODE, label: "2026-06-08 → 2026-06-12" },
  // A distinctive count (rendered as "4,242") so "did the page render figures at all?" is unambiguous in
  // the DOM — the Exec hero, the default variant, renders from `departments`.
  departments: [
    {
      key: "won",
      label: "Won",
      count: 4242,
      value: { amount: 424242, basisLabel: "Awarded-first won value" },
      deltaCountWoW: 1,
      sparkline: [],
      deferred: false,
    },
  ],
  execHero: {
    won: { count: 4242, value: { amount: 424242, basisLabel: "Awarded-first won value" } },
    sent: { count: 4, value: { amount: 100, basisLabel: "Best current estimate" } },
    estimated: { count: 2, value: { amount: 50, basisLabel: "Best current estimate" } },
  },
  reps: [],
  officeProjection: {
    bands: [
      { band: "0_30", count: 0, value: 0 },
      { band: "31_60", count: 0, value: 0 },
      { band: "61_90", count: 0, value: 0 },
      { band: "beyond_90", count: 0, value: 0 },
    ],
    coverage: { n: 0, m: 0, undatedValue: 0 },
    coverageCaption: "0 of 0 open deals have a maintained (future-dated) expected close date.",
  },
  weeklyTrend: [],
  valueBases: { won_awarded_first: "Awarded-first won value", open_best_estimate: "Best current estimate" },
  estimatingReport: emptyEstimatingReport(),
  routeFilter: UNFILTERED_ROUTE_FILTER,
  notes: [],
};

vi.mock("@/hooks/use-reports", async () => {
  const actual = await vi.importActual<typeof import("@/hooks/use-reports")>("@/hooks/use-reports");
  return {
    ...actual,
    useMondayShowcase: (mode: string, routes: readonly RouteBucket[] | undefined, enabled = true) => {
      calls.push({ mode, routes, enabled });
      // Mirror the real hook's contract: a disabled selection yields NO data, so the page cannot render
      // stale numbers under an empty or broken chip state even if it tried.
      if (hookOverride) return hookOverride;
      return { data: enabled ? payload : null, loading: false, error: null, refetch: () => {} };
    },
    // Records what the DRAWER asks for. Mocking the fetch (not the page → drawer wiring) is deliberate:
    // the selection a drill is fetched under is decided by the page, so a change there shows up here.
    useShowcaseEvidence: (
      request: EvidenceRequest | null,
      mode: string,
      routes?: readonly RouteBucket[]
    ) => {
      evidenceCalls.push({ metric: request?.metric ?? null, mode, routes });
      return { data: null, loading: false, error: null, refetch: () => {} };
    },
  };
});

vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { id: "u1", role: "director" } }) }));

// Imported after the mocks so the page picks them up.
const { MondayShowcasePage } = await import("./monday-showcase-page");

let container: HTMLDivElement;
let root: Root;
let currentSearch = "";
/** Changes the URL WITHOUT remounting the page (the page is rendered directly under the router, not behind
 *  a <Route>) — the only way a selection can change while an evidence drawer is open, since the drawer is
 *  modal and the chips behind it are not clickable. */
let navigateTo: (url: string) => void = () => {
  throw new Error("LocationProbe has not rendered");
};

function LocationProbe() {
  currentSearch = useLocation().search;
  const navigate = useNavigate();
  navigateTo = (url) => navigate(url);
  return null;
}

function renderAt(initialUrl: string) {
  act(() => {
    root.render(
      <MemoryRouter initialEntries={[initialUrl]}>
        <LocationProbe />
        <MondayShowcasePage />
      </MemoryRouter>
    );
  });
}

/** The most recent recorded call. (`Array.prototype.at` is above this project's TS lib target.) */
function last<T>(recorded: readonly T[]): T {
  const value = recorded[recorded.length - 1];
  if (value === undefined) throw new Error("no calls were recorded");
  return value;
}

/** The chip buttons, by their visible label. */
function chip(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
  if (!found) throw new Error(`no chip labelled "${label}"`);
  return found as HTMLButtonElement;
}

beforeEach(() => {
  calls.length = 0;
  evidenceCalls.length = 0;
  hookOverride = null;
  currentSearch = "";
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("default state", () => {
  it("requests NO routes — byte-identical to the pre-filter request", () => {
    renderAt("/reports/monday-showcase");
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]).toEqual({ mode: DEFAULT_WEEK_MODE, routes: undefined, enabled: true });
  });

  it("shows both chips pressed and renders the report", () => {
    renderAt("/reports/monday-showcase");
    expect(chip("Service").getAttribute("aria-pressed")).toBe("true");
    expect(chip("Other").getAttribute("aria-pressed")).toBe("true");
    expect(container.textContent).toContain("4,242"); // the report's figures are on screen
  });
});

describe("a narrowed selection", () => {
  it("sends only the selected bucket", () => {
    renderAt("/reports/monday-showcase?routes=service");
    expect(calls[0]).toEqual({ mode: DEFAULT_WEEK_MODE, routes: ["service"], enabled: true });
    expect(chip("Service").getAttribute("aria-pressed")).toBe("true");
    expect(chip("Other").getAttribute("aria-pressed")).toBe("false");
  });

  it("puts the selection in the URL when a chip is toggled, so a link is shareable", () => {
    renderAt("/reports/monday-showcase");
    act(() => {
      chip("Other").click();
    });
    expect(currentSearch).toContain("routes=service");
    // And the request followed the URL rather than staying on the unfiltered payload.
    expect(calls[calls.length - 1].routes).toEqual(["service"]);
  });

  it("removes the param when both chips are back on, leaving a clean default URL", () => {
    renderAt("/reports/monday-showcase?routes=service");
    act(() => {
      chip("Other").click();
    });
    expect(currentSearch).not.toContain("routes");
    expect(calls[calls.length - 1].routes).toBeUndefined();
  });

  it("preserves other query params (e.g. ?officeId) when writing the selection", () => {
    renderAt("/reports/monday-showcase?officeId=off-1");
    act(() => {
      chip("Service").click();
    });
    expect(currentSearch).toContain("officeId=off-1");
    expect(currentSearch).toContain("routes=other");
  });
});

describe("no bucket selected", () => {
  it("renders an explicit 'select at least one' state and NO numbers", () => {
    renderAt("/reports/monday-showcase?routes=none");
    expect(container.textContent).toContain("Select at least one department");
    // The whole point: zeros must not be rendered as if they were measurements.
    expect(container.textContent).not.toContain("4,242");
    expect(container.textContent).not.toMatch(/\b0\b\s*(deals|records)/);
  });

  it("does not fetch at all in that state", () => {
    renderAt("/reports/monday-showcase?routes=none");
    expect(calls.every((c) => c.enabled === false)).toBe(true);
  });

  it("recovers when a chip is turned back on", () => {
    renderAt("/reports/monday-showcase?routes=none");
    act(() => {
      chip("Service").click();
    });
    expect(currentSearch).toContain("routes=service");
    expect(calls[calls.length - 1]).toEqual({ mode: DEFAULT_WEEK_MODE, routes: ["service"], enabled: true });
  });
});

describe("an invalid ?routes value", () => {
  it("shows an error naming the bad value and renders NO figures", () => {
    renderAt("/reports/monday-showcase?routes=banana");
    expect(container.textContent).toContain("isn’t valid");
    expect(container.textContent).toContain("banana");
    // Never the unfiltered report under a URL that claims a filter.
    expect(container.textContent).not.toContain("4,242");
  });

  it("does not fetch, so no unfiltered payload is loaded behind the error", () => {
    renderAt("/reports/monday-showcase?routes=banana");
    expect(calls.every((c) => c.enabled === false)).toBe(true);
  });

  it("offers a reset that returns to the full report", () => {
    renderAt("/reports/monday-showcase?routes=banana");
    const reset = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("show all departments")
    );
    expect(reset).toBeTruthy();
    act(() => {
      (reset as HTMLButtonElement).click();
    });
    expect(currentSearch).not.toContain("routes");
    expect(calls[calls.length - 1].enabled).toBe(true);
  });
});

describe("a repeated ?routes param", () => {
  // URLSearchParams.get() returns only the first value, so this URL used to render a confident
  // Service-only page while the SERVER rejected the same link as ambiguous. Client and server now consult
  // one parser, so both call it invalid.
  it("renders the invalid state instead of guessing the first value", () => {
    renderAt("/reports/monday-showcase?routes=service&routes=other");
    expect(container.textContent).toContain("isn’t valid");
    expect(container.textContent).not.toContain("4,242");
    expect(chip("Service").getAttribute("aria-pressed")).toBe("false");
    expect(chip("Other").getAttribute("aria-pressed")).toBe("false");
  });

  it("does not fetch a slice the server would refuse to produce", () => {
    renderAt("/reports/monday-showcase?routes=service&routes=other");
    expect(calls.every((c) => c.enabled === false)).toBe(true);
  });

  it("still honours a SINGLE occurrence — the negative case alone would pass on broken parsing", () => {
    renderAt("/reports/monday-showcase?routes=service");
    expect(calls[0]).toEqual({ mode: DEFAULT_WEEK_MODE, routes: ["service"], enabled: true });
    expect(container.textContent).not.toContain("isn’t valid");
    expect(container.textContent).toContain("4,242");
  });
});

describe("the caveat never contradicts the chips", () => {
  const serviceOnlyPayload: MondayShowcaseData = {
    ...payload,
    routeFilter: {
      selected: ["service"],
      active: true,
      unfilterable: ["Active leads (the leads table has no workflow route)"],
    },
  };

  it("shows the server caveat once the payload matches the chips", () => {
    hookOverride = { data: serviceOnlyPayload, loading: false, error: null, refetch: () => {} };
    renderAt("/reports/monday-showcase?routes=service");
    expect(container.textContent).toContain("Showing Service only");
    expect(container.textContent).toContain("Active leads");
  });

  it("drops the stale caveat during an in-flight refetch to a NEW selection", () => {
    // The window this guards: chips already say All departments, the previous Service-only payload is
    // still in hand. Rendering its caveat would print "All departments" and "Showing Service only" side
    // by side — and that caveat is the only disclosure the unfilterable figures have.
    hookOverride = { data: serviceOnlyPayload, loading: true, error: null, refetch: () => {} };
    renderAt("/reports/monday-showcase");
    expect(container.textContent).toContain("All departments");
    expect(container.textContent).not.toContain("Showing Service only");
  });

  it("drops it even when the request has settled but the payload describes another selection", () => {
    // Belt and braces: loading already false, yet the payload is for a different slice than the chips.
    hookOverride = { data: serviceOnlyPayload, loading: false, error: null, refetch: () => {} };
    renderAt("/reports/monday-showcase");
    expect(container.textContent).toContain("All departments");
    expect(container.textContent).not.toContain("Showing Service only");
  });
});

/**
 * The same shape as the caveat above, one component further out: the drawer is UI derived from a selection
 * that may have moved on since the number was clicked.
 *
 * The drawer's whole contract is that its total equals the figure that opened it. Reading the page's LIVE
 * selection at fetch time breaks that in both directions: an unfetchable selection (?routes=none, a bad
 * shared link) sends no ?routes at all, which the server reads as "all departments" — an unfiltered record
 * list behind a page that says it has no numbers to show; and a switch to the other bucket silently swaps
 * the records under an unchanged title. The request is therefore CAPTURED when the number is clicked.
 */
describe("an open evidence drawer is pinned to the selection its number was clicked under", () => {
  /** Click the first drillable figure (the Exec hero's Won tile). */
  function openDrill() {
    const drill = [...container.querySelectorAll("button")].find(
      (b) => b.getAttribute("title") === "Show the records behind this number"
    );
    if (!drill) throw new Error("no drillable number on screen");
    act(() => {
      (drill as HTMLButtonElement).click();
    });
  }
  /** Only the calls made while a request was open — the drawer is mounted (closed) the rest of the time. */
  const openCalls = () => evidenceCalls.filter((c) => c.metric !== null);

  it("fetches the drill under the selection that produced the number", () => {
    renderAt("/reports/monday-showcase?routes=service");
    openDrill();
    expect(openCalls().length).toBeGreaterThan(0);
    expect(last(openCalls())).toEqual({ metric: "won", mode: DEFAULT_WEEK_MODE, routes: ["service"] });
  });

  it("keeps that selection when the page's own selection becomes unfetchable", () => {
    renderAt("/reports/monday-showcase?routes=service");
    openDrill();
    act(() => navigateTo("/reports/monday-showcase?routes=none"));
    // The page correctly stops fetching and shows its "select at least one" panel...
    expect(last(calls).enabled).toBe(false);
    expect(container.textContent).toContain("Select at least one department");
    // ...and the open drawer must NOT drop its ?routes, which the server reads as every department.
    expect(last(openCalls()).routes).toEqual(["service"]);
  });

  it("keeps it when an invalid link replaces the selection", () => {
    renderAt("/reports/monday-showcase?routes=service");
    openDrill();
    act(() => navigateTo("/reports/monday-showcase?routes=banana"));
    expect(last(calls).enabled).toBe(false);
    expect(last(openCalls()).routes).toEqual(["service"]);
  });

  it("does not swap the records when the selection moves to the OTHER bucket", () => {
    // The positive half of the same property: an unfetchable selection could be handled by sending nothing
    // at all, which would pass the two cases above while still refetching a different slice here.
    renderAt("/reports/monday-showcase?routes=service");
    openDrill();
    act(() => navigateTo("/reports/monday-showcase?routes=other"));
    expect(last(calls).routes).toEqual(["other"]); // the PAGE follows the new selection
    expect(last(openCalls()).routes).toEqual(["service"]); // the open drill does not
  });

  it("closes captured evidence when the tenant scope changes", () => {
    renderAt("/reports/monday-showcase?officeId=office-a&routes=service");
    openDrill();
    expect(last(openCalls())).toEqual({ metric: "won", mode: DEFAULT_WEEK_MODE, routes: ["service"] });

    act(() => navigateTo("/reports/monday-showcase?officeId=office-b&routes=service"));
    // A tenant switch is different from a period or route change: the captured office-a record ids must
    // never be navigated under office-b's live URL scope, so the unconditionally mounted drawer closes.
    expect(last(evidenceCalls).metric).toBeNull();
  });

  it("pins the PERIOD the same way — one rule, so the two cannot drift apart", () => {
    // `mode` is the page's other live control, and reading it late has the identical failure: the drawer
    // would refetch another period under the title of the number that was clicked. Captured together so a
    // reader never has to ask why one is pinned and the other isn't. (A real browser's modal backdrop
    // blocks this toggle while the drawer is open; jsdom does not enforce that, so the invariant is driven
    // here directly rather than through an interaction that ships.)
    renderAt("/reports/monday-showcase?routes=service");
    openDrill();
    // Derived, never hard-coded: clicking the toggle the page is ALREADY on is a no-op that would let this
    // pass with the pinning removed (it did, until the revert-check caught it — DEFAULT_WEEK_MODE is
    // "completed", so "Last full week" changed nothing).
    const otherMode = (Object.keys(WEEK_MODE_LABELS) as WeekMode[]).find((m) => m !== DEFAULT_WEEK_MODE)!;
    const toggle = [...container.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === WEEK_MODE_LABELS[otherMode]
    );
    if (!toggle) throw new Error(`no week-mode toggle labelled "${WEEK_MODE_LABELS[otherMode]}"`);
    act(() => {
      (toggle as HTMLButtonElement).click();
    });
    expect(last(calls).mode).toBe(otherMode); // the PAGE followed the toggle — the click landed
    expect(last(openCalls()).mode).toBe(DEFAULT_WEEK_MODE); // the open drill did not
  });

  it("a drill opened under the default both-buckets selection still sends no ?routes", () => {
    // Guards the other direction: capturing must not start sending an explicit both-buckets list, which
    // would change the request every pre-filter bookmark issues.
    renderAt("/reports/monday-showcase");
    openDrill();
    expect(last(openCalls())).toEqual({ metric: "won", mode: DEFAULT_WEEK_MODE, routes: undefined });
  });
});
