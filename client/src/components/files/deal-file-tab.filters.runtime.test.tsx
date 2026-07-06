// @vitest-environment jsdom
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

// Capture the API paths so we can prove the controls actually change the request (not just render).
const apiCalls: string[] = [];
let currentFolders: Array<{ name: string; path: string; category: "contract"; count: number; subfolders: Array<{ name: string; path: string; count: number }> }> = [];

vi.mock("@/lib/api", () => ({
  api: vi.fn(async (path: string) => {
    apiCalls.push(path);
    if (path.includes("/folders")) return { folders: currentFolders };
    if (path.includes("/photos")) return { photos: [], pagination: { page: 1, limit: 200, total: 0, totalPages: 1 } };
    return { files: [], pagination: { page: 1, limit: 25, total: 0, totalPages: 1 } };
  }),
  resolveApiBase: () => "/api",
}));

import { DealFileTab } from "./deal-file-tab";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  container = null;
  apiCalls.length = 0;
  currentFolders = [];
});

function renderTab() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(
    <MemoryRouter>
      <DealFileTab dealId="deal-1" />
    </MemoryRouter>
  );
  return container;
}

function setSelectValue(el: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("DealFileTab filter/sort controls", () => {
  it("renders the file-type filter, by-category filter, date-range picker, and sort dropdown", async () => {
    const node = renderTab();
    await vi.waitFor(() => expect(node.textContent).toContain("No files uploaded yet."));

    expect(node.querySelector('[data-testid="file-type-filter"]')).toBeTruthy();
    expect(node.querySelector('[data-testid="file-category-filter"]')).toBeTruthy();
    expect(node.querySelector('[data-testid="date-from"]')).toBeTruthy();
    expect(node.querySelector('[data-testid="date-to"]')).toBeTruthy();
    expect(node.querySelector('[data-testid="file-sort"]')).toBeTruthy();

    const sortHtml = node.querySelector('[data-testid="file-sort"]')!.innerHTML;
    expect(sortHtml).toContain('value="file_type"');
    expect(sortHtml).toContain('value="file_size_bytes"');

    const catHtml = node.querySelector('[data-testid="file-category-filter"]')!.innerHTML;
    expect(catHtml).toContain("Contract"); // getCategoryLabel("contract")
  });

  it("refetches with fileKind=documents when the type filter changes", async () => {
    const node = renderTab();
    await vi.waitFor(() => expect(node.textContent).toContain("No files uploaded yet."));
    setSelectValue(node.querySelector<HTMLSelectElement>('[data-testid="file-type-filter"]')!, "documents");
    await vi.waitFor(() => expect(apiCalls.some((p) => p.includes("fileKind=documents"))).toBe(true));
  });

  it("refetches with category=<cat> when the category filter changes", async () => {
    const node = renderTab();
    await vi.waitFor(() => expect(node.textContent).toContain("No files uploaded yet."));
    setSelectValue(node.querySelector<HTMLSelectElement>('[data-testid="file-category-filter"]')!, "contract");
    await vi.waitFor(() => expect(apiCalls.some((p) => p.includes("category=contract"))).toBe(true));
  });

  it("shows a filter-aware empty state only when a filter is active", async () => {
    const node = renderTab();
    await vi.waitFor(() => expect(node.textContent).toContain("No files uploaded yet."));
    setSelectValue(node.querySelector<HTMLSelectElement>('[data-testid="file-type-filter"]')!, "documents");
    await vi.waitFor(() => expect(node.textContent).toContain("No files match these filters."));
  });
});
