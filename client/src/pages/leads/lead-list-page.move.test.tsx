import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const boardColumns = [
  {
    stage: { id: "stage-new", name: "New", slug: "lead_new" },
    count: 1,
    cards: [
      {
        id: "lead-1",
        name: "Fresh Prospect",
        stageId: "stage-new",
        stageEnteredAt: "2026-04-20T10:00:00.000Z",
        updatedAt: "2026-04-20T10:00:00.000Z",
      },
    ],
  },
  {
    stage: { id: "stage-prequal", name: "Company Pre-Qualified", slug: "company_pre_qualified" },
    count: 0,
    cards: [],
  },
];

const refetchMock = vi.fn();
let capturedOnMove:
  | ((input: { activeId: string; targetStageId: string; targetStageSlug: string }) => void)
  | null = null;

vi.mock("@/hooks/use-leads", () => ({
  useLeadBoard: () => ({
    board: {
      columns: boardColumns,
      defaultConversionDealStageId: null,
    },
    loading: false,
    refetch: refetchMock,
  }),
  preflightLeadStageCheck: vi.fn(),
  transitionLeadStage: vi.fn(),
  updateLead: vi.fn(),
}));

vi.mock("@/components/pipeline/pipeline-board", () => ({
  PipelineBoard: ({ onMove }: { onMove?: typeof capturedOnMove }) => {
    capturedOnMove = onMove ?? null;
    return createElement("div", null, "mock-pipeline-board");
  },
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? createElement("div", { "data-dialog-open": "true" }, children) : null,
  DialogContent: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  DialogHeader: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  DialogTitle: ({ children }: { children: ReactNode }) => createElement("h2", null, children),
  DialogDescription: ({ children }: { children: ReactNode }) => createElement("p", null, children),
  DialogFooter: ({ children }: { children: ReactNode }) => createElement("div", null, children),
}));

vi.mock("@/lib/pipeline-scope", () => ({
  useNormalizedPipelineRoute: () => ({
    allowedScope: "mine",
    needsRedirect: false,
    redirectTo: "/leads?scope=mine",
  }),
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
  },
}));

const { LeadListPage } = await import("./lead-list-page");
const { preflightLeadStageCheck, transitionLeadStage, updateLead } = await import("@/hooks/use-leads");

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

  replaceChild<T extends FakeNode>(newChild: T, oldChild: FakeNode) {
    const index = this.childNodes.indexOf(oldChild);
    if (index === -1) return this.appendChild(newChild);
    if (newChild.parentNode) newChild.parentNode.removeChild(newChild);
    this.childNodes[index] = newChild;
    newChild.parentNode = this;
    oldChild.parentNode = null;
    return oldChild;
  }

  get firstChild() {
    return this.childNodes[0] ?? null;
  }

  get lastChild() {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }

  get textContent(): string {
    return this.childNodes.map((child) => child.textContent).join("");
  }

  set textContent(value: string) {
    this.childNodes = value ? [new FakeText(value, this.ownerDocument)] : [];
    for (const child of this.childNodes) child.parentNode = this;
  }

  get nodeValue(): string | null {
    return null;
  }

  set nodeValue(_value: string | null) {}

  addEventListener() {}
  removeEventListener() {}
  dispatchEvent() {
    return true;
  }

  contains(node: FakeNode | null): boolean {
    return node != null && (node === this || this.childNodes.some((child): boolean => child.contains(node)));
  }
}

class FakeText extends FakeNode {
  constructor(public data: string, ownerDocument: FakeDocument | null) {
    super(3, "#text");
    this.ownerDocument = ownerDocument;
  }

  get textContent() {
    return this.data;
  }

  set textContent(value: string) {
    this.data = value;
  }

  get nodeValue() {
    return this.data;
  }

  set nodeValue(value: string | null) {
    this.data = value ?? "";
  }
}

class FakeElement extends FakeNode {
  namespaceURI = "http://www.w3.org/1999/xhtml";
  style: Record<string, string> = {};
  attributes = new Map<string, string>();
  private disabledState = false;

