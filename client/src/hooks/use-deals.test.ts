import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import { normalizeDealBoardResponse, useDealBoard } from "./use-deals";

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

function HookProbe() {
  latestResult = useDealBoard("mine", false);
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
              workflowRoute: "estimating",
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
              lastActivityAt: null,
              stageEnteredAt: "2026-04-21T00:00:00.000Z",
              isActive: true,
              hubspotDealId: null,
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
              workflowRoute: "estimating",
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
              lastActivityAt: null,
              stageEnteredAt: "2026-04-21T00:00:00.000Z",
              isActive: true,
              hubspotDealId: null,
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
});
