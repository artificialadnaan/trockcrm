// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ api: vi.fn() }));

vi.mock("@/lib/api", () => ({ api: mocks.api }));

import { useQcScorecards, type QcScorecardFilters } from "./use-qc-scorecards";

let container: HTMLDivElement;
let root: Root;
let latest: ReturnType<typeof useQcScorecards> | null = null;

function Probe({ filters }: { filters: QcScorecardFilters }) {
  latest = useQcScorecards(filters);
  return null;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  latest = null;
  mocks.api.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("useQcScorecards", () => {
  it("sends the scorecard kind to the server and retains leadership scoring metadata", async () => {
    mocks.api.mockResolvedValue({
      data: {
        scorecards: [{
          scorecardId: "scorecard-leadership",
          dealId: "deal-1",
          projectName: "Tides North Dallas Fire Demo",
          projectNumber: "DFW-100",
          regionName: "Dallas",
          superintendentName: "Adam Shaw",
          kind: "leadership",
          totalScore: 85,
          formVersion: 2,
          averageScore: 8.5,
          rating: "on_standard",
          deficiencyCount: 0,
          weekOf: "2026-07-14",
          submittedAt: "2026-07-14T18:34:03.000Z",
          submittedByName: "Adam Shaw",
          pdfAvailable: true,
        }],
        regions: ["Dallas"],
        superintendents: ["Adam Shaw"],
        truncated: false,
      },
    });

    act(() => root.render(
      <MemoryRouter initialEntries={["/projects/qc-reports?officeId=office-dallas"]}>
        <Probe filters={{ from: "2026-07-01", to: "2026-07-31", kind: "leadership" }} />
      </MemoryRouter>,
    ));
    await flush();

    expect(mocks.api).toHaveBeenCalledWith(
      "/reports/qc-scorecards?from=2026-07-01&to=2026-07-31&kind=leadership",
    );
    expect(latest?.scorecards[0]).toMatchObject({
      kind: "leadership",
      formVersion: 2,
      averageScore: 8.5,
    });
  });
});
