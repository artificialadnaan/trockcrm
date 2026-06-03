import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import type { TerminalDateFilter, TerminalOutcome } from "@/lib/pipeline-terminal-filters";
import {
  normalizeDealBoardResponse,
  useDealBoard,
  useDealDetail,
  useDealStagePage,
  useDeals,
  type DealFilters,
} from "./use-deals";

vi.mock("@/lib/api", () => ({
  api: vi.fn(),
}));

class FakeNode {
  nodeType = 0;
  childNodes: FakeNode[] = [];
  parentNode: FakeNode | null = null;
  ownerDocument: FakeDocument | null = null;
  listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

  appendChild(child: FakeNode) {
    child.parentNode = this;
    child.ownerDocument = this.ownerDocument;
    this.childNodes.push(child);
    return child;
  }

  removeChild(child: FakeNode) {
    this.childNodes = this.childNodes.filter((node) => node !== child);
    child.parentNode = null;
    return child;
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    const listeners = this.listeners.get(type) ?? new Set<EventListenerOrEventListenerObject>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatchEvent() {
    return true;
  }
}

class FakeElement extends FakeNode {
  nodeType = 1;
  tagName: string;
  style = {};

  constructor(tagName: string) {
    super();
    this.tagName = tagName.toUpperCase();
  }
}

class FakeText extends FakeNode {
  nodeType = 3;
  constructor(public data: string) {
    super();
  }
}

class FakeComment extends FakeNode {
  nodeType = 8;
  constructor(public data: string) {
    super();
  }
}

class FakeDocument extends FakeNode {
  nodeType = 9;
  body = new FakeElement("body");
  defaultView: FakeWindow | null = null;
  activeElement: FakeElement | null = null;

  constructor() {
    super();
    this.ownerDocument = this;
    this.body.ownerDocument = this;
  }

  createElement(tagName: string) {
    const element = new FakeElement(tagName);
    element.ownerDocument = this;
    return element;
  }

  createTextNode(data: string) {
    const node = new FakeText(data);
    node.ownerDocument = this;
    return node;
  }

  createComment(data: string) {
    const node = new FakeComment(data);
    node.ownerDocument = this;
    return node;
  }
}

class FakeWindow {
  navigator = { userAgent: "vitest" };
  HTMLElement = FakeElement;
  HTMLIFrameElement = class FakeIFrameElement extends FakeElement {};
  SVGElement = FakeElement;

  constructor(public document: FakeDocument) {}
}

function installFakeDom() {
  const document = new FakeDocument();
  const window = new FakeWindow(document);
  document.defaultView = window;

  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("Node", FakeNode);
  vi.stubGlobal("Text", FakeText);
  vi.stubGlobal("Comment", FakeComment);
  vi.stubGlobal("Element", FakeElement);
  vi.stubGlobal("HTMLElement", FakeElement);
  vi.stubGlobal("SVGElement", FakeElement);
  vi.stubGlobal("navigator", window.navigator);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("HTMLIFrameElement", window.HTMLIFrameElement);

  return { document };
}

function flushEffects() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

let latestResult: ReturnType<typeof useDealBoard> | null = null;
let latestDealsResult: ReturnType<typeof useDeals> | null = null;
let hookTerminalDateFilters: Record<TerminalOutcome, TerminalDateFilter> | undefined;
let hookPreviewLimit: number | null | undefined;
let hookWonPeriodRange: { from?: string; to?: string } | null | undefined;
let hookStageWonSince: string | undefined;
let hookDealFilters: DealFilters = {};
let hookDealDetailOfficeId: string | null | undefined;

function HookProbe() {
  latestResult = useDealBoard("mine", false, hookTerminalDateFilters, hookPreviewLimit, hookWonPeriodRange);
  return null;
}

function StageHookProbe() {
  useDealStagePage({
    stageId: "stage-won",
    scope: "all",
    page: 1,
    pageSize: 25,
    sort: "age_desc",
    search: "",
    filters: {
      staleOnly: false,
      wonSince: "2026-04-01",
      wonUntil: "2026-04-30",
    },
  });
  return null;
}

function StageWindowDepsProbe() {
  useDealStagePage({
    stageId: "stage-won",
    scope: "all",
    page: 1,
    pageSize: 25,
    sort: "age_desc",
    search: "",
    filters: { staleOnly: false, wonSince: hookStageWonSince },
  });
  return null;
}

function StageListFiltersProbe() {
  useDealStagePage({
    stageId: "stage-estimating",
    scope: "all",
    page: 1,
    pageSize: 25,
    sort: "newest",
    search: "",
    filters: { staleOnly: false, projectTypeId: "type-1", valueMin: "1000", valueMax: "50000" },
  });
  return null;
}

function DealsHookProbe() {
  latestDealsResult = useDeals(hookDealFilters);
  return null;
}

function DealDetailHookProbe() {
  useDealDetail("deal-1", { officeId: hookDealDetailOfficeId });
  return null;
}

async function renderHook() {
  const { document } = installFakeDom();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);

