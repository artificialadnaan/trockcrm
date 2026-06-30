// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { InputHTMLAttributes, ReactNode } from "react";
import { BrowserRouter, MemoryRouter, Route, Routes } from "react-router-dom";
import { DirectorRepDetail } from "./director-rep-detail";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  useRepDetailMock: vi.fn(),
  presetToDateRangeMock: vi.fn(),
  useLeadsMock: vi.fn(),
  usePipelineStagesMock: vi.fn(),
  dealsListSectionMock: vi.fn(),
}));

vi.mock("@/hooks/use-director-dashboard", () => ({
  useRepDetail: mocks.useRepDetailMock,
  presetToDateRange: mocks.presetToDateRangeMock,
}));

vi.mock("@/hooks/use-leads", () => ({
  useLeads: mocks.useLeadsMock,
  formatLeadPropertyLine: (lead: { property?: { address?: string | null } | null }) =>
    lead.property?.address ?? "Property pending",
}));

vi.mock("@/hooks/use-pipeline-config", () => ({
  usePipelineStages: mocks.usePipelineStagesMock,
  // The rep deal list now builds its shared-FilterBar options from these (#3).
  useRegions: () => ({ regions: [] }),
  useProjectTypes: () => ({ projectTypes: [] }),
}));

vi.mock("@/components/deals/deals-list-section", () => ({
  // Pure stage helpers the rep list uses to build its FilterBar stage options/terminal scope (#3).
  // The page's rep-scoping assertions don't depend on the option values, so [] is sufficient here.
  buildDealStageFilterOptions: () => [],
  getVisibleListTerminalStageIds: () => [],
  DealsListSection: (props: Record<string, unknown>) => {
    mocks.dealsListSectionMock(props);
    // The rep list is now the shared FilterBar (rep-scoped): the rep + page date window flow via
    // baseFilters (not the legacy lockedOwnerId/externalDateRange props).
    const baseFilters = props.baseFilters as
      | { assignedRepId?: string; dateFrom?: string; dateTo?: string }
      | undefined;
    return (
      <div
        data-testid="deals-list-section"
        data-owner={String(baseFilters?.assignedRepId ?? "")}
        data-date-from={baseFilters?.dateFrom ?? ""}
        data-date-to={baseFilters?.dateTo ?? ""}
      >
        Deals list
      </div>
    );
  },
}));

vi.mock("@/components/dashboard/date-range-toggle", () => ({
  DateRangeToggle: ({
    value,
    onChange,
  }: {
    value: string;
    onChange: (value: "mtd" | "qtd" | "ytd") => void;
  }) => (
    <div>
      <div>Date Range: {value}</div>
      <button type="button" onClick={() => onChange("mtd")}>
        Preset MTD
      </button>
      <button type="button" onClick={() => onChange("qtd")}>
        Preset QTD
      </button>
      <button type="button" onClick={() => onChange("ytd")}>
        Preset YTD
      </button>
    </div>
  ),
}));

vi.mock("@/components/dashboard/stat-card", () => ({
  StatCard: ({ title, value, subtitle }: { title: string; value: ReactNode; subtitle?: ReactNode }) => (
    <div>
      <h3>{title}</h3>
      <div>{value}</div>
      {subtitle ? <p>{subtitle}</p> : null}
    </div>
  ),
}));

vi.mock("@/components/dashboard/stale-deal-list", () => ({
  StaleDealList: () => <div>Stale Deals</div>,
}));

vi.mock("@/components/dashboard/stale-lead-list", () => ({
  StaleLeadList: () => <div>Stale Leads</div>,
}));

vi.mock("@/components/charts/pipeline-bar-chart", () => ({
  PipelineBarChart: () => <div>Pipeline Chart</div>,
}));

vi.mock("@/components/charts/win-rate-trend-chart", () => ({
  WinRateTrendChart: () => <div>Win Rate Trend</div>,
}));

vi.mock("@/components/charts/chart-colors", () => ({
  formatCurrency: (value: number) => `$${value.toLocaleString()}`,
}));

// The commission drill-down has its own dedicated runtime test; the page test only needs to confirm it
// mounts (the page's rep-scoping assertions don't depend on its internals).
vi.mock("@/components/director/rep-commission-drilldown", () => ({
  RepCommissionDrilldown: () => <div>Commission Breakdown</div>,
}));

