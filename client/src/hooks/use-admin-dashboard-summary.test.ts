import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

const apiMock = vi.hoisted(() => vi.fn());
const hookState = vi.hoisted(() => ({
  aiQueue: {
    queue: [] as Array<unknown>,
    loading: false,
  },
  interventions: {
    data: {
      items: [] as Array<unknown>,
      totalCount: 4,
      page: 1,
      pageSize: 1,
    },
    loading: false,
  },
  exceptions: {
    exceptions: [] as Array<{ count: number }>,
    loading: false,
  },
  duplicateQueue: {
    pagination: { page: 1, limit: 20, total: 3, totalPages: 1 },
    loading: false,
  },
  disconnectDashboard: {
    dashboard: { summary: { totalDisconnects: 8 } },
    loading: false,
  },
  directorDashboard: {
    data: {
      ddVsPipeline: {
        ddValue: 0,
        ddCount: 0,
        pipelineValue: 0,
        pipelineCount: 0,
        totalValue: 240000,
        totalCount: 7,
      },
    },
    loading: false,
  },
}));

vi.mock("@/lib/api", () => ({
  api: apiMock,
}));

vi.mock("@/hooks/use-ai-ops", () => ({
  useAiActionQueue: vi.fn(() => hookState.aiQueue),
  useSalesProcessDisconnectDashboard: vi.fn(() => hookState.disconnectDashboard),
}));

vi.mock("@/hooks/use-admin-interventions", () => ({
  useAdminInterventions: vi.fn(() => hookState.interventions),
}));

vi.mock("@/hooks/use-migration", () => ({
  useMigrationExceptions: vi.fn(() => hookState.exceptions),
}));

vi.mock("@/hooks/use-duplicate-queue", () => ({
  useDuplicateQueue: vi.fn(() => hookState.duplicateQueue),
}));

vi.mock("@/hooks/use-director-dashboard", () => ({
  presetToDateRange: vi.fn(() => ({ from: "2026-01-01", to: "2026-12-31" })),
  useDirectorDashboard: vi.fn(() => hookState.directorDashboard),
}));

import { useAdminDashboardSummary } from "./use-admin-dashboard-summary";

class FakeNode {
  parentNode: FakeNode | null = null;
  childNodes: FakeNode[] = [];
  ownerDocument: FakeDocument | null = null;

  constructor(public nodeType: number, public nodeName: string) {}

  appendChild<T extends FakeNode>(child: T) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  insertBefore<T extends FakeNode>(child: T, before: FakeNode | null) {
    if (before == null) return this.appendChild(child);
    if (child.parentNode) child.parentNode.removeChild(child);
    const index = this.childNodes.indexOf(before);
    child.parentNode = this;
    if (index === -1) {
      this.childNodes.push(child);
    } else {
      this.childNodes.splice(index, 0, child);
    }
    return child;
  }

  removeChild<T extends FakeNode>(child: T) {
    const index = this.childNodes.indexOf(child);
    if (index !== -1) {
      this.childNodes.splice(index, 1);
      child.parentNode = null;
    }
    return child;
  }

  addEventListener() {}
  removeEventListener() {}
}

class FakeText extends FakeNode {
  constructor(public data: string, ownerDocument: FakeDocument | null) {
    super(3, "#text");
    this.ownerDocument = ownerDocument;
  }
}

class FakeComment extends FakeNode {
  constructor(public data: string, ownerDocument: FakeDocument | null) {
    super(8, "#comment");
    this.ownerDocument = ownerDocument;
  }
}

class FakeElement extends FakeNode {
  namespaceURI = "http://www.w3.org/1999/xhtml";
  tagName: string;
  style: Record<string, string> = {};

  constructor(tagName: string, ownerDocument: FakeDocument | null) {
    super(1, tagName.toUpperCase());
    this.ownerDocument = ownerDocument;
    this.tagName = tagName.toUpperCase();
  }
}

class FakeDocument extends FakeNode {
  documentElement: FakeElement;
  body: FakeElement;
  defaultView: FakeWindow;