  await act(async () => {
    root.render(createElement(HookProbe));
    await flushEffects();
  });

  return root;
}

async function renderStageHook() {
  const { document } = installFakeDom();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);

  await act(async () => {
    root.render(createElement(StageHookProbe));
    await flushEffects();
  });

  return root;
}

async function renderDealsHook() {
  const { document } = installFakeDom();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);

  await act(async () => {
    root.render(createElement(DealsHookProbe));
    await flushEffects();
  });

  return root;
}

async function renderDealDetailHook() {
  const { document } = installFakeDom();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);

  await act(async () => {
    root.render(createElement(DealDetailHookProbe));
    await flushEffects();
  });

  return root;
}

async function waitForIdle() {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (latestResult && !latestResult.loading) return;
    await act(async () => {
      await flushEffects();
    });
  }
}

describe("normalizeDealBoardResponse", () => {
  beforeEach(() => {
    latestResult = null;
    latestDealsResult = null;
    hookTerminalDateFilters = undefined;
    hookPreviewLimit = undefined;
    hookWonPeriodRange = undefined;
    hookDealFilters = {};
    hookDealDetailOfficeId = undefined;
    vi.clearAllMocks();
  });

  it("maps server pipeline columns with `deals` arrays into board columns with `cards`", () => {
    const result = normalizeDealBoardResponse({
      pipelineColumns: [
        {
          stage: { id: "stage-1", name: "Open", slug: "open" },
          count: 1,
          totalValue: 5000,
          deals: [
            {
              id: "deal-1",
              dealNumber: "D-1",
              name: "Example Deal",
              stageId: "stage-1",
              pipelineDisposition: "deals",
              workflowRoute: "normal",
              isBidBoardOwned: false,
              bidBoardStageSlug: null,
              readOnlySyncedAt: null,
              assignedRepId: "rep-1",
              companyId: null,
              propertyId: null,
              sourceLeadId: null,
              primaryContactId: null,
              ddEstimate: null,
              bidEstimate: "5000",
              awardedAmount: null,
              changeOrderTotal: null,
              description: null,
              propertyAddress: null,
              propertyCity: null,
              propertyState: null,
              propertyZip: null,
              projectTypeId: null,
              regionId: null,
              source: null,
              winProbability: null,
              decisionMakerName: null,
              decisionProcess: null,
              budgetStatus: null,
              incumbentVendor: null,
              unitCount: null,
              buildYear: null,
              forecastWindow: null,
              forecastCategory: null,
              forecastConfidencePercent: null,
              forecastRevenue: null,
              forecastGrossProfit: null,
              forecastBlockers: null,
              nextStep: null,
              nextStepDueAt: null,
              nextMilestoneAt: null,
              supportNeededType: null,
              supportNeededNotes: null,
              forecastUpdatedAt: null,
              forecastUpdatedBy: null,
              procoreProjectId: null,
              procoreBidId: null,
              procoreLastSyncedAt: null,
              lostReasonId: null,
              lostNotes: null,
              lostCompetitor: null,
              lostAt: null,
              expectedCloseDate: null,
              actualCloseDate: null, contractSignedDate: null,
              lastActivityAt: null,
              stageEnteredAt: "2026-04-21T00:00:00.000Z",
              isActive: true,
              hubspotDealId: null,
              isHubspotSourced: false,
              createdAt: "2026-04-21T00:00:00.000Z",
              updatedAt: "2026-04-21T00:00:00.000Z",
            },
          ],
        },
      ],
      columns: [
        {
          stage: { id: "stage-1", name: "Open", slug: "open" },
          count: 1,
          totalValue: 5000,
          deals: [
            {
              id: "deal-1",
              dealNumber: "D-1",
              name: "Example Deal",
              stageId: "stage-1",
              pipelineDisposition: "deals",
              workflowRoute: "normal",
              isBidBoardOwned: false,
              bidBoardStageSlug: null,
              readOnlySyncedAt: null,
              assignedRepId: "rep-1",
              companyId: null,
              propertyId: null,
              sourceLeadId: null,
              primaryContactId: null,
              ddEstimate: null,
              bidEstimate: "5000",
              awardedAmount: null,
              changeOrderTotal: null,
              description: null,
              propertyAddress: null,
              propertyCity: null,
              propertyState: null,
              propertyZip: null,
              projectTypeId: null,
              regionId: null,
              source: null,
              winProbability: null,
              decisionMakerName: null,
              decisionProcess: null,
              budgetStatus: null,
              incumbentVendor: null,
              unitCount: null,
              buildYear: null,
              forecastWindow: null,
              forecastCategory: null,
              forecastConfidencePercent: null,
              forecastRevenue: null,
              forecastGrossProfit: null,
              forecastBlockers: null,
              nextStep: null,
              nextStepDueAt: null,
              nextMilestoneAt: null,
              supportNeededType: null,
              supportNeededNotes: null,
              forecastUpdatedAt: null,
              forecastUpdatedBy: null,
              procoreProjectId: null,
              procoreBidId: null,
              procoreLastSyncedAt: null,
              lostReasonId: null,
              lostNotes: null,
              lostCompetitor: null,
              lostAt: null,
              expectedCloseDate: null,
              actualCloseDate: null, contractSignedDate: null,
              lastActivityAt: null,
              stageEnteredAt: "2026-04-21T00:00:00.000Z",
              isActive: true,
              hubspotDealId: null,
              isHubspotSourced: false,
              createdAt: "2026-04-21T00:00:00.000Z",
              updatedAt: "2026-04-21T00:00:00.000Z",
            },
          ],
        },
      ],
      terminalStages: [],
    });

    expect(result.columns[0].cards).toHaveLength(1);
    expect(result.columns[0].cards[0].id).toBe("deal-1");
  });

  it("loads deal detail with x-office-id when an office context is provided", async () => {
    const apiMock = vi.mocked(api);
    apiMock.mockResolvedValueOnce({ deal: { id: "deal-1" } });
    hookDealDetailOfficeId = "office-atlanta";

    const root = await renderDealDetailHook();

    expect(apiMock).toHaveBeenCalledWith("/deals/deal-1/detail", {
      headers: { "x-office-id": "office-atlanta" },
    });

    await act(async () => {
      root.unmount();
      await flushEffects();
    });
    vi.unstubAllGlobals();
  });

  it("captures board load errors on mount while preserving manual refetch failures", async () => {
    const apiMock = vi.mocked(api);
    apiMock.mockRejectedValueOnce(new Error("Deal board failed"));
    apiMock.mockRejectedValueOnce(new Error("Deal board failed"));

    const root = await renderHook();
    await waitForIdle();

    expect(latestResult?.error).toBe("Deal board failed");
    let manualRefetchError: unknown = null;
    await act(async () => {
      try {
        await latestResult!.refetch();
      } catch (error) {
        manualRefetchError = error;
      }
      await flushEffects();
    });
    expect(manualRefetchError).toBeInstanceOf(Error);
    expect((manualRefetchError as Error).message).toBe("Deal board failed");
    await waitForIdle();
    expect(latestResult?.error).toBe("Deal board failed");

    await act(async () => {
      root.unmount();
      await flushEffects();
    });
    vi.unstubAllGlobals();
  });

  it("clears stale board data when a refetch fails after a successful load", async () => {
    const apiMock = vi.mocked(api);
    const initialBoardPayload = {
      pipelineColumns: [
        {
          stage: { id: "stage-1", name: "Open", slug: "open" },
          count: 1,
          totalValue: 5000,
          deals: [
            {
              id: "deal-1",
              dealNumber: "D-1",
              name: "Example Deal",
              stageId: "stage-1",
              pipelineDisposition: "deals",
              workflowRoute: "normal",
              isBidBoardOwned: false,
              bidBoardStageSlug: null,
              readOnlySyncedAt: null,
              assignedRepId: "rep-1",
              companyId: null,
              propertyId: null,
              sourceLeadId: null,
              primaryContactId: null,
              ddEstimate: null,
              bidEstimate: "5000",
              awardedAmount: null,
              changeOrderTotal: null,
              description: null,
              propertyAddress: null,
              propertyCity: null,
              propertyState: null,
              propertyZip: null,
              projectTypeId: null,
              regionId: null,
              source: null,
              winProbability: null,
              decisionMakerName: null,
              decisionProcess: null,
              budgetStatus: null,
              incumbentVendor: null,
              unitCount: null,
              buildYear: null,
              forecastWindow: null,
              forecastCategory: null,
              forecastConfidencePercent: null,
              forecastRevenue: null,
              forecastGrossProfit: null,
              forecastBlockers: null,
              nextStep: null,
              nextStepDueAt: null,
              nextMilestoneAt: null,
              supportNeededType: null,
              supportNeededNotes: null,
              forecastUpdatedAt: null,
              forecastUpdatedBy: null,
              procoreProjectId: null,
              procoreBidId: null,
              procoreLastSyncedAt: null,
              lostReasonId: null,
              lostNotes: null,
              lostCompetitor: null,
              lostAt: null,
              expectedCloseDate: null,
              actualCloseDate: null,
              contractSignedDate: null,
              lastActivityAt: null,
              stageEnteredAt: "2026-04-21T00:00:00.000Z",
              isActive: true,
              hubspotDealId: null,
              isHubspotSourced: false,
              createdAt: "2026-04-21T00:00:00.000Z",
              updatedAt: "2026-04-21T00:00:00.000Z",
            },
          ],
        },
      ],
      terminalStages: [],
    };
    apiMock.mockImplementation(async () => initialBoardPayload);

    const root = await renderHook();
    await waitForIdle();

    expect(latestResult?.board?.columns[0]?.cards).toHaveLength(1);

    apiMock.mockRejectedValueOnce(new Error("Deal board failed"));

    let manualRefetchError: unknown = null;
    await act(async () => {
      try {
        await latestResult!.refetch();
      } catch (error) {
        manualRefetchError = error;
      }
      await flushEffects();
    });

    expect(manualRefetchError).toBeInstanceOf(Error);
    expect((manualRefetchError as Error).message).toBe("Deal board failed");
    await waitForIdle();
    expect(latestResult?.error).toBe("Deal board failed");
    expect(latestResult?.board).toBeNull();

    await act(async () => {
      root.unmount();
      await flushEffects();
    });
    vi.unstubAllGlobals();
  });

  it("adds terminal date filters to the board request when provided", async () => {
    const apiMock = vi.mocked(api);
    apiMock.mockResolvedValueOnce({
      pipelineColumns: [],
      terminalStages: [],
    });
    hookTerminalDateFilters = {
      won: { preset: "60" },
      lost: { preset: "custom", customStart: "2026-04-01", customEnd: "2026-04-30" },
    };

    const root = await renderHook();
    await waitForIdle();

    expect(apiMock).toHaveBeenCalledTimes(1);
    const requestPath = String(apiMock.mock.calls[0]?.[0]);
    expect(requestPath).toContain("/deals/pipeline?");
    expect(requestPath).toContain("scope=mine");
    expect(requestPath).toContain("includeDd=false");
    expect(requestPath).toContain("previewLimit=8");
    expect(requestPath).toMatch(/won_since=\d{4}-\d{2}-\d{2}/);
    expect(requestPath).toContain("lost_since=2026-04-01");
    expect(requestPath).toContain("lost_until=2026-04-30");

    await act(async () => {
      root.unmount();
      await flushEffects();
    });
    vi.unstubAllGlobals();
  });

  it("adds the won period range to the board request when provided", async () => {
    const apiMock = vi.mocked(api);
    apiMock.mockResolvedValueOnce({
      pipelineColumns: [],
      terminalStages: [],
    });
    hookWonPeriodRange = {
      from: "2026-04-01",
      to: "2026-04-30",
    };

    const root = await renderHook();
    await waitForIdle();

    expect(apiMock).toHaveBeenCalledTimes(1);
    const requestPath = String(apiMock.mock.calls[0]?.[0]);
    expect(requestPath).toContain("/deals/pipeline?");
    expect(requestPath).toContain("won_period_from=2026-04-01");
    expect(requestPath).toContain("won_period_to=2026-04-30");

    await act(async () => {
      root.unmount();
      await flushEffects();
    });
    vi.unstubAllGlobals();
  });

  it("passes a larger previewLimit when the caller requests a drill-down board window", async () => {
    const apiMock = vi.mocked(api);
    apiMock.mockResolvedValueOnce({
      pipelineColumns: [],
      terminalStages: [],
    });
    hookTerminalDateFilters = undefined;
    hookPreviewLimit = 1000;

    const root = await renderHook();
    await waitForIdle();

    const requestPath = String(apiMock.mock.calls[apiMock.mock.calls.length - 1]?.[0]);
    expect(requestPath).toContain("/deals/pipeline?");
    expect(requestPath).toContain("previewLimit=1000");

    await act(async () => {
      root.unmount();
      await flushEffects();
    });
    vi.unstubAllGlobals();
    hookPreviewLimit = undefined;
  });

  it("passes terminal date filters through to deal stage drill-down requests", async () => {
    const apiMock = vi.mocked(api);
    apiMock.mockResolvedValueOnce({
      stage: { id: "stage-won", name: "Won", slug: "won" },
      summary: { count: 2, totalValue: 400000, averageDaysInStage: 3 },
      pagination: { page: 1, pageSize: 25, total: 2, totalPages: 1 },
      rows: [],
    });

    const root = await renderStageHook();

    expect(apiMock).toHaveBeenCalledTimes(1);
    const requestPath = String(apiMock.mock.calls[0]?.[0]);
    expect(requestPath).toContain("/deals/stages/stage-won?");
    expect(requestPath).toContain("scope=all");
    expect(requestPath).toContain("won_since=2026-04-01");
    expect(requestPath).toContain("won_until=2026-04-30");

    await act(async () => {
      root.unmount();
      await flushEffects();
    });
    vi.unstubAllGlobals();
  });

  it("passes type + value-range filters through to the stage drill-down request", async () => {
    const apiMock = vi.mocked(api);
    apiMock.mockResolvedValueOnce({
      stage: { id: "stage-estimating", name: "Estimating", slug: "estimating" },
      summary: { count: 1, totalValue: 15000, averageDaysInStage: 3 },
      pagination: { page: 1, pageSize: 25, total: 1, totalPages: 1 },
      rows: [],
    });

    const { document } = installFakeDom();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    await act(async () => {
      root.render(createElement(StageListFiltersProbe));
      await flushEffects();
    });

    expect(apiMock).toHaveBeenCalledTimes(1);
    const requestPath = String(apiMock.mock.calls[0]?.[0]);
    expect(requestPath).toContain("/deals/stages/stage-estimating?");
    expect(requestPath).toContain("projectTypeId=type-1");
    expect(requestPath).toContain("valueMin=1000");
    expect(requestPath).toContain("valueMax=50000");

    await act(async () => {
      root.unmount();
      await flushEffects();
    });
    vi.unstubAllGlobals();
  });

  it("refetches the stage summary when the Won window changes (deps include the terminal window)", async () => {
    const apiMock = vi.mocked(api);
    apiMock.mockResolvedValue({
      stage: { id: "stage-won", name: "Won", slug: "won" },
      summary: { count: 1, totalValue: 1, averageDaysInStage: 1 },
      pagination: { page: 1, pageSize: 25, total: 1, totalPages: 1 },
      rows: [],
    });
    hookStageWonSince = "2026-04-01";

    const { document } = installFakeDom();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    await act(async () => {
      root.render(createElement(StageWindowDepsProbe));
      await flushEffects();
    });
    expect(apiMock).toHaveBeenCalledTimes(1);
    expect(String(apiMock.mock.calls[0]?.[0])).toContain("won_since=2026-04-01");

    // Change ONLY the Won window and re-render: the header summary must refetch so it can't go stale
    // against the list/board. Before the fix, wonSince/wonUntil were absent from the effect deps.
    hookStageWonSince = "2026-01-01";
    await act(async () => {
      root.render(createElement(StageWindowDepsProbe));
      await flushEffects();
    });
    expect(apiMock).toHaveBeenCalledTimes(2);
    expect(String(apiMock.mock.calls[1]?.[0])).toContain("won_since=2026-01-01");

    await act(async () => {
      root.unmount();
      await flushEffects();
    });
    vi.unstubAllGlobals();
  });
});

