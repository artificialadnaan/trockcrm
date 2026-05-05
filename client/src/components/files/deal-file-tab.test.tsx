/**
 * @vitest-environment jsdom
 */
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DealFileTab } from "./deal-file-tab";

vi.mock("@/lib/api", () => ({
  api: vi.fn(async (path: string) => {
    if (path.includes("/folders")) return { folders: currentFolders };
    if (path.includes("/photos")) return { photos: [], pagination: { page: 1, limit: 200, total: 0, totalPages: 1 } };
    return { files: [], pagination: { page: 1, limit: 25, total: 0, totalPages: 1 } };
  }),
  resolveApiBase: () => "/api",
}));

let currentFolders: Array<{ name: string; path: string; category: "contract"; count: number; subfolders: Array<{ name: string; path: string; count: number }> }> = [];

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  container = null;
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

describe("DealFileTab", () => {
  it("keeps All Files as the default and switches to the Photos sub-view", async () => {
    const node = renderTab();
    await vi.waitFor(() => expect(node.textContent).toContain("No files uploaded yet."));

    expect(node.querySelector('[aria-pressed="true"]')?.textContent).toContain("All Files");

    node.querySelector<HTMLButtonElement>('[aria-label="Show Photos files sub-view"]')?.click();
    await vi.waitFor(() => expect(node.textContent).toContain("No photos uploaded to this deal yet."));
    expect(node.querySelector('[aria-pressed="true"]')?.textContent).toContain("Photos");
  });

  it("preserves existing all-files upload, folder, and search behavior", async () => {
    currentFolders = [{
      name: "Contracts",
      path: "Contracts",
      category: "contract",
      count: 0,
      subfolders: [{ name: "Signed", path: "Contracts/Signed", count: 0 }],
    }];
    const node = renderTab();
    await vi.waitFor(() => expect(node.textContent).toContain("No files uploaded yet."));

    node.querySelector<HTMLButtonElement>("button")?.click();
    await vi.waitFor(() => expect(node.textContent).toContain("Drop files here or click to browse"));

    Array.from(node.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.includes("Contracts"))?.click();
    await vi.waitFor(() => expect(node.textContent).toContain("No files in this folder."));

    const searchInput = node.querySelector<HTMLInputElement>('input[placeholder="Search files..."]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(searchInput, "invoice");
    searchInput.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() => expect(node.textContent).toContain("No files match your search."));
  });
});
