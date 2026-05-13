// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";
import { FilesPage } from "./files-page";
import type { FileRecord } from "@/hooks/use-files";

const mocks = vi.hoisted(() => ({
  useFilesMock: vi.fn(),
  useFileStatsMock: vi.fn(),
  downloadFileMock: vi.fn(),
  deleteFileRecordMock: vi.fn(),
  useDealsMock: vi.fn(),
  useContactsMock: vi.fn(),
  useAuthMock: vi.fn(),
  apiMock: vi.fn(),
  fileUploadZoneMock: vi.fn(),
}));

vi.mock("@/hooks/use-files", () => ({
  useFiles: mocks.useFilesMock,
  useFileStats: mocks.useFileStatsMock,
  downloadFile: mocks.downloadFileMock,
  deleteFileRecord: mocks.deleteFileRecordMock,
}));

vi.mock("@/hooks/use-deals", () => ({
  useDeals: mocks.useDealsMock,
}));

vi.mock("@/hooks/use-contacts", () => ({
  useContacts: mocks.useContactsMock,
}));

vi.mock("@/lib/auth", () => ({
  useAuth: mocks.useAuthMock,
}));

vi.mock("@/lib/api", () => ({
  api: mocks.apiMock,
}));

vi.mock("@/components/files/file-upload-zone", () => ({
  FileUploadZone: (props: Record<string, unknown>) => {
    mocks.fileUploadZoneMock(props);
    return <div data-testid="upload-zone">Upload Dropzone</div>;
  },
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    type,
    className,
  }: {
    children: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    type?: "button" | "submit" | "reset";
    className?: string;
  }) => (
    <button type={type ?? "button"} disabled={disabled} onClick={onClick} className={className}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/card", () => ({
  Card: ({ children, className }: { children: ReactNode; className?: string }) => <div className={className}>{children}</div>,
  CardContent: ({ children, className }: { children: ReactNode; className?: string }) => <div className={className}>{children}</div>,
  CardHeader: ({ children, className }: { children: ReactNode; className?: string }) => <div className={className}>{children}</div>,
  CardTitle: ({ children, className }: { children: ReactNode; className?: string }) => <h2 className={className}>{children}</h2>,
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({
    children,
    value,
    onValueChange,
  }: {
    children: ReactNode;
    value: string;
    onValueChange: (value: string) => void;
  }) => (
    <div data-select-value={value} data-testid={`select-${value}`}>
      <button type="button" onClick={() => onValueChange(value === "desc" ? "asc" : "desc")}>
        {children}
      </button>
    </div>
  ),
  SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children, value }: { children: ReactNode; value: string }) => <span data-value={value}>{children}</span>,
  SelectTrigger: ({ children, className }: { children: ReactNode; className?: string }) => <span className={className}>{children}</span>,
  SelectValue: () => <span>Select value</span>,
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

function makeFile(overrides: Partial<FileRecord> = {}): FileRecord {
  return {
    id: "file-1",
    category: "photo",
    subcategory: null,
    folderPath: null,
    tags: [],
    displayName: "Roof photo",
    systemFilename: "roof-photo.jpg",
    originalFilename: "roof-photo.jpg",
    mimeType: "image/jpeg",
    fileSizeBytes: 2400 * 1024,
    fileExtension: ".jpg",
    r2Key: "files/roof-photo.jpg",
    r2Bucket: "bucket",
    dealId: "deal-1",
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
    uploadedBy: "Brett Rios",
    isActive: true,
    createdAt: "2026-05-06T12:00:00.000Z",
    updatedAt: "2026-05-06T12:00:00.000Z",
    ...overrides,
  };
}

function setupFiles(files: FileRecord[]) {
  mocks.useFilesMock.mockReturnValue({
    files,
    pagination: { page: 1, limit: 200, total: files.length, totalPages: 1 },
    loading: false,
    error: null,
    refetch: vi.fn(),
  });
  mocks.useFileStatsMock.mockReturnValue({
    stats: {
      totalFiles: 27,
      totalPhotos: 9,
      totalDocuments: 18,
      totalBytes: 10 * 1024 * 1024,
      recentUploads: 4,
      dealsWithFiles: 6,
    },
    loading: false,
    error: null,
    refetch: vi.fn(),
  });
}