describe("useDeals", () => {
  beforeEach(() => {
    latestDealsResult = null;
    hookDealFilters = {};
    vi.clearAllMocks();
  });

  it("ignores stale responses when scope changes rapidly", async () => {
    const pending = new Map<string, (value: unknown) => void>();
    vi.mocked(api).mockImplementation((path: string) => {
      const scope = new URLSearchParams(path.split("?")[1] ?? "").get("scope") ?? "none";
      return new Promise((resolve) => {
        pending.set(scope, resolve);
      }) as Promise<unknown>;
    });

    hookDealFilters = { scope: "mine" };
    const root = await renderDealsHook();

    hookDealFilters = { scope: "team" };
    await act(async () => {
      root.render(createElement(DealsHookProbe));
      await flushEffects();
    });

    hookDealFilters = { scope: "all" };
    await act(async () => {
      root.render(createElement(DealsHookProbe));
      await flushEffects();
    });

    await act(async () => {
      pending.get("all")?.({
        deals: [{ id: "deal-all", name: "All scoped deal" }],
        pagination: { page: 1, limit: 50, total: 1, totalPages: 1 },
      });
      await flushEffects();
    });

    expect(latestDealsResult?.deals.map((deal) => deal.id)).toEqual(["deal-all"]);

    await act(async () => {
      pending.get("team")?.({
        deals: [{ id: "deal-team", name: "Team scoped deal" }],
        pagination: { page: 1, limit: 50, total: 1, totalPages: 1 },
      });
      pending.get("mine")?.({
        deals: [{ id: "deal-mine", name: "Mine scoped deal" }],
        pagination: { page: 1, limit: 50, total: 1, totalPages: 1 },
      });
      await flushEffects();
    });

    expect(latestDealsResult?.deals.map((deal) => deal.id)).toEqual(["deal-all"]);
    await act(async () => {
      root.unmount();
    });
  });

  // Proving-ground guarantee for the unified search rollout: debounce reduces but does not
  // eliminate out-of-order responses on fast typing, so the deals search must be last-write-
  // wins. A slow response for an EARLIER keystroke must not overwrite the results of a LATER
  // one. (Backed by useDeals' requestIdRef sequencing, which is dependency-agnostic.)
  it("ignores a stale earlier-keystroke search response so it cannot overwrite a later one", async () => {
    const pending = new Map<string, (value: unknown) => void>();
    vi.mocked(api).mockImplementation((path: string) => {
      const term = new URLSearchParams(path.split("?")[1] ?? "").get("search") ?? "none";
      return new Promise((resolve) => {
        pending.set(term, resolve);
      }) as Promise<unknown>;
    });

    hookDealFilters = { search: "ac" };
    const root = await renderDealsHook();

    hookDealFilters = { search: "acm" };
    await act(async () => {
      root.render(createElement(DealsHookProbe));
      await flushEffects();
    });

    hookDealFilters = { search: "acme" };
    await act(async () => {
      root.render(createElement(DealsHookProbe));
      await flushEffects();
    });

    // The latest keystroke ("acme") resolves first.
    await act(async () => {
      pending.get("acme")?.({
        deals: [{ id: "deal-acme", name: "Acme deal" }],
        pagination: { page: 1, limit: 50, total: 1, totalPages: 1 },
      });
      await flushEffects();
    });
    expect(latestDealsResult?.deals.map((deal) => deal.id)).toEqual(["deal-acme"]);

    // The slow earlier-keystroke responses arrive LATE and must NOT overwrite "acme".
    await act(async () => {
      pending.get("ac")?.({
        deals: [{ id: "deal-ac", name: "Earlier ac" }],
        pagination: { page: 1, limit: 50, total: 1, totalPages: 1 },
      });
      pending.get("acm")?.({
        deals: [{ id: "deal-acm", name: "Earlier acm" }],
        pagination: { page: 1, limit: 50, total: 1, totalPages: 1 },
      });
      await flushEffects();
    });
    expect(latestDealsResult?.deals.map((deal) => deal.id)).toEqual(["deal-acme"]);

    await act(async () => {
      root.unmount();
    });
  });
});
