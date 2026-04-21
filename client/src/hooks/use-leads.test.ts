import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({
  api: vi.fn(),
  resolveApiBase: () => "/api",
}));

const { transitionLeadStage, useLeadBoard } = await import("./use-leads");

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

let latestBoardResult: ReturnType<typeof useLeadBoard> | null = null;

function BoardHookProbe() {
  latestBoardResult = useLeadBoard("mine");
  return null;
}

async function renderBoardHook() {
  const { document } = installFakeDom();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);

  await act(async () => {
    root.render(createElement(BoardHookProbe));
    await flushEffects();
  });

  return root;
}

async function waitForBoardIdle() {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (latestBoardResult && !latestBoardResult.loading) return;
    await act(async () => {
      await flushEffects();
    });
  }
}

describe("transitionLeadStage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    latestBoardResult = null;
  });

  it("returns missing requirement payloads on 409 responses", async () => {
    const payload = {
      ok: false as const,
      reason: "missing_requirements" as const,
      targetStageId: "stage-qualified",
      resolution: "inline" as const,
      missing: [{ key: "source", label: "Lead Source", resolution: "inline" as const }],
    };

    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => payload,
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await transitionLeadStage("lead-1", {
      targetStageId: "stage-qualified",
      inlinePatch: { source: "trade-show" },
    });

    expect(result).toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/leads/lead-1/stage-transition",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
      })
    );
  });

  it("throws API message on non-409 errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: "Invalid transition" } }),
    }));

    await expect(
      transitionLeadStage("lead-1", {
        targetStageId: "stage-qualified",
      })
    ).rejects.toThrow("Invalid transition");
  });

  it("treats missing requirement payloads as retryable even when backend uses 400", async () => {
    const payload = {
      ok: false as const,
      reason: "missing_requirements" as const,
      targetStageId: "stage-ready",
      resolution: "inline" as const,
      missing: [{ key: "directorReviewDecision", label: "Director decision", resolution: "inline" as const }],
    };

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => payload,
    }));

    const result = await transitionLeadStage("lead-1", {
      targetStageId: "stage-ready",
    });

    expect(result).toEqual(payload);
  });

  it("captures board load errors on mount while preserving manual refetch failures", async () => {
    const { api } = await import("@/lib/api");
    const apiMock = vi.mocked(api);
    apiMock.mockRejectedValueOnce(new Error("Lead board failed"));
    apiMock.mockRejectedValueOnce(new Error("Lead board failed"));

    const root = await renderBoardHook();
    await waitForBoardIdle();

    expect(latestBoardResult?.error).toBe("Lead board failed");
    let manualRefetchError: unknown = null;
    await act(async () => {
      try {
        await latestBoardResult!.refetch();
      } catch (error) {
        manualRefetchError = error;
      }
      await flushEffects();
    });
    expect(manualRefetchError).toBeInstanceOf(Error);
    expect((manualRefetchError as Error).message).toBe("Lead board failed");
    await waitForBoardIdle();
    expect(latestBoardResult?.error).toBe("Lead board failed");

    await act(async () => {
      root.unmount();
      await flushEffects();
    });
    vi.unstubAllGlobals();
  });
});