  constructor() {
    super(9, "#document");
    this.ownerDocument = this;
    this.documentElement = new FakeElement("html", this);
    this.body = new FakeElement("body", this);
    this.documentElement.appendChild(this.body);
    this.defaultView = null as unknown as FakeWindow;
  }

  createElement(tagName: string) {
    return new FakeElement(tagName, this);
  }

  createElementNS(_namespace: string, tagName: string) {
    return this.createElement(tagName);
  }

  createTextNode(text: string) {
    return new FakeText(text, this);
  }

  createComment(data: string) {
    return new FakeComment(data, this);
  }
}

class FakeWindow {
  Node = FakeNode;
  Text = FakeText;
  Comment = FakeComment;
  Element = FakeElement;
  HTMLElement = FakeElement;
  SVGElement = FakeElement;
  HTMLIFrameElement = FakeElement;
  navigator = { userAgent: "node" };

  constructor(public document: FakeDocument) {}

  getComputedStyle() {
    return {};
  }

  addEventListener() {}
  removeEventListener() {}
  requestAnimationFrame(callback: FrameRequestCallback) {
    return setTimeout(() => callback(0), 0);
  }
  cancelAnimationFrame(handle: number) {
    clearTimeout(handle);
  }
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

  return { document };
}

function flushEffects() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

let latestResult: ReturnType<typeof useAdminDashboardSummary> | null = null;

function HookProbe() {
  latestResult = useAdminDashboardSummary();
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
    if (latestResult && !latestResult.loading) {
      return;
    }

    await act(async () => {
      await flushEffects();
    });
  }
}

describe("useAdminDashboardSummary", () => {
  beforeEach(() => {
    latestResult = null;
    apiMock.mockReset();
    hookState.aiQueue = {
      queue: [],
      loading: false,
    };
    hookState.interventions = {
      data: {
        items: [],
        totalCount: 4,
        page: 1,
        pageSize: 1,
      },
      loading: false,
    };
    hookState.exceptions = {
      exceptions: [],
      loading: false,
    };
    hookState.duplicateQueue = {
      pagination: { page: 1, limit: 20, total: 3, totalPages: 1 },
      loading: false,
    };
    hookState.disconnectDashboard = {
      dashboard: { summary: { totalDisconnects: 8 } },
      loading: false,
    };
    hookState.directorDashboard = {
      data: {
        ddVsPipeline: {
          ddValue: 0,
          ddCount: 0,
          pipelineValue: 0,
          pipelineCount: 0,
          totalValue: 240000,
          totalCount: 7,
        },
      },
      loading: false,
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("does not surface a failing operational signal as an all-clear result", async () => {
    vi.spyOn(Date, "now").mockReturnValue(new Date("2026-04-20T05:30:00.000Z").getTime());
    let auditPath: string | null = null;

    apiMock.mockImplementation(async (path: string) => {
      if (path.startsWith("/admin/audit?")) {
        auditPath = path;
        return {
          rows: [],
          total: 325,
        };
      }

      if (path === "/procore/sync-status") {
        throw new Error("Procore status unavailable");
      }

      throw new Error(`Unexpected path: ${path}`);
    });

    const root = await renderHook();
    await waitForIdle();

    expect(latestResult?.loading).toBe(false);
    expect(auditPath).not.toBeNull();
    expect(new URL(auditPath!, "https://example.test").searchParams.get("fromDate")).toBe(
      "2026-04-19T05:30:00.000Z"
    );
    expect(latestResult?.summary.kpis[1]).toEqual(
      expect.objectContaining({
        label: "System health",
        value: "1",
        detail: "procore unavailable",
      })
    );
    expect(latestResult?.summary.workspaceItems.find((item) => item.key === "audit-log")?.value).toBe("325");
    expect(latestResult?.summary.workspaceItems.find((item) => item.key === "procore-sync")?.value).toBe("—");

    await act(async () => {
      root.unmount();
      await flushEffects();
    });
  });
});
