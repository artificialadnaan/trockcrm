// @vitest-environment jsdom
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

// Mock the upload call so we can assert what category/subcategory the pick resolves to.
const { uploadFileMock } = vi.hoisted(() => ({ uploadFileMock: vi.fn() }));
vi.mock("@/hooks/use-files", () => ({ uploadFile: uploadFileMock }));

import { FileUploadZone } from "./file-upload-zone";

const folders = [
  { name: "Photos", path: "Photos", category: "photo" as const, count: 0,
    subfolders: [{ name: "Progress", path: "Photos/Progress", count: 0 }] },
  { name: "Estimates", path: "Estimates", category: "estimate" as const, count: 0,
    subfolders: [{ name: "Bid Estimate", path: "Estimates/Bid Estimate", count: 0 }] },
  { name: "Contracts", path: "Contracts", category: "contract" as const, count: 0, subfolders: [] },
  { name: "Permits & Inspections", path: "Permits & Inspections", category: "permit" as const, count: 0, subfolders: [] },
];

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  container = null;
  uploadFileMock.mockReset();
});

function mount(node: React.ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(node);
  return container;
}

function setSelectValue(el: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function triggerUpload(node: HTMLElement, file: File) {
  const input = node.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("FileUploadZone folder picker", () => {
  it("renders a folder picker with folders + subfolders when folders are provided", async () => {
    const node = mount(<FileUploadZone category="auto" folders={folders} dealId="d1" />);
    await vi.waitFor(() => expect(node.querySelector('[data-testid="upload-folder-picker"]')).toBeTruthy());
    const picker = node.querySelector('[data-testid="upload-folder-picker"]');
    expect(picker).toBeTruthy();
    const html = picker!.innerHTML;
    expect(html).toContain('value="Photos"');
    expect(html).toContain('value="Photos/Progress"');
    expect(html).toContain('value="Permits &amp; Inspections"');
    // Auto-detect is the default (no override) when the sidebar category is "auto".
    expect(html).toContain('value=""');
    expect(html).toContain("Auto-detect");
  });

  it("does not render a folder picker when no folders are supplied", async () => {
    const node = mount(<FileUploadZone category="auto" dealId="d1" />);
    // Wait for the zone itself to mount, then confirm the picker is absent.
    await vi.waitFor(() => expect(node.querySelector('input[type="file"]')).toBeTruthy());
    expect(node.querySelector('[data-testid="upload-folder-picker"]')).toBeNull();
  });

  it("labels the default option with the inherited sidebar category (honest, not 'Auto-detect')", async () => {
    const node = mount(<FileUploadZone category="contract" folders={folders} dealId="d1" />);
    await vi.waitFor(() => expect(node.querySelector('[data-testid="upload-folder-picker"]')).toBeTruthy());
    const picker = node.querySelector('[data-testid="upload-folder-picker"]')!;
    // Query the EXACT default option (value="") — a substring match against the whole picker HTML would
    // be satisfied by the "Contracts" folder option's text, proving nothing about the default label.
    const defaultOption = picker.querySelector('option[value=""]') as HTMLOptionElement | null;
    expect(defaultOption).toBeTruthy();
    expect(defaultOption!.textContent).toBe("Current type: Contract");
    expect(picker.innerHTML).not.toContain("Auto-detect");
  });

  it("overrides category+subcategory to the picked folder when uploading", async () => {
    uploadFileMock.mockResolvedValue({ id: "f1" });
    const node = mount(<FileUploadZone category="auto" folders={folders} dealId="d1" />);
    await vi.waitFor(() => expect(node.querySelector('[data-testid="upload-folder-picker"]')).toBeTruthy());
    setSelectValue(node.querySelector<HTMLSelectElement>('[data-testid="upload-folder-picker"]')!, "Estimates/Bid Estimate");
    triggerUpload(node, new File(["x"], "bid.pdf", { type: "application/pdf" }));
    await vi.waitFor(() => expect(uploadFileMock).toHaveBeenCalled());
    expect(uploadFileMock.mock.calls[0][0]).toMatchObject({ category: "estimate", subcategory: "Bid Estimate" });
  });

  it("files under the inherited sidebar category when the default (no override) is used", async () => {
    uploadFileMock.mockResolvedValue({ id: "f1" });
    const node = mount(<FileUploadZone category="contract" folders={folders} dealId="d1" />);
    await vi.waitFor(() => expect(node.querySelector('input[type="file"]')).toBeTruthy());
    triggerUpload(node, new File(["x"], "deal.pdf", { type: "application/pdf" }));
    await vi.waitFor(() => expect(uploadFileMock).toHaveBeenCalled());
    expect(uploadFileMock.mock.calls[0][0]).toMatchObject({ category: "contract" });
  });
});
