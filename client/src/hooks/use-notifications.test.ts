import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { isIgnorableNotificationError, useNotificationStream } from "./use-notifications";

const apiMock = vi.hoisted(() => vi.fn());
const resolveApiBaseMock = vi.hoisted(() => vi.fn(() => "https://api-production-ad218.up.railway.app/api"));

vi.mock("@/lib/api", () => ({
  api: apiMock,
  resolveApiBase: resolveApiBaseMock,
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

class FakeEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;

  readyState = FakeEventSource.OPEN;
  listeners = new Map<string, Set<(event: { data: string }) => void>>();

  constructor(public url: string, public init?: { withCredentials?: boolean }) {}

  addEventListener(type: string, listener: (event: { data: string }) => void) {
    const listeners = this.listeners.get(type) ?? new Set<(event: { data: string }) => void>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  close() {
    this.readyState = FakeEventSource.CLOSED;
  }

  onerror: (() => void) | null = null;
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
  vi.stubGlobal("EventSource", FakeEventSource);

  return { document };
}

function flushEffects() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function HookProbe({ enabled = true }: { enabled?: boolean }) {
  useNotificationStream(enabled);
  return null;
}

async function renderHook(enabled: boolean = true) {
  const { document } = installFakeDom();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);

  await act(async () => {
    root.render(createElement(HookProbe, { enabled }));
    await flushEffects();
  });

  return root;
}

describe("isIgnorableNotificationError", () => {
  it("treats browser abort-style failures as ignorable", () => {
    expect(isIgnorableNotificationError(new TypeError("Failed to fetch"))).toBe(true);
    expect(isIgnorableNotificationError(new DOMException("The operation was aborted.", "AbortError"))).toBe(true);
    expect(isIgnorableNotificationError(new Error("Request aborted while leaving page"))).toBe(true);
  });

  it("does not swallow unrelated notification failures", () => {
    expect(isIgnorableNotificationError(new Error("boom"))).toBe(false);
  });
});

describe("useNotificationStream", () => {
  beforeEach(() => {
    apiMock.mockReset();
    resolveApiBaseMock.mockClear();
  });

  it("does not log ignorable bootstrap fetch failures", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    apiMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    const root = await renderHook();

    await act(async () => {
      await flushEffects();
    });

    expect(consoleErrorSpy).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
      await flushEffects();
    });

    consoleErrorSpy.mockRestore();
  });

  it("still logs unexpected bootstrap fetch failures", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = new Error("notifications offline");
    apiMock.mockRejectedValueOnce(error);

    const root = await renderHook();

    await act(async () => {
      await flushEffects();
    });

    expect(consoleErrorSpy).toHaveBeenCalledWith(error);

    await act(async () => {
      root.unmount();
      await flushEffects();
    });

    consoleErrorSpy.mockRestore();
  });

  it("does not open an EventSource connection until explicitly enabled", async () => {
    apiMock.mockResolvedValueOnce({ count: 0 });
    const eventSourceSpy = vi.spyOn(globalThis, "EventSource");

    const root = await renderHook(false);

    await act(async () => {
      await flushEffects();
    });

    expect(eventSourceSpy).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
      await flushEffects();
    });

    eventSourceSpy.mockRestore();
  });
});
