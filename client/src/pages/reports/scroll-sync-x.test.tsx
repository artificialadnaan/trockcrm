// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScrollSyncX } from "./scroll-sync-x";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function q(testid: string): HTMLDivElement {
  const el = container.querySelector<HTMLDivElement>(`[data-testid="${testid}"]`);
  if (!el) throw new Error(`no [data-testid=${testid}]`);
  return el;
}

describe("ScrollSyncX top-aligned synced scrollbar", () => {
  it("renders a top scrollbar rail BEFORE the scrollable body that holds the children", () => {
    act(() =>
      root.render(
        <ScrollSyncX>
          <table>
            <tbody>
              <tr>
                <td>cell-content</td>
              </tr>
            </tbody>
          </table>
        </ScrollSyncX>
      )
    );
    const top = q("scrollsync-top");
    const body = q("scrollsync-body");
    expect(body.textContent).toContain("cell-content");
    // top-aligned: the rail comes before the body in DOM order
    expect(top.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // the redundant visual scrollbar is hidden from assistive tech (the body stays the scroll region)
    expect(top.getAttribute("aria-hidden")).toBe("true");
  });

  it("styles the top rail with the always-visible scrollbar class (discoverable, not overlay-hidden)", () => {
    act(() => root.render(<ScrollSyncX><div>x</div></ScrollSyncX>));
    expect(q("scrollsync-top").className).toContain("scrollbar-top-rail");
  });

  it("makes a labelled body region keyboard reachable", () => {
    act(() => root.render(<ScrollSyncX bodyLabel="Wide records table"><div>x</div></ScrollSyncX>));
    const body = q("scrollsync-body");
    expect(body.getAttribute("role")).toBe("region");
    expect(body.getAttribute("aria-label")).toBe("Wide records table");
    expect(body.getAttribute("tabindex")).toBe("0");
  });

  it("mirrors body horizontal scroll onto the top rail", () => {
    act(() => root.render(<ScrollSyncX><div>x</div></ScrollSyncX>));
    const top = q("scrollsync-top");
    const body = q("scrollsync-body");
    body.scrollLeft = 80;
    act(() => body.dispatchEvent(new Event("scroll")));
    expect(top.scrollLeft).toBe(80);
  });

  it("mirrors top-rail scroll onto the body (dragging the top bar scrolls the table)", () => {
    act(() => root.render(<ScrollSyncX><div>x</div></ScrollSyncX>));
    const top = q("scrollsync-top");
    const body = q("scrollsync-body");
    top.scrollLeft = 45;
    act(() => top.dispatchEvent(new Event("scroll")));
    expect(body.scrollLeft).toBe(45);
  });
});
