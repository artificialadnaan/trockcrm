// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, useNavigate } from "react-router-dom";
import {
  UNFILTERED_ROUTE_FILTER,
  type EvidenceRequest,
  type MondayShowcaseData,
} from "./monday-showcase/types";
import { emptyEstimatingReport } from "./monday-showcase/test-fixtures";
import { DEFAULT_WEEK_MODE } from "./week-mode";

const evidenceRequests: Array<EvidenceRequest | null> = [];

const payload: MondayShowcaseData = {
  period: { from: "2026-08-17", to: "2026-08-23", mode: DEFAULT_WEEK_MODE, label: "2026-08-17 → 2026-08-23" },
  departments: [],
  execHero: {
    won: { count: 0, value: { amount: 0, basisLabel: "Awarded-first won value" } },
    sent: { count: 0, value: { amount: 0, basisLabel: "Best current estimate" } },
    estimated: { count: 0, value: { amount: 0, basisLabel: "Best current estimate" } },
  },
  reps: [],
  officeProjection: {
    bands: [
      { band: "0_30", count: 1, value: 100_000 },
      { band: "31_60", count: 0, value: 0 },
      { band: "61_90", count: 0, value: 0 },
      { band: "beyond_90", count: 0, value: 0 },
    ],
    coverage: { n: 1, m: 1, undatedValue: 0 },
    coverageCaption: "1 of 1 open deals has a maintained (future-dated) expected close date.",
  },
  weeklyTrend: [],
  valueBases: { won_awarded_first: "Awarded-first won value", open_best_estimate: "Best current estimate" },
  estimatingReport: emptyEstimatingReport(),
  routeFilter: UNFILTERED_ROUTE_FILTER,
  notes: [],
};

vi.mock("@/hooks/use-reports", () => ({
  useMondayShowcase: () => ({ data: payload, loading: false, error: null, refetch: () => {} }),
}));

// The page owns this test's behavior. Record the request it hands the drawer without involving the
// drawer's unrelated fetch/edit mechanics.
vi.mock("./evidence-kit", async () => {
  const actual = await vi.importActual<typeof import("./evidence-kit")>("./evidence-kit");
  return {
    ...actual,
    EvidenceDrawer: ({ request }: { request: EvidenceRequest | null }) => {
      evidenceRequests.push(request);
      return null;
    },
  };
});

const { ForecastConfidencePage } = await import("./forecast-confidence-page");

let container: HTMLDivElement;
let root: Root;
let navigateTo: (url: string) => void = () => {
  throw new Error("Navigation probe has not rendered");
};

function NavigationProbe() {
  navigateTo = useNavigate();
  return null;
}

function renderAt(initialUrl: string) {
  act(() => {
    root.render(
      <MemoryRouter initialEntries={[initialUrl]}>
        <NavigationProbe />
        <ForecastConfidencePage />
      </MemoryRouter>
    );
  });
}

function last<T>(values: readonly T[]): T {
  const value = values[values.length - 1];
  if (value === undefined) throw new Error("no values were recorded");
  return value;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  evidenceRequests.length = 0;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("ForecastConfidencePage office scope", () => {
  it("closes captured evidence only when the normalized tenant scope changes", () => {
    renderAt("/reports/forecast-confidence?officeId=%20office-a%20");
    const drill = container.querySelector('button[title="Show the records behind this number"]');
    if (!(drill instanceof HTMLButtonElement)) throw new Error("no forecast drill rendered");

    act(() => drill.click());
    expect(last(evidenceRequests)?.metric).toBe("projection");

    // api() and useOfficeScopeId both normalize whitespace, so this does not switch tenants or close the
    // captured evidence.
    act(() => navigateTo("/reports/forecast-confidence?officeId=office-a"));
    expect(last(evidenceRequests)?.metric).toBe("projection");

    act(() => navigateTo("/reports/forecast-confidence?officeId=office-b"));
    expect(last(evidenceRequests)).toBeNull();
  });
});