vi.mock("@/components/ui/card", () => ({
  Card: ({ children, ...props }: { children: ReactNode }) => <div {...props}>{children}</div>,
  CardHeader: ({ children, ...props }: { children: ReactNode }) => <div {...props}>{children}</div>,
  CardTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  CardContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: { children: ReactNode }) => <button {...props}>{children}</button>,
}));

vi.mock("@/components/ui/input", () => ({
  Input: (props: InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value: string;
    onValueChange: (value: string) => void;
    children: ReactNode;
  }) => (
    <select value={value} onChange={(event) => onValueChange(event.target.value)}>
      {children}
    </select>
  ),
  SelectTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectValue: ({ children }: { children?: ReactNode }) => <>{children}</>,
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => (
    <option value={value}>{children}</option>
  ),
}));

function normalize(html: string) {
  return html.replace(/\s+/g, " ").trim();
}

function buildRepDetailData() {
  return {
    commissionSummary: {
      totalEarnedCommission: 12000,
      overrideEarnedCommission: 0,
      newCustomerShare: 0.25,
      commissionRate: 0.08,
      rollingFloor: 5000000,
      floorMet: false,
      floorRemaining: 4500000,
    },
    activeDeals: { count: 4, totalValue: 500000 },
    tasksToday: { overdue: 0, today: 2 },
    activityThisWeek: { calls: 35, emails: 0, meetings: 5, notes: 17, total: 57 },
    winLoss: { repName: "Kevin Scott", winRate: 66, wins: 4, losses: 2 },
    followUpCompliance: { complianceRate: 91, onTime: 10, total: 11 },
    pipelineByStage: [],
    winRateTrend: [],
    staleDeals: [],
    staleLeads: [],
  };
}

function buildLead(overrides: Record<string, unknown> = {}) {
  return {
    id: "lead-1",
    companyId: "company-1",
    propertyId: "property-1",
    primaryContactId: null,
    primaryContactRole: null,
    primaryContactRoleOtherLabel: null,
    name: "North Campus",
    stageId: "lead-stage-qualified",
    assignedRepId: "rep-1",
    assignedRepName: "Kevin Scott",
    status: "open",
    source: "Referral",
    sourceCategory: null,
    sourceDetail: null,
    description: "Qualified and ready for follow-up",
    projectTypeId: "project-type-1",
    bidDueDate: null,
    projectType: { id: "project-type-1", name: "Re-Roof", slug: "re-roof" },
    qualificationPayload: {},
    projectTypeQuestionPayload: { projectTypeId: "project-type-1", answers: {} },
    qualificationScope: null,
    qualificationBudgetAmount: "90000",
    qualificationCompanyFit: null,
    directorReviewDecision: null,
    directorReviewReason: null,
    decisionMakerName: null,
    decisionProcess: null,
    budgetStatus: null,
    incumbentVendor: null,
    unitCount: null,
    buildYear: null,
    forecastWindow: null,
    forecastCategory: null,
    forecastConfidencePercent: null,
    forecastRevenue: "90000",
    forecastGrossProfit: null,
    forecastBlockers: null,
    nextStep: null,
    nextStepDueAt: null,
    nextMilestoneAt: null,
    supportNeededType: null,
    supportNeededNotes: null,
    forecastUpdatedAt: null,
    forecastUpdatedBy: null,
    lastActivityAt: null,
    verificationStatus: "not_required",
    verificationRequiredReason: null,
    stageEnteredAt: "2026-05-01T12:00:00.000Z",
    convertedAt: null,
    isActive: true,
    createdAt: "2026-05-14T12:00:00.000Z",
    updatedAt: "2026-05-15T12:00:00.000Z",
    companyName: "Acme",
    property: {
      id: "property-1",
      name: "North Campus",
      address: "123 Palm Way",
      city: "Dallas",
      state: "TX",
      zip: "75201",
      buildYear: null,
      unitCount: null,
    },
    convertedDealId: null,
    convertedDealNumber: null,
    ...overrides,
  };
}

