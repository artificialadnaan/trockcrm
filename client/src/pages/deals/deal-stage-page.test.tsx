import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

const mocks = vi.hoisted(() => ({
  useDealStagePageMock: vi.fn(),
  useNormalizedStageRouteMock: vi.fn(),
  useRegionsMock: vi.fn(),
  useProjectTypesMock: vi.fn(),
  useTaskAssigneesMock: vi.fn(),
  useAuthMock: vi.fn(),
  dealsListSectionMock: vi.fn(),
}));

vi.mock("@/hooks/use-deals", () => ({ useDealStagePage: mocks.useDealStagePageMock }));
vi.mock("@/lib/pipeline-scope", () => ({ useNormalizedStageRoute: mocks.useNormalizedStageRouteMock }));
vi.mock("@/hooks/use-pipeline-config", () => ({
  useRegions: mocks.useRegionsMock,
  useProjectTypes: mocks.useProjectTypesMock,
}));
vi.mock("@/hooks/use-task-assignees", () => ({ useTaskAssignees: mocks.useTaskAssigneesMock }));
vi.mock("@/lib/auth", () => ({ useAuth: mocks.useAuthMock }));
vi.mock("@/components/pipeline/pipeline-stage-page-header", () => ({
  PipelineStagePageHeader: ({
    children,
    backTo,
    title,
    subtitle,
    summary,
  }: {
    children: ReactNode;
    backTo: string;
    title: string;
    subtitle?: string;
    summary?: ReactNode;
  }) => (
    <div>
      <a href={backTo}>Back to board</a>
      <h1>{title}</h1>
      {subtitle ? <p>{subtitle}</p> : null}
      {summary}
      {children}
    </div>
  ),
}));
vi.mock("@/components/deals/deals-list-section", () => ({
  DealsListSection: (props: Record<string, unknown>) => {
    mocks.dealsListSectionMock(props);
    return <section data-testid="deals-list-section" />;
  },
}));

import { DealStagePage } from "./deal-stage-page";

const lastListProps = () =>
  mocks.dealsListSectionMock.mock.calls[mocks.dealsListSectionMock.mock.calls.length - 1]?.[0] as Record<
    string,
    any
  >;

function renderStage(path = "/deals/stages/stage-estimating?scope=team") {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/deals/stages/:stageId" element={<DealStagePage />} />
      </Routes>
    </MemoryRouter>
  );
}

function setStage(stage: { id: string; name: string; slug: string }) {
  mocks.useDealStagePageMock.mockReturnValue({
    loading: false,
    error: null,
    data: {
      stage,
      summary: { count: 1, totalValue: 15000, averageDaysInStage: 4 },
      pagination: { page: 1, pageSize: 25, total: 1, totalPages: 1 },
      rows: [],
    },
  });
}

describe("DealStagePage", () => {
  beforeEach(() => {
    mocks.dealsListSectionMock.mockReset();
    mocks.useRegionsMock.mockReturnValue({ regions: [{ id: "region-1", name: "Dallas" }] });
    mocks.useProjectTypesMock.mockReturnValue({ projectTypes: [{ id: "type-1", name: "Multifamily" }] });
    mocks.useTaskAssigneesMock.mockReturnValue({ assignees: [{ id: "rep-1", displayName: "Alex Rep" }] });
    mocks.useAuthMock.mockReturnValue({ user: { role: "admin" } });
    mocks.useNormalizedStageRouteMock.mockReturnValue({
      needsRedirect: false,
      redirectTo: "/deals/stages/stage-estimating?scope=team",
      backTo: "/deals?scope=team",
      query: { scope: "team", page: 1 },
      onPageChange: vi.fn(),
    });
    setStage({ id: "stage-estimating", name: "Estimating", slug: "estimating" });
  });

  it("keeps the stage summary header + back link (whole-stage totals)", () => {
    const html = renderStage();
    expect(html).toContain("Back to board");
    expect(html).toContain("/deals?scope=team");
    expect(html).toContain("Estimating");
    expect(html).toContain("Stage value");
    expect(html).toContain("Avg. visible age");
  });

  it("mounts the shared FilterBar (fb_ namespace, outcome-aware) in place of the legacy grid", () => {
    renderStage();
    const props = lastListProps();
    expect(props.filterBar.paramPrefix).toBe("fb_");
    expect(props.filterBar.stageEntryDateEnabled).toBe(true);
    expect(props.scope).toBe("team");
  });

  it("pins the route's stage: no stage dimension, defaultStageIds + baseFilters scoped to it", () => {
    renderStage();
    const props = lastListProps();
    expect(props.filterBar.dimensions).not.toContain("stage");
    expect(props.filterBar.defaultStageIds).toEqual(["stage-estimating"]);
    expect(props.baseFilters).toEqual({ stageIds: ["stage-estimating"] });
  });

  it("folds the bespoke rep select into the bar for admins, omits it for non-admins", () => {
    renderStage();
    expect(lastListProps().filterBar.dimensions).toContain("rep");

    mocks.dealsListSectionMock.mockReset();
    mocks.useAuthMock.mockReturnValue({ user: { role: "sales" } });
    renderStage();
    expect(lastListProps().filterBar.dimensions).not.toContain("rep");
  });

  it("flags a terminal stage so terminal deals flow through (inactiveStageIds via terminalStageIds)", () => {
    setStage({ id: "stage-won", name: "Won", slug: "won" });
    renderStage("/deals/stages/stage-won?scope=team");
    expect(lastListProps().filterBar.terminalStageIds).toEqual(["stage-won"]);
  });

  it("leaves an active stage's terminalStageIds empty", () => {
    renderStage();
    expect(lastListProps().filterBar.terminalStageIds).toEqual([]);
  });

  it("renders a stage error when the stage query fails", () => {
    mocks.useDealStagePageMock.mockReturnValue({ data: null, loading: false, error: "Failed to load stage" });
    expect(renderStage()).toContain("Failed to load stage");
  });
});
