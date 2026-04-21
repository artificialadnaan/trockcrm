import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { DirectorRepWorkspace } from "./director-rep-workspace";

function normalize(html: string) {
  return html.replace(/\s+/g, " ").trim();
}

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

  contains(node: FakeNode | null) {
    return node != null && (node === this || this.childNodes.some((child) => child.contains(node)));
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

  get options() {
    return this.tagName === "SELECT"
      ? this.childNodes.filter(
          (child): child is FakeElement => child instanceof FakeElement && child.tagName === "OPTION",
        )
      : undefined;
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
  HTMLTableElement = FakeElement;
  HTMLTableRowElement = FakeElement;
  HTMLTableCellElement = FakeElement;
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

function findButtonByText(root: FakeNode, text: string) {
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node instanceof FakeElement && node.tagName === "BUTTON" && node.textContent.trim() === text) {
      return node;
    }

    stack.push(...node.childNodes);
  }

  return null;
}

function getReactProps(node: FakeElement) {
  const key = Object.keys(node).find((prop) => prop.startsWith("__reactProps"));
  return key ? ((node as any)[key] as { onClick?: () => void }) : null;
}

async function renderWorkspace(root: Root, repCards: Parameters<typeof DirectorRepWorkspace>[0]["repCards"]) {
  await act(async () => {
    root.render(<DirectorRepWorkspace repCards={repCards} initialPageSize={25} onSelectRep={vi.fn()} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("DirectorRepWorkspace", () => {
  it("renders table controls, page metadata, and the first page of reps", () => {
    const html = normalize(
      renderToStaticMarkup(
        <DirectorRepWorkspace
          repCards={[
            {
              repId: "rep-1",
              repName: "Alpha Rep",
              activeDeals: 4,
              pipelineValue: 150000,
              winRate: 40,
              activityScore: 12,
              staleDeals: 1,
              staleLeads: 0,
            },
            {
              repId: "rep-2",
              repName: "Bravo Rep",
              activeDeals: 7,
              pipelineValue: 450000,
              winRate: 55,
              activityScore: 3,
              staleDeals: 2,
              staleLeads: 2,
            },
          ]}
          initialPageSize={25}
          onSelectRep={vi.fn()}
        />
      )
    );

    expect(html).toContain("Rep performance");
    expect(html).toContain("Search reps");
    expect(html).toContain("Sort by");
    expect(html).toContain("Alpha Rep");
    expect(html).toContain("Bravo Rep");
    expect(html).toContain("Page 1 of 1");
  });

  it("syncs the visible page metadata back into range after a shrink", async () => {
    const { document } = installFakeDom();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);

    const manyReps = Array.from({ length: 30 }, (_, index) => ({
      repId: `rep-${index + 1}`,
      repName: `Rep ${index + 1}`,
      activeDeals: 30 - index,
      pipelineValue: 300000 - index * 1000,
      winRate: 50,
      activityScore: 10,
      staleDeals: 0,
      staleLeads: 0,
    }));
    const fewReps = manyReps.slice(0, 10);

    await renderWorkspace(root, manyReps);

    const nextButton = findButtonByText(container, "Next");
    expect(nextButton).not.toBeNull();
    const nextProps = getReactProps(nextButton!);
    expect(nextProps?.onClick).toBeTypeOf("function");

    await act(async () => {
      nextProps?.onClick?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.textContent).toContain("Page 2 of 2");

    await renderWorkspace(root, fewReps);
    expect(container.textContent).toContain("Page 1 of 1");
  });
});