function renderPageHtml(initialEntry = "/director/rep/rep-1?preset=qtd") {
  return normalize(
    renderToStaticMarkup(
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/director/rep/:repId" element={<DirectorRepDetail />} />
        </Routes>
      </MemoryRouter>
    )
  );
}

async function renderPageDom(initialEntry = "/director/rep/rep-1?preset=qtd") {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root!: Root;

  await act(async () => {
    root = createRoot(container);
    root.render(
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/director" element={<div>Director Home</div>} />
          <Route path="/director/rep/:repId" element={<DirectorRepDetail />} />
          <Route path="/leads/:leadId" element={<div data-testid="lead-detail-route">Lead Detail Route</div>} />
        </Routes>
      </MemoryRouter>
    );
  });

  return {
    container,
    cleanup: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

async function renderPageWithRouter(initialEntry = "/director/rep/rep-1?preset=qtd") {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root!: Root;
  window.history.replaceState({}, "", initialEntry);

  await act(async () => {
    root = createRoot(container);
    root.render(
      <BrowserRouter>
        <Routes>
          <Route path="/director" element={<div>Director Home</div>} />
          <Route path="/director/rep/:repId" element={<DirectorRepDetail />} />
          <Route path="/leads/:leadId" element={<div data-testid="lead-detail-route">Lead Detail Route</div>} />
        </Routes>
      </BrowserRouter>
    );
  });

  return {
    container,
    cleanup: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

/** The FilterBar's host-owned Date dropdown (PresetSelect) is now the SOLE list-date control — the
 *  standalone list-range button row was removed. Tests drive a list-range change by invoking the
 *  dropdown's onChange and read its reflected value (DealsListSection is mocked, so the dropdown isn't
 *  rendered here; we exercise its captured contract instead of clicking a now-removed pill). */
function latestDateControl() {
  const calls = mocks.dealsListSectionMock.mock.calls;
  return calls[calls.length - 1]?.[0]?.filterBar?.dateControl as
    | { value?: string; options?: { value: string; label: string }[]; onChange?: (v: string) => void }
    | undefined;
}

describe("DirectorRepDetail", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = "";
    vi.setSystemTime(new Date("2026-05-21T12:00:00.000Z"));
    vi.clearAllMocks();
    mocks.presetToDateRangeMock.mockImplementation((preset: string) => {
      switch (preset) {
        case "qtd":
          return { from: "2026-04-01", to: "2026-05-21" };
        case "mtd":
          return { from: "2026-05-01", to: "2026-05-21" };
        case "ytd":
          return { from: "2026-01-01", to: "2026-05-21" };
        default:
          return { from: "2026-01-01", to: "2026-05-21" };
      }
    });
    mocks.useRepDetailMock.mockReturnValue({
      loading: false,
      error: null,
      data: buildRepDetailData(),
    });
    mocks.useLeadsMock.mockReturnValue({
      leads: [buildLead(), buildLead({ id: "lead-2", name: "Older Lead", createdAt: "2026-04-09T12:00:00.000Z" })],
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    mocks.usePipelineStagesMock.mockImplementation((workflowFamily?: string) => ({
      stages: workflowFamily === "lead"
        ? [
            { id: "lead-stage-new", name: "New Lead", slug: "new_lead", isActivePipeline: true },
            { id: "lead-stage-qualified", name: "Qualified Lead", slug: "qualified_lead", isActivePipeline: true },
          ]
        : [
            // Deal stages must be present so the rep deal list renders (it gates on the deal stage
            // config being loaded — the terminal-visibility decision depends on it; Codex P2).
            { id: "deal-stage-opp", name: "Opportunity", slug: "opportunity", isActivePipeline: true, isTerminal: false },
            { id: "deal-stage-won", name: "Won", slug: "won", isActivePipeline: true, isTerminal: true },
          ],
      loading: false,
      error: null,
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders activity labels using the selected quarter preset from the URL", () => {
    const html = renderPageHtml();

    expect(mocks.presetToDateRangeMock).toHaveBeenCalledWith("qtd");
    expect(html).toContain("Activity · QTD");
    expect(html).toContain("35 calls in this quarter");
    expect(html).toContain("Logged in this quarter across calls, emails, meetings, and notes.");
    expect(html).toContain("Follow-up Compliance · QTD");
    expect(html).toContain("Deals and Leads");
  });

  it("pre-filters the deals and leads lists to the rep and dashboard date window", () => {
    renderPageHtml("/director/rep/rep-1?preset=qtd");

    // D-15 / #3: the rep deal list is the shared FilterBar, rep-scoped — the rep is locked via
    // baseFilters.assignedRepId (the bar OMITS the Rep dimension) and the page's dashboard window
    // is the baseFilters date floor on the CANONICAL outcome axis (dateField="outcome" +
    // displayDate), matching the rep's outcome-axis KPI — not created_at filtered / Close displayed.
    const repListProps = mocks.dealsListSectionMock.mock.calls[0]?.[0] as {
      filterBar?: { dimensions?: string[]; defaultSort?: { key: string; dir: string } };
    };
    expect(mocks.dealsListSectionMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        dateField: "outcome",
        baseFilters: expect.objectContaining({
          assignedRepId: "rep-1",
          dateFrom: "2026-04-01",
          dateTo: "2026-05-21",
        }),
      })
    );
    // The rep lock: Rep is not a rendered dimension (so a stray URL rep can't override the lock),
    // and the bar defaults to the outcome display axis (Codex #564: sort == display).
    expect(repListProps.filterBar?.dimensions).not.toContain("rep");
    expect(repListProps.filterBar?.defaultSort).toEqual({ key: "display_date", dir: "desc" });
    expect(mocks.useLeadsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        assignedRepId: "rep-1",
        createdFrom: "2026-04-01",
        createdTo: "2026-05-21",
        sortBy: "created_at",
        sortDir: "desc",
      })
    );
  });

  it("gates the rep deal list until the deal stage config loads — no active-only undercount of Won/Lost (Codex P2)", () => {
    // Deal stages not yet loaded -> repTerminalStageIds would be [], so applyBoardVisibilityDefaults
    // would NOT request active+terminal visibility and the list would silently drop Won/Lost (and the
    // total would undercount). The list must NOT render/query until the stage config is available.
    mocks.usePipelineStagesMock.mockImplementation((workflowFamily?: string) => ({
      stages:
        workflowFamily === "lead"
          ? [{ id: "lead-stage-qualified", name: "Qualified Lead", slug: "qualified_lead", isActivePipeline: true }]
          : [], // deal stages still loading
      loading: workflowFamily !== "lead",
      error: null,
    }));

    const html = renderPageHtml();

    expect(mocks.dealsListSectionMock).not.toHaveBeenCalled();
    expect(html).toContain("Loading deal records");
  });

  it("keeps a date control available when the deal stage config fails — the leads list stays re-windowable (Codex P2)", async () => {
    // The deal list (and its in-bar Date dropdown) is gated on the deal stage config. The standalone
    // pill row used to cover the failure case; now the gate's fallback must still render a date control so
    // the user can re-window the leads list (which renders independently) when the deal list can't load.
    mocks.usePipelineStagesMock.mockImplementation((family?: string) => ({
      stages:
        family === "lead"
          ? [{ id: "lead-stage-qualified", name: "Qualified Lead", slug: "qualified_lead", isActivePipeline: true }]
          : [], // deal stages failed to load
      loading: false,
      error: family === "lead" ? null : "stage config unavailable",
    }));

    const page = await renderPageDom("/director/rep/rep-1?preset=qtd&listRange=dashboard");
    try {
      // The deal list itself is unavailable (it needs the stage config)…
      expect(mocks.dealsListSectionMock).not.toHaveBeenCalled();
      expect(page.container.textContent).toContain("Couldn't load pipeline stages");

      // …but a date control is STILL rendered (the six list-range presets), reflecting listRange.
      const dateSelect = Array.from(page.container.querySelectorAll("select")).find((select) =>
        select.querySelector('option[value="7d"]')
      );
      expect(dateSelect).toBeTruthy();
      expect(dateSelect?.value).toBe("dashboard");

      // Changing it still drives listRange -> the leads list re-queries with the new (WTD) window.
      const setSelectValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
      await act(async () => {
        setSelectValue?.call(dateSelect, "wtd");
        dateSelect?.dispatchEvent(new Event("change", { bubbles: true }));
      });
      expect(mocks.useLeadsMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ createdFrom: "2026-05-17", createdTo: "2026-05-21" })
      );
    } finally {
      await page.cleanup();
    }
  });

  it("updates the layered lead filters when the list range (Date dropdown) and stage filters change", async () => {
    const page = await renderPageDom();

    try {
      // The list date is now driven solely by the FilterBar Date dropdown (the pill row was removed).
      await act(async () => {
        latestDateControl()?.onChange?.("wtd");
      });

      const qualifiedStageButton = Array.from(page.container.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("Qualified Lead")
      );
      expect(qualifiedStageButton).not.toBeNull();

      await act(async () => {
        qualifiedStageButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      expect(mocks.useLeadsMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          assignedRepId: "rep-1",
          createdFrom: "2026-05-17",
          createdTo: "2026-05-21",
          stageIds: ["lead-stage-qualified"],
          status: undefined,
        })
      );
      const lastDealsListCall =
        mocks.dealsListSectionMock.mock.calls[mocks.dealsListSectionMock.mock.calls.length - 1]?.[0];
      expect(lastDealsListCall).toEqual(
        expect.objectContaining({
          baseFilters: expect.objectContaining({
            assignedRepId: "rep-1",
            dateFrom: "2026-05-17",
            dateTo: "2026-05-21",
          }),
        })
      );
    } finally {
      await page.cleanup();
    }
  });

  it("keeps quick timeline filters on the same UTC day boundaries as the dashboard presets", async () => {
    vi.setSystemTime(new Date("2026-05-22T01:30:00.000Z"));
    const page = await renderPageDom();

    try {
      await act(async () => {
        latestDateControl()?.onChange?.("7d");
      });

      expect(mocks.useLeadsMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          createdFrom: "2026-05-16",
          createdTo: "2026-05-22",
        })
      );
    } finally {
      await page.cleanup();
    }
  });

  it("shows the real label for leads in non-active-pipeline stages while keeping filter pills limited to active stages", () => {
    mocks.useLeadsMock.mockReturnValue({
      leads: [buildLead({ id: "lead-terminal", stageId: "lead-stage-disqualified" })],
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    mocks.usePipelineStagesMock.mockReturnValue({
      stages: [
        { id: "lead-stage-new", name: "New Lead", slug: "new_lead", isActivePipeline: true },
        { id: "lead-stage-qualified", name: "Qualified Lead", slug: "qualified_lead", isActivePipeline: true },
        {
          id: "lead-stage-disqualified",
          name: "Disqualified Lead",
          slug: "disqualified_lead",
          isActivePipeline: false,
        },
      ],
      loading: false,
      error: null,
    });

    const html = renderPageHtml();

    expect(html).toContain("Disqualified Lead");
    expect(html).not.toContain(">Stage<");
    expect(html).toContain("Qualified Lead");
    expect(html).not.toContain("aria-pressed=\"false\">Disqualified Lead</button>");
  });

  it("syncs the list-range control (Date dropdown) from URL changes while the route stays mounted", async () => {
    const page = await renderPageWithRouter("/director/rep/rep-1?preset=qtd&listRange=dashboard");

    try {
      expect(page.container.textContent).toContain("Current list window");
      expect(page.container.textContent).toContain("2026-04-01 to 2026-05-21");
      // The Date dropdown reflects the single source of truth (listRange) — "dashboard" before the change.
      expect(latestDateControl()?.value).toBe("dashboard");

      await act(async () => {
        window.history.pushState({}, "", "/director/rep/rep-1?preset=qtd&listRange=wtd");
        window.dispatchEvent(new PopStateEvent("popstate"));
      });

      // …and "wtd" after an external URL change (no separate local state to drift).
      expect(latestDateControl()?.value).toBe("wtd");
      expect(page.container.textContent).toContain("2026-05-17 to 2026-05-21");
      expect(mocks.useLeadsMock).toHaveBeenLastCalledWith(
        expect.objectContaining({
          createdFrom: "2026-05-17",
          createdTo: "2026-05-21",
        })
      );
      const lastDealsListCall =
        mocks.dealsListSectionMock.mock.calls[mocks.dealsListSectionMock.mock.calls.length - 1]?.[0];
      expect(lastDealsListCall).toEqual(
        expect.objectContaining({
          baseFilters: expect.objectContaining({
            dateFrom: "2026-05-17",
            dateTo: "2026-05-21",
          }),
        })
      );
    } finally {
      await page.cleanup();
    }
  });

  it("updates the URL when the list range changes via the Date dropdown", async () => {
    const page = await renderPageWithRouter("/director/rep/rep-1?preset=qtd&listRange=dashboard");

    try {
      await act(async () => {
        latestDateControl()?.onChange?.("wtd");
      });

      expect(window.location.search).toContain("listRange=wtd");
      expect(page.container.textContent).toContain("2026-05-17 to 2026-05-21");
    } finally {
      await page.cleanup();
    }
  });

  it("removes the standalone list-range button row — the FilterBar Date dropdown is the sole list-date control", async () => {
    const page = await renderPageDom("/director/rep/rep-1?preset=qtd&listRange=dashboard");

    try {
      // The list-range pills (7D / WTD / Dashboard(QTD)) are GONE. Only the KPI DateRangeToggle
      // (MTD/QTD/YTD/Last*) and the leads stage pills remain — none carry the list-range-unique labels.
      const buttonLabels = Array.from(page.container.querySelectorAll("button")).map((b) => b.textContent ?? "");
      expect(buttonLabels).not.toContain("7D");
      expect(buttonLabels.some((label) => label.includes("Dashboard ("))).toBe(false);
      // …and the host-owned Date dropdown is still the single list-date control (the six list-range presets).
      expect(latestDateControl()?.options?.map((option) => option.value)).toEqual([
        "dashboard",
        "7d",
        "wtd",
        "mtd",
        "qtd",
        "ytd",
      ]);
      expect(latestDateControl()?.value).toBe("dashboard");
    } finally {
      await page.cleanup();
    }
  });

  // Date-binding: the FilterBar's host-owned Date dropdown is the SINGLE list-date control (the standalone
  // pill row was removed). It reads/writes the one source of truth (listRange); the bar OWNS the date axis
  // (date dropped from dimensions; bound via dateControl), so its fb_date never reaches the query.
  it("binds the bar Date dropdown to listRange — the six list-range presets, date dropped from dimensions", () => {
    renderPageHtml("/director/rep/rep-1?preset=qtd&listRange=dashboard");

    const props = mocks.dealsListSectionMock.mock.calls[0]?.[0] as {
      filterBar?: {
        dimensions?: string[];
        dateControl?: { value?: string; ariaLabel?: string; options?: { value: string; label: string }[] };
      };
    };
    // Host owns the date axis -> "date" is NOT a bar dimension (so fb_date can't leak into the query).
    expect(props.filterBar?.dimensions).not.toContain("date");
    // The bar's Date dropdown is bound to listRange (default "dashboard") — the six list-range presets.
    expect(props.filterBar?.dateControl?.value).toBe("dashboard");
    expect(props.filterBar?.dateControl?.options).toEqual([
      { value: "dashboard", label: "Dashboard (QTD)" },
      { value: "7d", label: "7D" },
      { value: "wtd", label: "WTD" },
      { value: "mtd", label: "MTD" },
      { value: "qtd", label: "QTD" },
      { value: "ytd", label: "YTD" },
    ]);
  });

  it("re-labels the dropdown's Dashboard option when the KPI preset changes (listRangeDateOptions tracks preset)", async () => {
    const page = await renderPageDom("/director/rep/rep-1?preset=qtd&listRange=dashboard");

    try {
      // The Dashboard option reflects the active KPI preset (QTD) so the user sees which window it follows.
      expect(latestDateControl()?.options?.find((option) => option.value === "dashboard")?.label).toBe(
        "Dashboard (QTD)"
      );

      // Changing the top KPI DateRangeToggle preset re-labels the Dashboard option (memo dep = [preset]);
      // a broken dep array would leave it stale at "Dashboard (QTD)".
      const ytdPreset = Array.from(page.container.querySelectorAll("button")).find(
        (button) => button.textContent === "Preset YTD"
      );
      await act(async () => {
        ytdPreset?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      expect(latestDateControl()?.options?.find((option) => option.value === "dashboard")?.label).toBe(
        "Dashboard (YTD)"
      );
    } finally {
      await page.cleanup();
    }
  });

  it("changing the bar Date dropdown updates listRange — URL + the list and leads window", async () => {
    const page = await renderPageWithRouter("/director/rep/rep-1?preset=qtd&listRange=dashboard");

    try {
      const onChange = mocks.dealsListSectionMock.mock.calls[
        mocks.dealsListSectionMock.mock.calls.length - 1
      ]?.[0]?.filterBar?.dateControl?.onChange as (value: string) => void;
      expect(typeof onChange).toBe("function");

      await act(async () => {
        onChange("wtd");
      });

      // Single source of truth: the dropdown change drives listRange (URL) and the list/leads window.
      expect(window.location.search).toContain("listRange=wtd");
      expect(page.container.textContent).toContain("2026-05-17 to 2026-05-21");

      const lastProps =
        mocks.dealsListSectionMock.mock.calls[mocks.dealsListSectionMock.mock.calls.length - 1]?.[0] as {
          filterBar?: { dateControl?: { value?: string } };
          baseFilters?: { dateFrom?: string; dateTo?: string };
        };
      expect(lastProps.filterBar?.dateControl?.value).toBe("wtd");
      expect(lastProps.baseFilters?.dateFrom).toBe("2026-05-17");
      expect(lastProps.baseFilters?.dateTo).toBe("2026-05-21");
      expect(mocks.useLeadsMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ createdFrom: "2026-05-17", createdTo: "2026-05-21" })
      );
    } finally {
      await page.cleanup();
    }
  });

  it("renders newest leads first and routes rows to the lead detail page", async () => {
    mocks.useLeadsMock.mockReturnValue({
      leads: [
        buildLead({ id: "lead-older", name: "Older Lead", createdAt: "2026-04-09T12:00:00.000Z" }),
        buildLead({ id: "lead-newer", name: "Newest Lead", createdAt: "2026-05-14T12:00:00.000Z" }),
      ],
      loading: false,
      error: null,
      refetch: vi.fn(),
    });

    const page = await renderPageDom();

    try {
      const leadRows = Array.from(page.container.querySelectorAll("button[aria-label^='Open lead ']"));
      expect(leadRows[0]?.getAttribute("aria-label")).toBe("Open lead Newest Lead");
      expect(leadRows[1]?.getAttribute("aria-label")).toBe("Open lead Older Lead");

      await act(async () => {
        leadRows[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      expect(page.container.textContent).toContain("Lead Detail Route");
    } finally {
      await page.cleanup();
    }
  });

  it("renders the charts as the last section of the page", () => {
    const html = renderPageHtml("/director/rep/rep-1");
    const headings = Array.from(html.matchAll(/<h2>(.*?)<\/h2>/g)).map(
      (match: RegExpMatchArray) => match[1]
    );
    const staleDealsIndex = html.indexOf("Stale Deals");
    const staleLeadsIndex = html.indexOf("Stale Leads");
    const pipelineChartIndex = html.indexOf("Pipeline by Stage");
    const winRateTrendIndex = html.indexOf("Win Rate Trend");
    const penultimateHeading = headings[headings.length - 2];
    const lastHeading = headings[headings.length - 1];

    expect(staleDealsIndex).toBeGreaterThanOrEqual(0);
    expect(staleLeadsIndex).toBeGreaterThanOrEqual(0);
    expect(pipelineChartIndex).toBeGreaterThanOrEqual(0);
    expect(winRateTrendIndex).toBeGreaterThanOrEqual(0);
    expect(headings).toContain("Pipeline by Stage");
    expect(headings).toContain("Win Rate Trend");
    expect(staleDealsIndex).toBeLessThan(pipelineChartIndex);
    expect(staleLeadsIndex).toBeLessThan(pipelineChartIndex);
    expect(pipelineChartIndex).toBeLessThan(winRateTrendIndex);
    expect(penultimateHeading).toBe("Pipeline by Stage");
    expect(lastHeading).toBe("Win Rate Trend");
  });
});
