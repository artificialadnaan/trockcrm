/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileUploadZone } from "./file-upload-zone";

const mocks = vi.hoisted(() => ({ uploadFile: vi.fn() }));
vi.mock("@/hooks/use-files", () => ({ uploadFile: mocks.uploadFile }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  mocks.uploadFile.mockReset();
});

function render() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<FileUploadZone category="auto" dealId="deal-1" />);
  });
  return container;
}

function typeDescription(c: HTMLElement, value: string) {
  const ta = c.querySelector<HTMLTextAreaElement>("#upload-desc")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  setter.call(ta, value);
  act(() => ta.dispatchEvent(new Event("input", { bubbles: true })));
}

async function dropFile(c: HTMLElement, file: File) {
  const input = c.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  // flush the awaited upload microtasks + resulting state transitions
  await act(async () => {});
}

describe("FileUploadZone description", () => {
  it("sends the CURRENT typed description with the upload (no stale closure)", async () => {
    mocks.uploadFile.mockResolvedValue({ id: "f1" });
    const c = render();

    typeDescription(c, "Roof photos from 3/14 visit");
    await dropFile(c, new File(["%PDF"], "Report.pdf", { type: "application/pdf" }));

    expect(mocks.uploadFile).toHaveBeenCalledTimes(1);
    expect(mocks.uploadFile.mock.calls[0][0]).toMatchObject({
      description: "Roof photos from 3/14 visit",
    });
  });

  it("clears the description after a successful batch so a later drop does not inherit it", async () => {
    mocks.uploadFile.mockResolvedValue({ id: "f1" });
    const c = render();

    typeDescription(c, "batch one");
    await dropFile(c, new File(["%PDF"], "One.pdf", { type: "application/pdf" }));
    expect(mocks.uploadFile.mock.calls[0][0].description).toBe("batch one");
    // The textarea is cleared in the DOM.
    expect(c.querySelector<HTMLTextAreaElement>("#upload-desc")!.value).toBe("");

    // A second, unrelated drop with no re-typed description sends undefined.
    await dropFile(c, new File(["%PDF"], "Two.pdf", { type: "application/pdf" }));
    expect(mocks.uploadFile).toHaveBeenCalledTimes(2);
    expect(mocks.uploadFile.mock.calls[1][0].description).toBeUndefined();
  });
});