function mountPage() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: Root | null = null;

  act(() => {
    root = createRoot(container);
    root.render(
      <MemoryRouter initialEntries={["/files"]}>
        <FilesPage />
      </MemoryRouter>
    );
  });

  return {
    container,
    unmount() {
      act(() => root?.unmount());
      container.remove();
    },
  };
}

describe("FilesPage", () => {
  let mounted: ReturnType<typeof mountPage> | null = null;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mounted?.unmount();
    mounted = null;
    vi.clearAllMocks();
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        observe() {}
        disconnect() {}
      }
    );
    mocks.apiMock.mockResolvedValue({ url: "https://r2.example.test/preview.jpg" });
    mocks.useAuthMock.mockReturnValue({ user: { id: "user-1", role: "admin" } });
    mocks.useDealsMock.mockReturnValue({
      deals: [
        {
          id: "deal-1",
          dealNumber: "TR-100",
          name: "Dallas ISD Roof Replacement",
          propertyAddress: "100 Main St",
          propertyCity: "Dallas",
          propertyState: "TX",
          projectTypeId: "reroof",
        },
      ],
    });
    mocks.useContactsMock.mockReturnValue({ contacts: [] });
    setupFiles([
      makeFile(),
      makeFile({
        id: "file-2",
        category: "contract",
        displayName: "Signed contract",
        originalFilename: "signed-contract.pdf",
        mimeType: "application/pdf",
        fileSizeBytes: 1024 * 1024,
        fileExtension: ".pdf",
        uploadedBy: "Marcus Holloway",
        createdAt: "2026-05-07T12:00:00.000Z",
      }),
    ]);
  });

  it("renders files in grid layout", () => {
    mounted = mountPage();

    expect(mounted.container.textContent).toContain("Files");
    expect(mounted.container.textContent).toContain("Roof photo");
    expect(mounted.container.textContent).toContain("Signed contract");
    expect(mounted.container.querySelector('[data-view="grid"]')).not.toBeNull();
  });

  it("filter chips switch the visible files", () => {
    mounted = mountPage();

    act(() => {
      mounted?.container.querySelector<HTMLButtonElement>('[data-filter-tab="photos"]')?.click();
    });

    expect(mocks.useFilesMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ fileKind: "photos", category: undefined }),
      expect.objectContaining({ enabled: true })
    );
  });

  it("search filters files", () => {
    mounted = mountPage();
    const input = mounted.container.querySelector<HTMLInputElement>('input[placeholder="Search files"]');

    act(() => {
      input!.value = "contract";
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(mocks.useFilesMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ search: "contract" }),
      expect.objectContaining({ enabled: true })
    );
  });

  it("upload button triggers upload flow", () => {
    mounted = mountPage();

    act(() => {
      Array.from(mounted!.container.querySelectorAll("button"))
        .find((button) => button.textContent?.includes("Upload"))!
        .click();
    });

    expect(mounted.container.textContent).toContain("Upload Dropzone");
    expect(mocks.fileUploadZoneMock).toHaveBeenCalledWith(expect.objectContaining({ category: "other" }));
  });

  it("file card shows correct metadata", () => {
    mounted = mountPage();

    expect(mounted.container.textContent).toContain("Roof photo");
    expect(mounted.container.textContent).toContain("2.3 MB");
    expect(mounted.container.textContent).toContain("Brett Rios");
    expect(mounted.container.textContent).toContain("Photo");
  });

  it("lazy-loads an R2-backed image preview for photo cards", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    mounted = mountPage();

    await act(async () => {
      await Promise.resolve();
    });

    const image = mounted.container.querySelector<HTMLImageElement>("[data-file-preview-image]");
    expect(image?.getAttribute("src")).toBe("https://r2.example.test/preview.jpg");
    expect(image?.getAttribute("alt")).toBe("Roof photo.jpg");
    expect(mocks.apiMock).toHaveBeenCalledWith("/files/file-1/download?preview=1");
  });

  it("keeps PDFs on file-type icons instead of the camera placeholder", () => {
    setupFiles([
      makeFile({
        id: "pdf-1",
        category: "contract",
        displayName: "Signed contract",
        originalFilename: "signed-contract.pdf",
        mimeType: "application/pdf",
        fileSizeBytes: 1024 * 1024,
        fileExtension: ".pdf",
      }),
    ]);

    mounted = mountPage();

    expect(mounted.container.textContent).toContain("PDF");
    expect(mounted.container.querySelector("[data-file-preview-image]")).toBeNull();
  });

  it("does not expose uploader UUIDs or HS-prefixed deal numbers", () => {
    mocks.useDealsMock.mockReturnValue({
      deals: [
        {
          id: "deal-1",
          dealNumber: "HS-324283495135",
          projectNumber: "DFW-1-12826-aa",
          name: "Dallas ISD Roof Replacement",
          propertyAddress: "100 Main St",
          propertyCity: "Dallas",
          propertyState: "TX",
          projectTypeId: "reroof",
        },
      ],
    });
    setupFiles([
      makeFile({
        displayName: "HS-324283495135 Photo 2026-05-10 001 dad87234",
        uploadedBy: "c90ed33e-041b-4ddb-8cb6-ea28eb67679f",
      }),
    ]);

    mounted = mountPage();

    expect(mounted.container.textContent).toContain("Imported deal Photo 2026-05-10 001 dad87234");
    expect(mounted.container.textContent).toContain("Unknown user");
    expect(mounted.container.textContent).toContain("DFW-1-12826-aa");
    expect(mounted.container.textContent).not.toContain("c90ed33e-041b-4ddb-8cb6-ea28eb67679f");
    expect(mounted.container.textContent).not.toContain("HS-324283495135");
  });

  it("file-type filter narrows the list", () => {
    mounted = mountPage();

    act(() => {
      mounted?.container.querySelector<HTMLButtonElement>('[data-type-filter="contract"]')?.click();
    });

    expect(mocks.useFilesMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ category: "contract" }),
      expect.objectContaining({ enabled: true })
    );
  });

  it("renders every canonical file category as a type filter", () => {
    mounted = mountPage();

    for (const category of [
      "photo",
      "contract",
      "rfp",
      "estimate",
      "change_order",
      "proposal",
      "permit",
      "inspection",
      "correspondence",
      "insurance",
      "warranty",
      "closeout",
      "other",
    ]) {
      expect(mounted.container.querySelector(`[data-type-filter="${category}"]`)).not.toBeNull();
    }
  });

  it("all types chip resets the tab state to all", () => {
    mounted = mountPage();

    act(() => {
      mounted?.container.querySelector<HTMLButtonElement>('[data-filter-tab="photos"]')?.click();
    });
    act(() => {
      mounted?.container.querySelector<HTMLButtonElement>('[data-type-filter="all"]')?.click();
    });

    expect(mocks.useFilesMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ fileKind: undefined, category: undefined }),
      expect.objectContaining({ enabled: true })
    );
  });

  it("server-filters documents instead of slicing documents client-side", () => {
    mounted = mountPage();

    act(() => {
      mounted?.container.querySelector<HTMLButtonElement>('[data-filter-tab="documents"]')?.click();
    });

    expect(mocks.useFilesMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ fileKind: "documents", category: undefined }),
      expect.objectContaining({ enabled: true })
    );
  });

  it("server-filters linked type including procore and change order files", () => {
    setupFiles([
      makeFile({
        id: "procore-file",
        category: "other",
        displayName: "Procore synced spec",
        mimeType: "application/pdf",
        fileExtension: ".pdf",
        dealId: null,
        procoreProjectId: 12345,
      }),
    ]);
    mounted = mountPage();

    expect(mounted.container.textContent).toContain("Procore project");
    act(() => {
      mounted?.container.querySelector<HTMLButtonElement>('[data-linked-filter="procore"]')?.click();
    });

    expect(mocks.useFilesMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ linkedType: "procore" }),
      expect.objectContaining({ enabled: true })
    );

    act(() => {
      mounted?.container.querySelector<HTMLButtonElement>('[data-linked-filter="change_order"]')?.click();
    });

    expect(mocks.useFilesMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ linkedType: "change_order" }),
      expect.objectContaining({ enabled: true })
    );
  });

  it("keeps mixed-association Procore and change-order files visible after linked filters", () => {
    setupFiles([
      makeFile({
        id: "mixed-procore-file",
        category: "other",
        displayName: "Mixed procore spec",
        mimeType: "application/pdf",
        fileExtension: ".pdf",
        dealId: "deal-1",
        procoreProjectId: 12345,
      }),
      makeFile({
        id: "mixed-change-order-file",
        category: "change_order",
        displayName: "Mixed change order",
        mimeType: "application/pdf",
        fileExtension: ".pdf",
        dealId: "deal-1",
        changeOrderId: "co-77",
      }),
    ]);
    mounted = mountPage();

    act(() => {
      mounted?.container.querySelector<HTMLButtonElement>('[data-linked-filter="procore"]')?.click();
    });
    expect(mounted.container.textContent).toContain("Mixed procore spec");

    act(() => {
      mounted?.container.querySelector<HTMLButtonElement>('[data-linked-filter="change_order"]')?.click();
    });
    expect(mounted.container.textContent).toContain("Mixed change order");
  });

  it("uses stats hook for KPI totals independent of filtered files", () => {
    setupFiles([makeFile()]);

    mounted = mountPage();

    expect(mounted.container.textContent).toContain("27 files");
    expect(mounted.container.textContent).toContain("10.0 MB");
    expect(mounted.container.textContent).toContain("9");
    expect(mocks.useFileStatsMock).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
  });

  it("sort button cycles the API sort field", () => {
    mounted = mountPage();

    act(() => {
      mounted?.container.querySelector<HTMLButtonElement>("[data-sort-button]")?.click();
    });

    expect(mocks.useFilesMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ sortBy: "display_name" }),
      expect.objectContaining({ enabled: true })
    );
  });

  it("photo card delete action uses the existing delete flow", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    mocks.deleteFileRecordMock.mockResolvedValueOnce(undefined);
    const refetch = vi.fn();
    const refetchStats = vi.fn();
    mocks.useFilesMock.mockReturnValue({
      files: [makeFile()],
      pagination: { page: 1, limit: 200, total: 1, totalPages: 1 },
      loading: false,
      error: null,
      refetch,
    });
    mocks.useFileStatsMock.mockReturnValue({
      stats: {
        totalFiles: 1,
        totalPhotos: 1,
        totalDocuments: 0,
        totalBytes: 2400 * 1024,
        recentUploads: 1,
        dealsWithFiles: 1,
      },
      loading: false,
      error: null,
      refetch: refetchStats,
    });
    mounted = mountPage();

    await act(async () => {
      mounted?.container.querySelector<HTMLButtonElement>('button[aria-label="Delete Roof photo.jpg"]')?.click();
    });

    expect(confirmSpy).toHaveBeenCalledWith("Delete this file?");
    expect(mocks.deleteFileRecordMock).toHaveBeenCalledWith("file-1");
    expect(refetch).toHaveBeenCalled();
    expect(refetchStats).toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("upload completion refreshes both files and office-wide stats", () => {
    const refetch = vi.fn();
    const refetchStats = vi.fn();
    mocks.useFilesMock.mockReturnValue({
      files: [makeFile()],
      pagination: { page: 1, limit: 200, total: 1, totalPages: 1 },
      loading: false,
      error: null,
      refetch,
    });
    mocks.useFileStatsMock.mockReturnValue({
      stats: {
        totalFiles: 1,
        totalPhotos: 1,
        totalDocuments: 0,
        totalBytes: 2400 * 1024,
        recentUploads: 1,
        dealsWithFiles: 1,
      },
      loading: false,
      error: null,
      refetch: refetchStats,
    });
    mounted = mountPage();

    act(() => {
      Array.from(mounted!.container.querySelectorAll("button"))
        .find((button) => button.textContent?.includes("Upload"))!
        .click();
    });
    act(() => {
      const calls = mocks.fileUploadZoneMock.mock.calls;
      const props = calls[calls.length - 1]?.[0] as { onUploadComplete: () => void };
      props.onUploadComplete();
    });

    expect(refetch).toHaveBeenCalled();
    expect(refetchStats).toHaveBeenCalled();
  });

  it("view toggle buttons expose pressed state", () => {
    mounted = mountPage();

    const gridButton = mounted.container.querySelector<HTMLButtonElement>('button[aria-label="Grid view"]');
    const listButton = mounted.container.querySelector<HTMLButtonElement>('button[aria-label="List view"]');

    expect(gridButton?.getAttribute("aria-pressed")).toBe("true");
    expect(listButton?.getAttribute("aria-pressed")).toBe("false");
  });
});
