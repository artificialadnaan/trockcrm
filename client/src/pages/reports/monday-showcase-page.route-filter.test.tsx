// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation } from "react-router-dom";
import { UNFILTERED_ROUTE_FILTER, type MondayShowcaseData, type RouteBucket } from "./monday-showcase/types";
import { DEFAULT_WEEK_MODE } from "./week-mode";

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
      return { data: enabled ? payload : null, loading: false, error: null, refetch: () => {} };
    },
    useShowcaseEvidence: () => ({ data: null, loading: false, error: null, refetch: () => {} }),
  };
});

vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: { id: "u1", role: "director" } }) }));

// Imported after the mocks so the page picks them up.
const { MondayShowcasePage } = await import("./monday-showcase-page");

let container: HTMLDivElement;
let root: Root;
let currentSearch = "";

function LocationProbe() {
  currentSearch = useLocation().search;
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

/** The chip buttons, by their visible label. */
function chip(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
  if (!found) throw new Error(`no chip labelled "${label}"`);
  return found as HTMLButtonElement;
}

beforeEach(() => {
  calls.length = 0;
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