  constructor(public tagName: string, ownerDocument: FakeDocument | null) {
    super(1, tagName.toUpperCase());
    this.ownerDocument = ownerDocument;
    this.tagName = tagName.toUpperCase();
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, String(value));
    (this as any)[name] = value;
  }

  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string) {
    return this.attributes.has(name);
  }

  removeAttribute(name: string) {
    this.attributes.delete(name);
    delete (this as any)[name];
  }

  get disabled() {
    return this.disabledState;
  }

  set disabled(value: boolean) {
    this.disabledState = Boolean(value);
    if (this.disabledState) {
      this.attributes.set("disabled", "");
    } else {
      this.attributes.delete("disabled");
    }
  }
}

class FakeComment extends FakeNode {
  constructor(public data: string, ownerDocument: FakeDocument | null) {
    super(8, "#comment");
    this.ownerDocument = ownerDocument;
  }

  get textContent() {
    return "";
  }

  set textContent(_value: string) {}

  get nodeValue() {
    return this.data;
  }

  set nodeValue(value: string | null) {
    this.data = value ?? "";
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

  getElementById() {
    return null;
  }

  addEventListener() {}
  removeEventListener() {}
}

class FakeWindow {
  Node = FakeNode;
  Text = FakeText;
  Comment = FakeComment;
  Element = FakeElement;
  HTMLElement = FakeElement;
  SVGElement = FakeElement;
  HTMLInputElement = FakeElement;
  HTMLSelectElement = FakeElement;
  HTMLOptionElement = FakeElement;
  HTMLButtonElement = FakeElement;
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
  vi.stubGlobal("HTMLIFrameElement", window.HTMLIFrameElement);

  return { document };
}

function collectText(node: FakeNode): string {
  if (node instanceof FakeText) {
    return node.data;
  }

  return node.childNodes.map((child) => collectText(child)).join(" ");
}

function flushEffects() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function renderPage() {
  const { document } = installFakeDom();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);

  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={["/leads?scope=mine"]}>
        <LeadListPage />
      </MemoryRouter>
    );
    await flushEffects();
  });

  return { root, container };
}

describe("LeadListPage move handling", () => {
  beforeEach(() => {
    capturedOnMove = null;
    refetchMock.mockReset();
    vi.mocked(preflightLeadStageCheck).mockReset();
    vi.mocked(transitionLeadStage).mockReset();
    vi.mocked(updateLead).mockReset();
  });

  it("shows the blocked-move modal from the structured stage-transition response", async () => {
    vi.mocked(preflightLeadStageCheck).mockResolvedValue({
      allowed: true,
      currentStage: { id: "stage-new", name: "New", slug: "lead_new" },
      targetStage: {
        id: "stage-prequal",
        name: "Company Pre-Qualified",
        slug: "company_pre_qualified",
      },
      missingRequirements: { fields: [], effectiveChecklist: { fields: [] } },
    });
    vi.mocked(transitionLeadStage).mockResolvedValue({
      ok: false,
      reason: "missing_requirements",
      targetStageId: "stage-prequal",
      resolution: "inline",
      missing: [
        {
          key: "qualification.projectLocation",
          label: "Project Location",
          resolution: "inline",
        },
      ],
    });

    const { root, container } = await renderPage();

    expect(capturedOnMove).toBeTypeOf("function");

    await act(async () => {
      capturedOnMove?.({
        activeId: "lead-1",
        targetStageId: "stage-prequal",
        targetStageSlug: "company_pre_qualified",
      });
      await flushEffects();
    });

    expect(transitionLeadStage).toHaveBeenCalledWith("lead-1", {
      targetStageId: "stage-prequal",
    });
    expect(updateLead).not.toHaveBeenCalled();
    expect(collectText(container)).toContain("Complete Required Fields");
    expect(collectText(container)).toContain("Project Location");
    expect(collectText(container)).toContain("Open Lead Intake");

    await act(async () => {
      root.unmount();
      await flushEffects();
    });
  });
});
