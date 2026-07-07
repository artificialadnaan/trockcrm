// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileRow } from "./file-row";
import type { FileRecord } from "@/hooks/use-files";

// This repo's client component tests render via react-dom/client createRoot + act under jsdom (see
// search-input.test.tsx) — NOT @testing-library, which isn't a client dependency. React needs this flag
// on to allow act() to flush without warnings.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function renderRow(props: Parameters<typeof FileRow>[0]): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(FileRow, props));
  });
  return container;
}

async function click(el: Element | null): Promise<void> {
  await act(async () => {
    el?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
});

function makeFile(overrides: Partial<FileRecord> = {}): FileRecord {
  return {
    id: "f1",
    category: "contract",
    subcategory: null,
    folderPath: "Contracts",
    tags: [],
    displayName: "Foundation Warranty",
    systemFilename: "sys.pdf",
    originalFilename: "Foundation Warranty.pdf",
    mimeType: "application/pdf",
    fileSizeBytes: 12345,
    fileExtension: ".pdf",
    r2Key: "office_x/deals/D-1/docs/a.pdf",
    r2Bucket: "trockcrm",
    dealId: "d1",
    leadId: null,
    contactId: null,
    procoreProjectId: null,
    changeOrderId: null,
    description: null,
    notes: null,
    version: 1,
    parentFileId: null,
    takenAt: null,
    geoLat: null,
    geoLng: null,
    uploadedBy: "u1",
    isActive: true,
    createdAt: "2026-07-06T00:00:00Z",
    updatedAt: "2026-07-06T00:00:00Z",
    ...overrides,
  };
}

describe("FileRow", () => {
  it("renders a thumbnail <img> at thumbnailUrl when present", async () => {
    const c = await renderRow({
      file: makeFile({ thumbnailUrl: "http://x/thumb.jpg" }),
      onDownload: vi.fn(),
      onOpen: vi.fn(),
      onDelete: vi.fn(),
    });
    const img = c.querySelector("img");
    expect(img?.getAttribute("src")).toBe("http://x/thumb.jpg");
    expect(img?.getAttribute("alt")).toBe("Foundation Warranty");
  });

  it("renders a type badge (no <img>) when there is no thumbnailUrl", async () => {
    const c = await renderRow({
      file: makeFile({ thumbnailUrl: null }),
      onDownload: vi.fn(),
      onOpen: vi.fn(),
      onDelete: vi.fn(),
    });
    expect(c.querySelector("img")).toBeNull();
    expect(c.textContent).toContain("PDF");
  });

  it("Open dispatches onOpen(id); Download dispatches onDownload(id)", async () => {
    const onOpen = vi.fn();
    const onDownload = vi.fn();
    const c = await renderRow({ file: makeFile(), onDownload, onOpen, onDelete: vi.fn() });

    await click(c.querySelector('[title="Open"]'));
    expect(onOpen).toHaveBeenCalledWith("f1");

    await click(c.querySelector('[title="Download"]'));
    expect(onDownload).toHaveBeenCalledWith("f1");
  });
});
